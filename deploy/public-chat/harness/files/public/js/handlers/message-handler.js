function apiMessages(messages) {
  return ChartPrompts.messages(messages);
}
async function sendMessage() {
  const chat = AppState.currentChat;
  if (
    !chat ||
    !AppState.historyReady ||
    AppState.operations.has(chat.id) ||
    AppState.fileLoading ||
    document.querySelector(".message-editor")
  )
    return;
  const input = document.getElementById("user-input");
  const draft = input.value;
  const file = AppState.file;
  const text = input.value.trim() || (file ? "请帮我分析这个文件的内容" : "");
  if (!text) return;
  if (await GenerationRecovery.beforeSend(chat)) return;
  if (AppState.operations.has(chat.id) || AppState.chats.get(chat.id) !== chat) return;
  if (AppState.currentChatId === chat.id && (input.value !== draft || AppState.file !== file)) return;
  chat.messages.push(AppState.newMessage("user", text, file));
  if (input.value === draft) {
    input.value = "";
    input.dispatchEvent(new Event("input"));
  }
  if (AppState.file === file) {
    AppState.file = null;
    document.getElementById("preview-btn").style.display = "none";
  }
  const assistant = AppState.newMessage("assistant", "");
  chat.messages.push(assistant);
  await generateReply(chat, assistant);
}
async function generateReply(chat, assistant, context, { resume = false } = {}) {
  if (AppState.operations.has(chat.id)) return;
  const operation = {
    controller: new AbortController(),
    messageId: assistant.id,
    contextStats: Composer.contextUsage(chat).stats,
  };
  AppState.operations.set(chat.id, operation);
  // A prepared generation has never been posted. It can rebuild the same input
  // after a tab closes during compaction. Once dispatched, only resume the SSE.
  const prepared = resume && assistant.generation?.phase === "prepared";
  assistant.generation = resume ? assistant.generation : { id: crypto.randomUUID(), pending: true, phase: "prepared" };
  const resetReplay = () => {
    assistant.content = "";
    assistant.chartFailures = [];
    assistant.browserSteps = [];
    assistant.browserTurns = [];
    if (!resume) delete assistant.taskList;
    delete assistant.browserTurnId;
    delete assistant.browserFinal;
    delete assistant.statistics;
    BrowserView.processing(chat, assistant, { type: "start" });
    if (AppState.currentChatId === chat.id) UI.renderChat();
  };
  assistant.status = "streaming";
  assistant.error = "";
  if (!resume) {
    assistant.model = Composer.model?.id;
    assistant.reasoningEffort = Composer.effort(chat);
    resetReplay();
  } else BrowserView.processing(chat, assistant, { type: "connection", state: "reconnecting" });
  let timer = null;
  let firstDelta = true;
  UI.renderChat({ bottom: true });
  try {
    // Commit the generation identity before POST. Reload can then GET the same
    // event stream from zero and rebuild its UI without executing tools again.
    await historyManager.save(chat);
    const history = chat.messages.slice(0, chat.messages.indexOf(assistant));
    if (!resume || prepared) {
      operation.controller.signal.throwIfAborted();
      context = prepared ? apiMessages(history) : context ?? apiMessages(history);
      if (prepared && assistant.generation.stopRequested) throw new DOMException("回答已停止", "AbortError");
      assistant.generation.phase = "dispatched";
      await historyManager.save(chat);
    }
    assistant.content = await ApiClient.generate(context, {
      generationId: assistant.generation.id,
      resume: resume && !prepared,
      persistent: true,
      stopRequested: assistant.generation.stopRequested === true,
      onReplayStart: resetReplay,
      onCancellation: confirmed => { operation.cancelConfirmed = confirmed; },
      signal: operation.controller.signal,
      reasoningEffort: assistant.reasoningEffort,
      browserContext: { conversationId: chat.id, messageId: assistant.id,
        taskList: TaskState.read(history).items,
        previousRuns: history
          .filter(m => m.role === "assistant" && ["error", "aborted", "reconnecting"].includes(m.status) && m.generation?.id)
          .slice(-16).map(m => m.generation.id) },
      onBrowser: (event) => BrowserView.event(chat, assistant, event),
      onProcessing: (event) => BrowserView.processing(chat, assistant, event),
      onStatistics: (statistics) => {
        assistant.statistics = statistics;
        if (statistics.total !== undefined) operation.contextStats = statistics;
        if (AppState.currentChatId === chat.id) Composer.queueUpdate();
        MessageActions.update(chat.id, assistant);
      },
      onDelta: (content) => {
        assistant.content = content;
        if (firstDelta) {
          firstDelta = false;
          UI.updateStream(chat.id, assistant);
          return;
        }
        if (timer === null)
          timer = setTimeout(() => {
            timer = null;
            UI.updateStream(chat.id, assistant);
          }, 60);
      },
    });
    // The server has sent [DONE]. A Stop during rendering or chart repair
    // cannot leave this generation pending on the server.
    operation.cancelConfirmed = true;
    clearTimeout(timer);
    timer = null;
    await UI.updateStream(chat.id, assistant);
    await ChartRecovery.run(chat, assistant, operation);
    operation.controller.signal.throwIfAborted();
    assistant.status = "complete";
    assistant.generation.pending = false;
  } catch (error) {
    const uncertainStop = error.name === "AbortError" && !operation.cancelConfirmed && assistant.generation.phase !== "prepared";
    const stopped = error.name === "AbortError" ||
      (operation.cancelConfirmed && assistant.generation.stopRequested && error.message === "回答已停止");
    assistant.generation.pending = uncertainStop;
    if (uncertainStop) assistant.generation.stopRequested = true;
    assistant.status = uncertainStop ? "reconnecting" : stopped ? "aborted" : "error";
    assistant.error =
      uncertainStop ? "停止请求尚未确认，恢复连接后将继续请求停止原任务" :
      stopped ? "回答已停止" : error.message;
    if (error.status === 401) showToast("登录已过期，请重新登录", "error");
  } finally {
    clearTimeout(timer);
    BrowserView.finishProcessing(assistant);
    for (const step of assistant.browserSteps || []) {
      if (step.status === "running") {
        step.status = assistant.status === "aborted" ? "aborted" : "error";
        step.error = assistant.error || "浏览器操作未完成";
      }
    }
    AppState.operations.delete(chat.id);
    await historyManager.persist(chat);
    if (AppState.currentChatId === chat.id)
      await UI.finishReply(chat, assistant);
    await updateFreeQuota();
  }
}
function stopGeneration() {
  const chatId = AppState.currentChatId;
  const operation = AppState.operations.get(chatId);
  const chat = AppState.chats.get(chatId);
  const pending = chat?.messages.findLast(message => message.generation?.pending);
  if (pending) {
    pending.generation.stopRequested = true;
    void historyManager.persist(chat);
  }
  if (!operation) { if (pending) void generateReply(chat, pending, [], { resume: true }); return; }
  // Closing the generation stream also happens on refresh. Explicitly signal
  // Stop so only this action closes the browser task owned by this message.
  void ApiClient.request(
    "/api/browser/stop?conversationId=" + encodeURIComponent(chatId),
    {
      body: { messageId: operation.messageId },
      signal: AbortSignal.timeout(7000),
    },
  ).catch((error) => {
    if (
      BrowserView.current?.conversationId === chatId &&
      ![403, 409].includes(error.status)
    )
      showToast("生成已停止，浏览器任务结束失败，请稍后重试", "error");
  });
  operation.controller.abort();
}
async function regenerateMessage(chatId, messageId) {
  const targetChat = AppState.chats.get(chatId);
  if (targetChat && await GenerationRecovery.beforeSend(targetChat)) return;
  const state = MessageActions.current(chatId, messageId);
  if (!state || state.index < 1 || state.message.role !== "assistant") return;
  const { chat, index } = state;
  const assistant = MessageActions.branch(chat, index);
  assistant.content = "";
  delete assistant.edited;
  await generateReply(chat, assistant);
}

const GenerationRecovery = {
  syncing: null,
  preparing: new Set(),
  pending(chat) { return chat?.messages.findLast(message => message.generation?.pending); },
  async tasks() {
    try {
      const data = await (await ApiClient.request('/api/chat/tasks', { signal: AbortSignal.timeout(7000) })).json();
      this.maxConcurrent = data.maxConcurrent;
      return data.tasks || [];
    }
    catch (error) { if (error.status === 404) return []; throw error; }
  },
  apply(tasks) {
    for (const task of [...tasks].sort((a, b) => b.startedAt - a.startedAt)) {
      const chat = AppState.chats.get(task.conversationId);
      const message = chat?.messages.find(item => item.id === task.messageId && item.role === 'assistant');
      if (!message || AppState.operations.has(chat.id)) continue;
      if (message.generation && (message.generation.id !== task.generationId || !message.generation.pending)) continue;
      if (!message.generation && message.status === 'complete') continue;
      message.generation ||= { id: task.generationId, pending: true };
    }
    for (const chat of AppState.chats.values()) {
      const message = this.pending(chat);
      if (message && !AppState.operations.has(chat.id)) void generateReply(chat, message, [], { resume: true });
    }
  },
  async sync() {
    if (!AppState.historyReady) return;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try { this.apply(await this.tasks()); }
      catch { this.apply([]); } // Saved IDs can reconnect even if discovery is temporarily unavailable.
    })();
    try { await this.syncing; } finally { this.syncing = null; }
  },
  async beforeSend(chat) {
    if (this.preparing.has(chat.id)) return true;
    if (AppState.operations.has(chat.id) || this.pending(chat)) { void this.sync(); return true; }
    this.preparing.add(chat.id);
    UI.updateControls();
    try {
      const tasks = await this.tasks();
      this.apply(tasks);
      if (AppState.operations.has(chat.id) || this.pending(chat) ||
          tasks.some(task => task.conversationId === chat.id && task.state === 'running')) {
        showToast('正在恢复这个对话的原任务，输入内容已保留'); return true;
      }
      if (Number.isInteger(this.maxConcurrent) && tasks.filter(task => task.state === 'running').length >= this.maxConcurrent) {
        showToast('已有后台任务占满生成名额，请在历史会话中查看进度；本次输入已保留'); return true;
      }
      return false;
    } catch {
      showToast('连接尚未恢复，输入内容已保留，尚未发起新任务', 'error'); return true;
    } finally {
      this.preparing.delete(chat.id);
      UI.updateControls();
    }
  },
  start() {
    void this.sync();
    const wake = () => { if (!document.hidden) void this.sync(); };
    addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    this.timer = setInterval(() => {
      if (!document.hidden && [...AppState.chats.values()].some(chat => this.pending(chat) && !AppState.operations.has(chat.id)))
        void this.sync();
    }, 15000);
  }
};
