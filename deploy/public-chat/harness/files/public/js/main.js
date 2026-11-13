let historyManager;
const ModelHealth = {
  previous: null,
  busy: false,
  init() {
    this.notice = document.createElement('p');
    this.notice.className = 'model-health-notice';
    this.notice.hidden = true;
    this.notice.setAttribute('role', 'status');
    this.notice.setAttribute('aria-live', 'polite');
    document.querySelector('.input-area').prepend(this.notice);
    const poll = async () => {
      if (!document.hidden) await this.check();
      this.timer = setTimeout(poll, 15000);
    };
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.check();
    });
    poll();
  },
  async check() {
    if (this.busy) return;
    this.busy = true;
    try {
      const response = await ApiClient.request('/api/chat/status', { signal: AbortSignal.timeout(10000) });
      const state = await response.json();
      if (!['online', 'starting', 'offline'].includes(state.status)) return;
      Composer.serviceStatus = state;
      if (Composer.panelKind === 'model') {
        Composer.renderPanel();
        Composer.position();
      }
      this.notice.hidden = state.status === 'online';
      this.notice.textContent = state.message || '模型状态发生变化，请稍后重试。';
      if (state.status === 'offline' && state.lastExit?.detectedAt) {
        const date = new Date(state.lastExit.detectedAt);
        if (Number.isFinite(date.getTime())) this.notice.textContent += ' 检测时间：' + date.toLocaleString();
      }
      if (state.status === 'offline' && this.previous && this.previous !== 'offline')
        showToast(state.message, 'error');
      if (state.status === 'online' && this.previous === 'offline')
        showToast('模型服务已恢复');
      this.previous = state.status;
    } catch {
      // A failed browser request is not evidence that the model process stopped.
    } finally {
      this.busy = false;
    }
  }
};
async function updateFreeQuota() {
  try {
    const response = await ApiClient.request("/api/user/profile");
    const user = await response.json();
    AppState.user = user;
    const el = document.getElementById("free-quota");
    el.textContent =
      user.freeMessages > 0
        ? "免费额度：" + user.freeMessages + " 次"
        : user.hasApiKey
          ? "使用个人密钥"
          : "额度已用完";
    el.className =
      "free-quota" +
      (user.freeMessages <= 0 && !user.hasApiKey ? " empty" : "");
  } catch (error) {
    if (!AppState.user) throw error;
  }
}
async function restoreChatHistory() {
  const newChat = document.querySelector(".new-chat-btn");
  const clearHistory = document.querySelector(".danger-btn");
  const list = document.querySelector(".chat-list");
  list.textContent = "正在加载对话…";
  AppState.historyReady = false;
  newChat.disabled = clearHistory.disabled = true;
  Composer.update();
  let restored;
  try {
    restored = await historyManager.open();
  } catch (error) {
    const notice = document.createElement("p");
    notice.className = "message-status";
    notice.textContent = "暂时无法读取此浏览器的历史记录。";
    list.replaceChildren(
      notice,
      UI.button("重新加载", restoreChatHistory, "text-button"),
    );
    if (!document.getElementById("history-panel").classList.contains("active"))
      historyManager.togglePanel();
    console.error("历史记录读取失败", error);
    return;
  }
  AppState.historyReady = true;
  window.historyManager = historyManager;
  newChat.disabled = clearHistory.disabled = false;
  UI.renderChat();
  if (restored.unavailable)
    showToast(
      restored.skippedCurrent
        ? "上次对话格式异常，已打开新对话。原始记录保留在历史面板中。"
        : "部分历史记录格式异常，原始内容仍保留在历史面板中。",
      "error",
    );
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await updateFreeQuota();
    historyManager = new HistoryManager(AppState.user.id);
    document.getElementById("send-button").onclick = sendMessage;
    document.getElementById("stop-button").onclick = stopGeneration;
    document.getElementById("user-input").addEventListener("keydown", (e) => {
      if (Composer.shouldSubmit(e, e.currentTarget)) {
        e.preventDefault();
        sendMessage();
      }
    });
    document.getElementById("history-btn").onclick = () =>
      historyManager.togglePanel();
    document.getElementById("history-overlay").onclick = () =>
      historyManager.closePanel();
    const newChat = document.querySelector(".new-chat-btn");
    newChat.disabled = true;
    newChat.onclick = () => {
      historyManager.createNewChat();
      historyManager.closePanel();
    };
    document.querySelector(".history-close").onclick = () =>
      historyManager.closePanel();
    const clearHistory = document.querySelector(".danger-btn");
    clearHistory.disabled = true;
    clearHistory.onclick = () =>
      historyManager
        .clearHistory()
        .catch(() => showToast("删除失败，请重试", "error"));
    if (localStorage.getItem("chat_history"))
      document
        .querySelector(".history-panel")
        .append(
          UI.button(
            "导入此浏览器旧版记录",
            () =>
              historyManager
                .importLegacy()
                .catch((e) => showToast(e.message, "error")),
            "legacy-import",
          ),
        );
    initFileHandler();
    initChatLayout();
    Composer.init();
    TaskView.init();
    ModelHealth.init();
    Artifacts.initActionVisibility();
    const closeMenus = () => Artifacts.dismissMovedMenus();
    document.addEventListener("scroll", closeMenus, true);
    window.addEventListener("resize", closeMenus);
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        !document.getElementById("task-panel").open &&
        !document.querySelector(":popover-open") &&
        !document.getElementById("composer-panel").open
      ) {
        if (document.getElementById("mermaid-overlay").open)
          closeMermaidOverlay();
        else historyManager.closePanel();
      }
    });
    document
      .getElementById("mermaid-overlay")
      .addEventListener("cancel", (e) => {
        e.preventDefault();
        closeMermaidOverlay();
      });
    window.addEventListener("storage", (e) => {
      if (e.key === "token") {
        for (const op of AppState.operations.values()) op.controller.abort();
        location.href = "login.html";
      }
    });
    // Navigation/reload only detaches the viewer. Explicit Stop owns cancellation;
    // pending generation IDs are already committed before starting the request.
    // Model discovery and shell interactions are independent of history restoration.
    // Only sending and history mutations wait for the persistence boundary.
    await restoreChatHistory();
    GenerationRecovery.start();
  } catch (error) {
    if (error.status === 401) location.href = "login.html";
    else {
      showToast("初始化失败：" + error.message, "error");
      console.error(error);
    }
  }
});
