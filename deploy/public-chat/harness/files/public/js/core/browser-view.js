// Native-JS adapter for browser/web/panel.js: live frames follow the latest tool,
// independently of each reasoning/tool disclosure.
const BrowserView = {
  current: null,
  chatId: null,
  revision: 0,
  expanded: new Map(),
  blockExpanded: new Map(),
  updates: new Map(),
  expansion(key, active) {
    let state = this.expanded.get(key);
    // Open at the start of a phase, close at its end. Manual toggles remain
    // effective between transitions, including while new tokens arrive.
    if (!state || state.active !== active) {
      state = { active, open: active };
      this.expanded.set(key, state);
    }
    return state.open;
  },
  turn(message, id = message.browserTurnId ?? 0) {
    message.browserTurns ||= [];
    let turn = message.browserTurns.find((item) => item.id === id);
    if (!turn && message.browserTurns.length < BrowserProtocol.limits.maxActions + 1) {
      turn = {
        id,
        status: "streaming",
        phase: "waiting",
        content: "",
        reasoning: "",
      };
      message.browserTurns.push(turn);
    }
    return turn;
  },
  refresh(chat, message) {
    if (AppState.currentChatId !== chat.id) return;
    const body = [...document.querySelectorAll(".message-wrapper")]
      .find((node) => node.dataset.messageId === message.id)
      ?.querySelector(".ai-message");
    if (body) this.renderSteps(chat, message, body);
  },
  processing(chat, message, event) {
    if (event.type === "connection") {
      message.connectionState = event.state;
      this.refresh(chat, message);
      return;
    }
    const turn = this.turn(message);
    if (!turn) return;
    if (event.type === "statistics") {
      const { aggregate, ...statistics } = event.statistics;
      turn.statistics = statistics;
      if (
        event.prefill &&
        !["reasoning", "generating", "tool-call"].includes(turn.phase)
      )
        turn.phase = "prefill";
    }
    if (event.type === "reasoning") {
      turn.reasoning += event.text;
      turn.phase = "reasoning";
    }
    if (event.type === "content") turn.phase = "generating";
    if (event.type === "tool-call") {
      turn.phase = "tool-call";
      turn.toolName = event.name;
    }
    // Progress samples already arrive sparsely from the engine. Paint each one
    // immediately instead of batching it with the next text/reasoning update.
    if (event.type === "statistics" && event.prefill) {
      clearTimeout(this.updates.get(message.id));
      this.updates.delete(message.id);
      this.refresh(chat, message);
      return;
    }
    if (!this.updates.has(message.id))
      this.updates.set(
        message.id,
        setTimeout(() => {
          this.updates.delete(message.id);
          this.refresh(chat, message);
        }, 60),
      );
  },
  finishProcessing(message) {
    delete message.connectionState;
    clearTimeout(this.updates.get(message.id));
    this.updates.delete(message.id);
    for (const turn of message.browserTurns || [])
      if (turn.status === "streaming")
        turn.status = message.status === "complete" ? "final" : message.status;
  },
  renderProcessing(message, body) {
    // ChatMessageAssistant.svelte showProcessingInfoTop / showProcessingInfoBottom.
    // A progress indicator is independent of the collapsible agentic content.
    const active = (message.browserTurns || []).findLast(
      (turn) => turn.status === "streaming",
    );
    const running = message.status === "streaming";
    const progress =
      active?.phase === "prefill"
        ? LlamaComposer.prefill(active.statistics)
        : null;
    const state = LlamaProcessing.create({
      status: active?.phase === "waiting" ? "preparing" : "generating",
    });
    const text = running
      ? message.connectionState === "reconnecting"
        ? "连接已断开，正在重连…"
        : (progress?.text ?? state.getProcessingMessage())
      : "";
    let node = body.querySelector(":scope > .generation-processing");
    if (!text) {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement("div");
      node.className = "generation-processing";
      node.setAttribute("role", "status");
      const label = document.createElement("span");
      label.className = "llama-shimmer";
      node.append(label);
    }
    node.firstElementChild.textContent = text;
    const hasNoContent = !message.content?.trim();
    const isAgentic =
      !!message.browserSteps?.length ||
      (message.browserTurns || []).some((turn) => turn.toolName);
    const top = hasNoContent && !isAgentic;
    node.dataset.position = top ? "top" : "bottom";
    if (top) body.prepend(node);
    else body.append(node);
  },
  renderReasoning(chat, message, body, turn) {
    const pending =
      message.status === "streaming" && turn.phase === "reasoning";
    const key = message.id + ":reasoning:" + turn.id;
    let host = body.querySelector(".browser-steps");
    if (host && !host.dataset.reasoningOnly) {
      host.remove();
      host = null;
    }
    if (!host) {
      host = document.createElement("div");
      host.className = "browser-steps";
      host.dataset.reasoningOnly = "true";
      const details = document.createElement("details");
      details.className = "browser-process llama-process-block";
      details.open = this.expansion(key, pending);
      const summary = document.createElement("summary");
      const title = document.createElement("span");
      title.className = "llama-block-title";
      summary.append(LlamaIcons.create("lightbulb"), title);
      const content = document.createElement("div");
      content.className = "browser-process-history llama-block-body";
      details.append(summary, content);
      details.addEventListener("toggle", () => {
        if (!details.isConnected) return;
        this.expanded.get(key).open = details.open;
        this.renderReasoning(chat, message, body, turn);
      });
      host.append(details);
      body.prepend(host);
    }
    const details = host.firstElementChild;
    details.open = this.expansion(key, pending);
    const title = details.querySelector(".llama-block-title");
    title.textContent =
      message.status === "aborted"
        ? "推理 · 已取消"
        : message.status === "error"
          ? "推理 · 错误"
          : "推理中…";
    title.classList.toggle("llama-shimmer", pending);
    const history = details.querySelector(".browser-process-history");
    if (details.open) {
      let paragraph = history.firstElementChild;
      if (!paragraph) {
        paragraph = document.createElement("div");
        paragraph.className = "browser-process-text reasoning-content";
        history.append(paragraph);
      }
      const atBottom =
        paragraph.scrollHeight - paragraph.clientHeight - paragraph.scrollTop <=
        64;
      if (paragraph.textContent !== turn.reasoning)
        paragraph.textContent = turn.reasoning;
      paragraph.classList.toggle("is-streaming", pending);
      if (pending && atBottom) paragraph.scrollTop = paragraph.scrollHeight;
    } else history.replaceChildren();
    this.renderProcessing(message, body);
  },
  // DOM translation of CollapsibleContentBlock.svelte; dimensions live in browser.css.
  block(
    key,
    title,
    iconName,
    content,
    { pending = false, subtitle = "", autoCollapse = false } = {},
  ) {
    const block = document.createElement("details");
    block.className = "llama-process-block";
    block.open = autoCollapse
      ? this.expansion(key, pending)
      : (this.blockExpanded.get(key) ?? false);
    const summary = document.createElement("summary");
    const name = document.createElement("span");
    name.className = "llama-block-title" + (pending ? " llama-shimmer" : "");
    name.textContent = title;
    summary.append(LlamaIcons.create(iconName), name);
    if (subtitle) {
      const status = document.createElement("span");
      status.className = "llama-block-subtitle";
      status.textContent = subtitle;
      summary.append(status);
    }
    const body = document.createElement("div");
    body.className = "llama-block-body";
    body.append(content);
    block.append(summary, body);
    block.addEventListener("toggle", () => {
      if (!block.isConnected) return;
      if (autoCollapse) this.expanded.get(key).open = block.open;
      else this.blockExpanded.set(key, block.open);
    });
    return block;
  },
  stepNode(step, messageId) {
    const title = BrowserProtocol.title(step.name, step.input);
    const contents = document.createElement("div");
    contents.className = "browser-tool-contents";
    for (const [label, text] of [
      ["输入 · Input", step.input],
      [
        "输出 · Output",
        step.result ||
          (step.status === "running" ? "等待执行结果…" : step.error),
      ],
    ]) {
      if (!text) continue;
      const detail = document.createElement("div");
      detail.className = "browser-tool-detail";
      const heading = document.createElement("div");
      heading.className = "browser-process-label";
      heading.textContent = label;
      const value = document.createElement("pre");
      value.textContent = text;
      detail.append(heading, value);
      contents.append(detail);
    }
    const status =
      step.status === "running"
        ? "执行中"
        : step.status === "complete"
          ? "已完成"
          : step.status === "aborted"
            ? "已停止"
            : "失败";
    const metadata = [status];
    if (Number.isFinite(step.durationMs))
      metadata.push(MessageActions.time(step.durationMs));
    if (step.error) metadata.push(step.error);
    const detail = document.createElement("div");
    detail.className = "browser-process-label";
    if (step.error) detail.classList.add("browser-step-error");
    detail.textContent = metadata.join(" · ");
    contents.prepend(detail);
    const block = this.block(
      messageId + ":tool:" + step.id,
      title,
      "wrench",
      contents,
      { pending: step.status === "running" },
    );
    block.classList.add("browser-step");
    block.dataset.callId = step.id;
    block.dataset.toolName = step.name;
    block.dataset.state = step.status;
    const summary = block.querySelector("summary");
    summary.setAttribute("aria-label", title + "：" + status);
    summary.title = [step.name, ...metadata].join(" · ");
    if (step.error) summary.classList.add("browser-step-error");
    return block;
  },
  renderSteps(chat, message, body) {
    // A tool call can start after the last timings event; update the footer on
    // phase changes too, so the previous round's TPS cannot linger by a tool.
    MessageActions.update(chat.id, message);
    this.renderTasks(message.taskList, body);
    const steps = (message.browserSteps || []).filter((step) =>
      BrowserProtocol.displayTool(step.name),
    );
    const turns = message.browserTurns || [];
    const currentTurn = turns.find((turn) => turn.id === message.browserTurnId);
    const hasProcess =
      steps.length ||
      turns.some(
        (turn) =>
          turn.reasoning || turn.toolName || turn.status === "intermediate",
      );
    const content = body.querySelector(".content-div");
    // Render each arriving answer delta in the normal Markdown stream. Only
    // archive it into the tool timeline once this round actually calls a tool.
    // Waiting for browserFinal hid ordinary answers until the entire turn ended.
    if (content)
      content.hidden =
        message.browserFinal === false &&
        (currentTurn?.status === "intermediate" ||
          currentTurn?.phase === "tool-call");
    if (!hasProcess) {
      body.querySelector(".browser-steps")?.remove();
      this.renderProcessing(message, body);
      return;
    }
    if (
      !steps.length &&
      turns.length === 1 &&
      !turns[0].toolName &&
      turns[0].status !== "intermediate"
    ) {
      this.renderReasoning(chat, message, body, turns[0]);
      return;
    }
    let host = body.querySelector(".browser-steps");
    if (host?.dataset.reasoningOnly) {
      host.remove();
      host = null;
    }
    if (!host) {
      host = document.createElement("div");
      host.className = "browser-steps";
      body.prepend(host);
    }
    let process = host.querySelector(".browser-process");
    if (!process) {
      process = document.createElement("div");
      process.className = "browser-process";
      const history = document.createElement("div");
      history.className = "browser-process-history";
      process.append(history);
      host.prepend(process);
    }
    this.renderProcessing(message, body);
    const sections = [];
    const allTurns = [...turns];
    const pending = allTurns.find(
      (turn) =>
        turn.id === message.browserTurnId && turn.status === "streaming",
    );
    if (pending) pending.content = message.content;
    if (
      message.browserTurnId !== undefined &&
      message.browserFinal === false &&
      !allTurns.some((turn) => turn.id === message.browserTurnId) &&
      message.content
    ) {
      allTurns.push({
        id: message.browserTurnId,
        content: message.content,
        status: "streaming",
      });
    }
    const addText = (section, label, text, turn) => {
      if (!text) return;
      const heading = document.createElement("div");
      heading.className = "browser-process-label";
      heading.textContent = label;
      const paragraph = document.createElement("div");
      paragraph.className = "browser-process-text";
      // Model text remains text; intermediate output cannot inject markup or scripts.
      paragraph.textContent = text;
      if (label === "推理") {
        const pending =
          turn.status === "streaming" && turn.phase === "reasoning";
        paragraph.classList.add("reasoning-content");
        if (pending) paragraph.classList.add("is-streaming");
        section.append(
          this.block(
            message.id + ":reasoning:" + turn.id,
            "推理中…",
            "lightbulb",
            paragraph,
            {
              pending,
              autoCollapse: true,
              subtitle:
                turn.status === "error"
                  ? "错误"
                  : turn.status === "aborted"
                    ? "已取消"
                    : "",
            },
          ),
        );
      } else section.append(paragraph);
    };
    const turnIds = [
      ...new Set([
        ...allTurns.map((turn) => turn.id),
        ...steps.map((step) => step.turn ?? -1),
      ]),
    ].sort((a, b) => a - b);
    for (const id of turnIds) {
      const turn = allTurns.find((item) => item.id === id);
      const section = document.createElement("section");
      section.className = "browser-process-turn";
      section.dataset.turnId = id;
      if (turn) {
        addText(section, "推理", turn.reasoning, turn);
        if (turn.status === "intermediate" || turn.phase === "tool-call")
          addText(section, "阶段回复", turn.content, turn);
        if (
          turn.phase === "tool-call" &&
          ["streaming", "aborted", "error"].includes(turn.status)
        ) {
          const pending = document.createElement("div");
          pending.className = "browser-process-text";
          pending.textContent =
            turn.status === "streaming" ? "正在接收参数…" : "参数接收未完成";
          section.append(
            this.block(
              message.id + ":pending:" + turn.id,
              BrowserProtocol.labels[turn.toolName] || "浏览器操作",
              "wrench",
              pending,
              {
                pending: turn.status === "streaming",
              },
            ),
          );
        }
      }
      for (const step of steps.filter((item) => (item.turn ?? -1) === id))
        section.append(this.stepNode(step, message.id));
      // Match llama UI's default showAgenticTurnStats=false. Message-level
      // reading/generation badges and the live Processing/ETA stay separate.
      if (section.childNodes.length) sections.push(section);
    }
    // Avoid replacing an expanded history on every token: keep its scroll position
    // and any text selection stable while the user reads an earlier round.
    const history = process.querySelector(".browser-process-history");
    for (const section of sections) {
      // The live card is inserted after rendering; exclude it from the markup
      // comparison so later tokens don't recreate an unchanged completed turn.
      section.processMarkup = section.innerHTML;
      const previous = [...history.children].find(
        (node) => node.dataset.turnId === section.dataset.turnId,
      );
      if (!previous) history.append(section);
      else if (previous.processMarkup !== section.processMarkup) {
        const priorReasoning = previous.querySelector(".reasoning-content");
        const scroll = priorReasoning?.scrollTop;
        // REASONING_SCROLL_AT_BOTTOM_THRESHOLD_PX in llama UI is 64.
        const atBottom =
          priorReasoning &&
          priorReasoning.scrollHeight - priorReasoning.clientHeight - scroll <=
            64;
        previous.replaceWith(section);
        const reasoning = section.querySelector(".reasoning-content");
        if (reasoning && scroll !== undefined)
          reasoning.scrollTop = atBottom ? reasoning.scrollHeight : scroll;
      }
    }
    this.place();
  },
  renderTasks(items, body) {
    let details = body.querySelector(":scope > .session-tasks");
    if (!items?.length) { details?.remove(); return; }
    if (details?.taskList === items) return;
    if (!details) {
      details = document.createElement("details");
      details.className = "session-tasks llama-process-block";
      body.prepend(details);
    }
    details.taskList = items;
    const summary = document.createElement("summary");
    summary.textContent = "待办 · 已完成 " + items.filter(item => item.status === "completed").length + "/" + items.length;
    const list = document.createElement("ul");
    const labels = { pending: "待处理", in_progress: "进行中", waiting: "待跟进", completed: "已完成" };
    for (const item of items) {
      const row = document.createElement("li");
      row.textContent = [labels[item.status], item.title, item.note].filter(Boolean).join(" · ");
      list.append(row);
    }
    details.replaceChildren(summary, list);
  },
  event(chat, message, event) {
    let changed = false;
    if (event.type === "task-list" && Array.isArray(event.items)) {
      message.taskList = event.items;
      if (AppState.currentChatId === chat.id) TaskView.refresh();
      changed = true;
    }
    if (event.type === "turn-start" && Number.isInteger(event.id)) {
      message.browserTurnId = event.id;
      message.browserFinal = false;
      this.turn(message, event.id);
      changed = true;
    }
    if (
      event.type === "thinking-delta" &&
      typeof event.text === "string" &&
      Number.isInteger(message.browserTurnId)
    ) {
      message.browserTurns ||= [];
      let turn = message.browserTurns.find(
        (item) => item.id === message.browserTurnId,
      );
      if (!turn && message.browserTurns.length < BrowserProtocol.limits.maxActions + 1) {
        turn = {
          id: message.browserTurnId,
          status: "streaming",
          content: "",
          reasoning: "",
        };
        message.browserTurns.push(turn);
      }
      if (turn) {
        this.processing(chat, message, { type: "reasoning", text: event.text });
      }
    }
    if (event.type === "tool-call") this.processing(chat, message, event);
    if (event.type === "turn-end" && Number.isInteger(event.id)) {
      message.browserTurns ||= [];
      const turn = {
        id: event.id,
        status: event.status,
        reasoning: typeof event.reasoning === "string" ? event.reasoning : "",
        content:
          event.status === "intermediate" && typeof event.content === "string"
            ? event.content
            : "",
      };
      const previous = message.browserTurns.find((item) => item.id === turn.id);
      if (previous) Object.assign(previous, turn);
      else if (message.browserTurns.length < BrowserProtocol.limits.maxActions + 1)
        message.browserTurns.push(turn);
      message.browserFinal = event.status === "final";
      if (message.browserFinal) message.content = event.content || "";
      changed = true;
    }
    if (
      event.type === "step" &&
      event.step &&
      BrowserProtocol.displayTool(event.step.name)
    ) {
      message.browserSteps ||= [];
      const previous = message.browserSteps.find(
        (step) => step.id === event.step.id,
      );
      if (previous) Object.assign(previous, event.step);
      // Keep receipts for calls rejected at the limit in the final tool batch too.
      else if (message.browserSteps.length < BrowserProtocol.limits.maxActions + BrowserProtocol.limits.maxToolCallsPerRound - 1)
        message.browserSteps.push(event.step);
      changed = true;
    }
    if (event.type === "tool-receipt" && event.receipt && Object.hasOwn(BrowserProtocol.labels, event.receipt.name)) {
      const receipt = event.receipt;
      message.browserSteps ||= [];
      let step = message.browserSteps.find(item => item.id === receipt.id);
      if (!step) {
        step = { id: receipt.id, name: receipt.name, turn: receipt.turn, label: BrowserProtocol.labels[receipt.name] };
        message.browserSteps.push(step);
      }
      step.receipt = receipt;
      if (!step.result) {
        step.status = receipt.state === "returned" ? "complete" : receipt.state === "unknown" ? "aborted" : "error";
        step.result = JSON.stringify(receipt);
        step.error = receipt.error || (receipt.state === "unknown" ? "操作结果待核实，请先检查已有结果" : "");
      }
      changed = true;
    }
    if (changed) {
      if (AppState.currentChatId === chat.id) {
        const body = [...document.querySelectorAll(".message-wrapper")]
          .find((node) => node.dataset.messageId === message.id)
          ?.querySelector(".ai-message");
        if (body) this.renderSteps(chat, message, body);
      }
      // The completed turn and generation finalizer persist the accumulated reasoning.
      // Avoid an IndexedDB transaction for every reasoning token.
      if (event.type !== "thinking-delta") void historyManager.persist(chat);
    }
    if (event.type === "connected" && AppState.currentChatId === chat.id) {
      this.revision++;
      this.start(chat.id, message.id, event.callId);
    }
    if (event.type === "ended" && this.current?.conversationId === chat.id) {
      this.revision++;
      this.stop();
    }
  },
  makeCard() {
    const card = document.createElement("section");
    card.className = "browser-live";
    card.setAttribute("aria-label", "浏览器实时画面");
    const image = document.createElement("img");
    image.alt = "AI 正在操作的 Chrome 实时页面";
    image.hidden = true;
    image.addEventListener("load", () => {
      const record = this.current;
      if (record?.image !== image || record.revealed || !card.isConnected)
        return;
      record.revealed = true;
      card.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
    const activity = document.createElement("span");
    activity.className = "browser-live-activity";
    activity.setAttribute("role", "status");
    activity.setAttribute("aria-live", "polite");
    const placeholder = document.createElement("div");
    placeholder.className = "browser-live-placeholder";
    placeholder.setAttribute("role", "status");
    placeholder.textContent = "正在连接浏览器画面…";
    card.append(activity, image, placeholder);
    return { card, image, placeholder, activity };
  },
  frame(record, data) {
    if (
      this.current !== record ||
      !["image/jpeg", "image/png"].includes(data.mime) ||
      typeof data.data !== "string" ||
      !data.data.length ||
      data.data.length > 8000000 ||
      !Number.isFinite(data.timestamp) ||
      (record.timestamp && data.timestamp <= record.timestamp) ||
      data.timestamp <
        Math.max(
          record.timestamp || 0,
          record.pendingFrame?.timestamp || 0,
          record.decodingTimestamp || 0,
        )
    )
      return;
    // Decode before replacing the visible image. Keep only the newest pending
    // frame, so a slow viewer doesn't build a queue or flash a broken image.
    record.pendingFrame = data;
    if (record.decoding) return;
    const next = record.pendingFrame;
    record.pendingFrame = null;
    const candidate = new Image();
    record.decoding = candidate;
    record.decodingTimestamp = next.timestamp;
    const finish = (valid) => {
      if (this.current !== record || record.decoding !== candidate) return;
      record.decoding = null;
      record.decodingTimestamp = 0;
      if (valid) {
        record.timestamp = next.timestamp;
        record.lastFrameAt = Date.now();
        record.retries = 0;
        record.image.src = candidate.src;
        record.image.hidden = false;
        record.placeholder.hidden = true;
        this.place();
      }
      const pending = record.pendingFrame;
      record.pendingFrame = null;
      if (pending) this.frame(record, pending);
      else if (!valid) record.controller?.abort();
    };
    candidate.onload = () => finish(candidate.naturalWidth > 0);
    candidate.onerror = () => finish(false);
    candidate.src = "data:" + next.mime + ";base64," + next.data;
  },
  place() {
    const record = this.current;
    if (!record) return;
    if (record.conversationId !== AppState.currentChatId) {
      record.card.remove();
      return;
    }
    const owner = [...document.querySelectorAll(".message-wrapper")].find(
      (node) => node.dataset.messageId === record.messageId,
    );
    const anchor = [
      ...(owner?.querySelectorAll(".browser-process-turn > .browser-step") ||
        []),
    ].at(-1);
    if (!anchor) {
      record.card.remove();
      return;
    }
    if (anchor.nextElementSibling !== record.card) anchor.after(record.card);
  },
  start(conversationId, messageId, callId) {
    if (conversationId !== AppState.currentChatId) return;
    if (this.current?.conversationId === conversationId) {
      Object.assign(this.current, { messageId, callId });
      this.place();
      return;
    }
    this.stop();
    const record = {
      conversationId,
      messageId,
      callId,
      retries: 0,
      ...this.makeCard(),
    };
    this.current = record;
    this.place();
    void this.stream(record);
  },
  stop() {
    const record = this.current;
    this.current = null;
    if (!record) return;
    clearTimeout(record.retry);
    record.controller?.abort();
    if (record.decoding) {
      record.decoding.onload = record.decoding.onerror = null;
      record.decoding.removeAttribute("src");
    }
    record.pendingFrame = record.decoding = null;
    record.image.removeAttribute("src");
    record.card.remove();
  },
  async restore() {
    const chatId = AppState.currentChatId;
    if (this.chatId !== chatId) {
      this.stop();
      this.chatId = chatId;
    }
    this.place();
    const revision = ++this.revision;
    if (!chatId) return;
    try {
      const response = await ApiClient.request(
        "/api/browser/status?conversationId=" + encodeURIComponent(chatId),
      );
      const status = await response.json();
      if (revision !== this.revision || AppState.currentChatId !== chatId)
        return;
      if (status.sharing) this.start(chatId, status.messageId, status.callId);
      else if (!AppState.operations.has(chatId)) this.stop();
    } catch {
      /* The normal chat remains usable while the optional bridge is offline. */
    }
  },
  async stream(record) {
    if (this.current !== record) return;
    clearTimeout(record.retry);
    record.controller?.abort();
    if (record.decoding) {
      record.decoding.onload = record.decoding.onerror = null;
      record.decoding.removeAttribute("src");
    }
    record.pendingFrame = record.decoding = null;
    record.decodingTimestamp = 0;
    const controller = new AbortController();
    record.controller = controller;
    const owns = () =>
      this.current === record && record.controller === controller;
    const connectedAt = Date.now();
    let lastReceived = connectedAt;
    const watchdog = setInterval(() => {
      const now = Date.now();
      // A healthy heartbeat isn't proof of a healthy picture. The bridge sends
      // fallback snapshots every 2s; recover an absent first frame after 8s,
      // or a frozen picture after 15s, even when heartbeat traffic continues.
      const frameWait = now - Math.max(connectedAt, record.lastFrameAt || 0);
      if (
        frameWait > (record.lastFrameAt ? 15000 : 8000) ||
        now - lastReceived > 25000
      )
        controller.abort();
    }, 1000);
    try {
      const response = await ApiClient.request(
        "/api/browser/events?conversationId=" +
          encodeURIComponent(record.conversationId),
        { signal: controller.signal },
      );
      const reader = response.body.getReader(),
        decoder = new TextDecoder(),
        parser = new SSEDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || !owns()) break;
          lastReceived = Date.now();
          for (const event of parser.feed(
            decoder.decode(value, { stream: true }),
          )) {
            let data;
            try {
              data = JSON.parse(event.data);
            } catch {
              continue;
            }
            if (event.event === "state" && !data.sharing) {
              this.stop();
              return;
            }
            if (event.event === "state" && data.sharing) {
              record.card.dataset.busy = String(!!data.action);
              record.activity.textContent =
                data.action?.label || "正在显示 Chrome 实时页面";
            }
            if (event.event === "notice") {
              record.activity.textContent = data.message || "";
            }
            if (event.event === "frame") this.frame(record, data);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      if (owns() && [401, 403].includes(error.status)) {
        this.stop();
        return;
      }
    } finally {
      clearInterval(watchdog);
      controller.abort();
    }
    if (owns()) {
      record.activity.textContent = "画面正在重连…";
      record.placeholder.textContent =
        record.retries >= 2
          ? "Chrome 尚未传回画面，正在重试连接…"
          : "画面正在重连…";
      record.placeholder.hidden = !!record.image.getAttribute("src");
      record.retry = setTimeout(
        () => {
          if (owns()) void this.stream(record);
        },
        Math.min(1000 * 2 ** record.retries++, 10000),
      );
    }
  },
};
addEventListener("online", () => {
  if (BrowserView.current) void BrowserView.stream(BrowserView.current);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && BrowserView.current)
    void BrowserView.stream(BrowserView.current);
});
