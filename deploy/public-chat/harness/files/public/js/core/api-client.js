class ApiError extends Error {
  constructor(message, status, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
class ApiClient {
  static streamIdleTimeoutMs = 45000;
  static reconnectWindowMs = 120000;
  static retryDelays = [1000, 2000, 4000, 8000, 15000, 15000, 15000];

  static retryDelay(ms, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        globalThis.removeEventListener?.("online", wake);
        globalThis.document?.removeEventListener("visibilitychange", wake);
        if (error) reject(error);
        else resolve();
      };
      const abort = () =>
        finish(signal.reason || new DOMException("回答已停止", "AbortError"));
      const wake = () => { if (!globalThis.document?.hidden) finish(); };
      const timer = setTimeout(() => finish(), ms);
      signal?.addEventListener("abort", abort, { once: true });
      globalThis.addEventListener?.("online", wake);
      globalThis.document?.addEventListener("visibilitychange", wake);
      if (signal?.aborted) abort();
    });
  }
  static async request(path, { body, signal, method } = {}) {
    const token = localStorage.getItem("token");
    if (!token) throw new ApiError("请先登录", 401);
    const response = await fetch(path, {
      method: method || (body ? "POST" : "GET"),
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
      }
      throw new ApiError(
        (typeof data.error === "string" ? data.error : data.error?.message) ||
          "请求失败",
        response.status,
        data,
      );
    }
    return response;
  }
  static async generate(
    messages,
    {
      signal,
      onDelta,
      onStatistics,
      onBrowser,
      onProcessing,
      browserContext,
      reasoningEffort = "default",
      generationId = crypto.randomUUID(),
      resume = false,
      persistent = false,
      stopRequested = false,
      onReplayStart,
      onCancellation,
    } = {},
  ) {
    let lastEventId = 0;
    let requests = resume ? 1 : 0;
    let replayStarted = false;
    let retries = 0;
    let failedSince = 0;
    let content = "";
    let complete = false;
    let statistics = {};
    let completedUsage = null;
    const consume = (events) => {
      for (const event of events) {
        const id = event.id === undefined ? null : Number(event.id);
        if (id !== null) {
          if (!/^\d+$/.test(event.id) || !Number.isSafeInteger(id) || id < 1)
            throw new ApiError("回复序号无效", 502, { terminal: true });
          if (id <= lastEventId) continue;
          if (id !== lastEventId + 1)
            throw new ApiError("回复续传数据不完整，请重试", 502, {
              terminal: true,
            });
        }
        if (event.data === "[DONE]") {
          complete = true;
          if (id !== null) lastEventId = id;
          return;
        }
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          throw new ApiError("回复数据损坏，请重试", 502, { terminal: true });
        }
        if (data.error || event.event === "error")
          throw new ApiError(data.error?.message || "生成失败", 502, {
            terminal: true,
          });
        if (data.browser) {
          // Each tool round has its own draft. Only the final answer enters the main reply.
          if (data.browser.type === "turn-start") {
            content = "";
            statistics = completedUsage ? { aggregate: completedUsage } : {};
            onStatistics?.(statistics);
            onDelta?.(content);
          }
          onBrowser?.(data.browser);
        }
        if (
          data.timings ||
          data.usage ||
          data.prompt_progress ||
          data.strata_timings ||
          data.agent_usage
        ) {
          statistics = LlamaComposer.statistics(data, statistics);
          if (data.agent_usage) completedUsage = statistics.aggregate;
          else if (completedUsage) {
            // ChatMessageAssistantStatistics uses liveLlm totals, including the current round.
            const aggregate = { ...completedUsage };
            for (const key of [
              "fresh",
              "cached",
              "prompt",
              "output",
              "promptMs",
              "generationMs",
            ])
              if (statistics[key] !== undefined)
                aggregate[key] = (completedUsage[key] || 0) + statistics[key];
            if (aggregate.generationMs > 0)
              aggregate.tokensPerSecond =
                (aggregate.output * 1000) / aggregate.generationMs;
            statistics.aggregate = aggregate;
          }
          onStatistics?.(statistics);
          onProcessing?.({
            type: "statistics",
            statistics,
            prefill: !!data.prompt_progress,
          });
        }
        const reasoning = data.choices?.[0]?.delta?.reasoning_content;
        if (typeof reasoning === "string" && reasoning)
          onProcessing?.({ type: "reasoning", text: reasoning });
        const delta = data.choices?.[0]?.delta?.content;
        if (typeof delta === "string") {
          content += delta;
          if (delta) onProcessing?.({ type: "content" });
          onDelta?.(content);
        }
        if (id !== null) lastEventId = id;
        retries = 0;
        failedSince = 0;
      }
    };
    const restoreTasks = (record) => {
      if (Array.isArray(record?.taskList)) onBrowser?.({ type: "task-list", items: record.taskList });
    };
    let cancellation;
    const cancel = () => {
      cancellation ||= this.request("/api/chat/cancel", {
        body: { generationId, conversationId: browserContext?.conversationId },
        signal: AbortSignal.timeout(7000),
      }).then(async response => {
        const result = await response.json().catch(() => ({}));
        restoreTasks(result);
        for (const row of result.receipts || []) {
          onBrowser?.({ type: "tool-receipt", receipt: row });
        }
        return true;
      }, () => false);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      // Stop may have fired while the page was saving the generation ID.
      // A fresh task has not been posted yet. A resumed task already exists.
      if (signal?.aborted) {
        if (resume) cancel();
        else onCancellation?.(true);
      }
      while (!complete) {
        signal?.throwIfAborted();
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal?.addEventListener("abort", abort, { once: true });
        let reader;
        let timer;
        let failure;
        let lastByteAt = Date.now();
        const wake = () => {
          if (!globalThis.document?.hidden && Date.now() - lastByteAt >= this.streamIdleTimeoutMs)
            controller.abort(new DOMException("恢复连接", "TimeoutError"));
        };
        globalThis.addEventListener?.("online", wake);
        globalThis.document?.addEventListener("visibilitychange", wake);
        const arm = () => {
          clearTimeout(timer);
          const remaining = failedSince && !persistent
            ? this.reconnectWindowMs - (Date.now() - failedSince)
            : Infinity;
          timer = setTimeout(
            () =>
              controller.abort(
                new DOMException("连接长时间没有响应", "TimeoutError"),
              ),
            Math.max(1, Math.min(this.streamIdleTimeoutMs, remaining)),
          );
        };
        try {
          arm();
          if (stopRequested) {
            const stopped = await this.request("/api/chat/cancel", { body: { generationId, conversationId: browserContext?.conversationId }, signal: controller.signal });
            const result = await stopped.json();
            restoreTasks(result);
            for (const row of result.receipts || []) onBrowser?.({ type: "tool-receipt", receipt: row });
            stopRequested = false;
            onCancellation?.(true);
          }
          const response =
            requests++ === 0
              ? await this.request("/api/chat/completions", {
                  body: {
                    messages,
                    stream: true,
                    reasoningEffort,
                    browserContext,
                    generationId,
                  },
                  signal: controller.signal,
                })
              : await this.request(
                  "/api/chat/stream?generationId=" +
                    encodeURIComponent(generationId) +
                    "&after=" +
                    lastEventId + (browserContext?.conversationId ? "&conversationId=" + encodeURIComponent(browserContext.conversationId) : ""),
                  { signal: controller.signal },
                );
          if (
            !response.headers.get("content-type")?.includes("text/event-stream")
          )
            throw new ApiError("响应格式错误", 502, { terminal: true });
          reader = response.body.getReader();
          // A failed transport may end mid-UTF-8 or mid-event. Resume from the
          // last fully applied event with a fresh decoder, not from partial bytes.
          const decoder = new TextDecoder();
          const parser = new SSEDecoder();
          let connected = false;
          while (!complete) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value?.length) continue;
            lastByteAt = Date.now();
            if (!connected) {
              connected = true;
              if (resume && !replayStarted) {
                replayStarted = true;
                onReplayStart?.();
              }
              // A heartbeat confirms transport recovery even while the model
              // is still preparing its next token. Do not keep the old network
              // failure deadline armed against this healthy connection.
              failedSince = 0;
              retries = 0;
              onProcessing?.({ type: "connection", state: "connected" });
            }
            arm();
            consume(parser.feed(decoder.decode(value, { stream: true })));
          }
          if (!complete) throw new ApiError("回复连接中断", 502);
        } catch (error) {
          signal?.throwIfAborted();
          if (error.status === 410) restoreTasks(error.details);
          if (
            error.details?.terminal ||
            (error.status && ![408, 502, 503, 504].includes(error.status))
          )
            throw error;
          failure = error;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          globalThis.removeEventListener?.("online", wake);
          globalThis.document?.removeEventListener("visibilitychange", wake);
          controller.abort();
          if (reader) {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        if (failure) {
          failedSince ||= Date.now();
          if (!persistent && (
            retries >= this.retryDelays.length ||
            Date.now() - failedSince >= this.reconnectWindowMs
          ))
            throw new ApiError(
              "连接暂未恢复，电脑端任务可能仍在运行，请检查已有结果后再试",
              503,
              { terminal: true },
            );
          onProcessing?.({ type: "connection", state: "reconnecting" });
          await this.retryDelay(this.retryDelays[Math.min(retries++, this.retryDelays.length - 1)], signal);
        }
      }
      if (!complete || !content)
        throw new ApiError("回复中断或没有内容，请重试", 502);
      return content;
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (cancellation) onCancellation?.(await cancellation);
    }
  }
  static async fixChart(type, code, error, signal) {
    const response = await this.request("/api/chat/completions", {
      signal,
      body: {
        stream: false,
        messages: ChartPrompts.repair(type, code, error),
      },
    });
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim())
      throw new ApiError("模型未返回修复源码", 502);
    const source = content.trim();
    const fenced =
      /^(`{3,}|~{3,})(?:mermaid|json|chart)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n\1$/.exec(
        source,
      );
    return fenced ? fenced[2].trim() : source;
  }
}
