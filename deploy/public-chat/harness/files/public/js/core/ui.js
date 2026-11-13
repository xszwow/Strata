const UI = {
  button(label, action, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = className;
    button.onclick = action;
    return button;
  },
  previewFile(file) {
    const content = document.querySelector(".file-preview-content");
    const title = document.createElement("h3");
    title.textContent = file.fileName;
    const body = document.createElement("pre");
    body.className = "file-content";
    body.textContent = file.content;
    content.replaceChildren(title, body);
    document.querySelector(".file-preview").style.display = "block";
    document.querySelector(".file-preview-overlay").style.display = "block";
  },
  renderChat({ bottom = false } = {}) {
    MessageEditor.dispose();
    this.userMessageObserver?.disconnect();
    const container = document.getElementById("chat-container");
    const scrollTop = container.scrollTop;
    const pinned =
      bottom ||
      container.scrollHeight - scrollTop - container.clientHeight < 160;
    Renderer.dispose(container);
    container.replaceChildren();
    const chat = AppState.currentChat;
    if (!chat) return;
    if (!chat.messages.length) {
      const welcome = document.createElement("div");
      welcome.className = "welcome";
      welcome.innerHTML =
        '<img class="welcome-logo" src="images/brand/ivyun-cloud.svg" width="64" height="49" alt="IVYUN 艾维云"><div class="welcome-eyebrow">IVYUN 助手</div><h2>今天想做什么？</h2><p>提出问题，或上传需要分析的文件。</p>';
      const starters = document.createElement("div");
      starters.className = "starter-grid";
      for (const [icon, title, detail, prompt] of [
        [
          "diagram",
          "梳理流程",
          "把步骤与关系画清楚",
          "帮我梳理一个项目从立项到交付的流程图",
        ],
        [
          "chart",
          "安排计划",
          "分解目标和下一步",
          "帮我制定一个为期四周的网站开发计划，列出每周的任务和交付物",
        ],
        [
          "table",
          "整理数据",
          "把信息变成结构化表格",
          "帮我整理一份项目任务分工表，包括任务、负责人、周期和状态",
        ],
      ]) {
        const button = this.button(
          "",
          () => {
            const input = document.getElementById("user-input");
            input.value = prompt;
            input.dispatchEvent(new Event("input"));
            input.focus();
          },
          "starter",
        );
        const name = document.createElement("strong");
        name.textContent = title;
        const description = document.createElement("span");
        description.textContent = detail;
        button.title = detail;
        button.append(Artifacts.icon(icon), name);
        starters.append(button);
      }
      welcome.append(starters);
      container.append(welcome);
    }
    for (const message of chat.messages)
      container.append(this.message(chat, message));
    this.updateControls();
    void BrowserView.restore();
    requestAnimationFrame(() => {
      if (AppState.currentChatId === chat.id)
        container.scrollTop = pinned ? container.scrollHeight : scrollTop;
    });
  },
  message(chat, message) {
    const wrapper = document.createElement("div");
    wrapper.className = "message-wrapper";
    wrapper.dataset.messageId = message.id;
    wrapper.dataset.role = message.role;
    const body = document.createElement("div");
    body.className =
      "message " + (message.role === "user" ? "user-message" : "ai-message");
    const content = document.createElement("div");
    content.className = "content-div";
    body.append(content);
    wrapper.append(body);
    if (message.role === "user") {
      content.textContent = message.content;
      content.style.whiteSpace = "pre-wrap";
      // Match ChatMessageUserBubble: wrapped text gets 10px instead of 6px vertical padding.
      body.dataset.multiline = String(message.content.includes("\n"));
      this.userMessageObserver ||= new ResizeObserver((entries) => {
        for (const { target, contentRect } of entries) {
          if (!target.isConnected) {
            this.userMessageObserver.unobserve(target);
            continue;
          }
          target.parentElement.dataset.multiline = String(
            target.textContent.includes("\n") || contentRect.height > 36,
          );
        }
      });
      this.userMessageObserver.observe(content);
    } else {
      BrowserView.renderSteps(chat, message, body);
      queueMicrotask(() => {
        if (content.isConnected)
          Renderer[message.status === "streaming" ? "stream" : "render"](
            content,
            message.content,
            {
              chatId: chat.id,
              messageId: message.id,
            },
          ).catch((error) => showToast("渲染失败：" + error.message, "error"));
      });
    }
    for (const attachment of ChartPrompts.attachments(message))
      body.append(
        this.button(
          "📎 " + attachment.fileName,
          () => this.previewFile(attachment),
          "file-attachment",
        ),
      );
    wrapper.append(MessageActions.footer(chat, message));
    if (message.role === "assistant") {
      if (message.status === "error" || message.status === "aborted") {
        const status = document.createElement("div");
        status.className = "message-status";
        status.textContent = message.error || "回答已停止";
        wrapper.append(status);
      }
    }
    return wrapper;
  },
  updateControls() {
    TaskView.refresh();
    const running = AppState.operations.has(AppState.currentChatId) || !!GenerationRecovery.pending(AppState.currentChat);
    document.getElementById("send-button").style.display = running
      ? "none"
      : "flex";
    document.getElementById("stop-button").style.display = running
      ? "flex"
      : "none";
    Composer.update();
    MessageActions.updateControls();
  },
  async finishReply(chat, message) {
    if (AppState.currentChatId !== chat.id) return;
    const wrapper = document.querySelector(
      '[data-message-id="' + message.id + '"]',
    );
    if (!wrapper) return;
    BrowserView.renderSteps(
      chat,
      message,
      wrapper.querySelector(".ai-message"),
    );
    await Renderer.stream(
      wrapper.querySelector(".content-div"),
      message.content,
      {
        chatId: chat.id,
        messageId: message.id,
      },
      true,
    ).catch((error) => showToast("渲染失败：" + error.message, "error"));
    wrapper
      .querySelector(".message-footer")
      ?.replaceWith(MessageActions.footer(chat, message));
    wrapper.querySelector(".message-status")?.remove();
    if (message.status === "error" || message.status === "aborted") {
      const status = document.createElement("div");
      status.className = "message-status";
      status.textContent = message.error || "回答已停止";
      wrapper.append(status);
    }
    this.updateControls();
  },
  async updateStream(chatId, message) {
    if (AppState.currentChatId !== chatId) return;
    const container = document.getElementById("chat-container");
    const before = container.scrollTop;
    const pinned =
      container.scrollHeight - before - container.clientHeight < 160;
    const node = document.querySelector(
      '[data-message-id="' + message.id + '"] .content-div',
    );
    if (node)
      BrowserView.renderSteps(
        AppState.currentChat,
        message,
        node.parentElement,
      );
    if (node)
      await Renderer.stream(node, message.content, {
        chatId,
        messageId: message.id,
      }).catch((error) => showToast("渲染失败：" + error.message, "error"));
    if (
      AppState.currentChatId === chatId &&
      pinned &&
      container.scrollTop >= before - 2
    )
      container.scrollTop = container.scrollHeight;
  },
};
