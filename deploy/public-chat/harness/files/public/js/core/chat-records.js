// Persistence boundary: legacy records enter AppState only after decoding.
// Reading never rewrites IndexedDB. Unsupported records remain available for export.
const ChatRecords = {
  version: 1,
  object(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(field + "格式异常");
    return value;
  },
  text(value, field, fallback = "") {
    if (value == null) return fallback;
    if (typeof value !== "string") throw new Error(field + "格式异常");
    return value;
  },
  array(value, field) {
    if (!Array.isArray(value)) throw new Error(field + "格式异常");
    return value;
  },
  date(value) {
    if (value == null) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  },
  metadata(record) {
    return {
      id: record.id,
      summary: typeof record.summary === "string" ? record.summary : "历史对话",
      timestamp: this.date(record.timestamp),
      messageCount: Array.isArray(record.messages)
        ? record.messages.length
        : null,
    };
  },
  statistics(value) {
    if (value == null) return undefined;
    this.object(value, "统计信息");
    for (const key of [
      "fresh",
      "cached",
      "prompt",
      "output",
      "total",
      "generationMs",
      "promptMs",
      "tokensPerSecond",
    ]) {
      if (value[key] == null) delete value[key];
      else if (!Number.isFinite(value[key]) || value[key] < 0)
        throw new Error("统计信息格式异常");
    }
    if (value.aggregate != null)
      value.aggregate = this.statistics(value.aggregate);
    if (value.progress != null) {
      this.object(value.progress, "预填充进度");
      for (const key of ["total", "cache", "processed", "time_ms"])
        if (!Number.isFinite(value.progress[key]) || value.progress[key] < 0)
          throw new Error("预填充进度格式异常");
    }
    return value;
  },
  message(message, recover) {
    this.object(message, "消息");
    if (
      !["user", "assistant"].includes(message.role) ||
      typeof message.id !== "string" ||
      !message.id
    )
      throw new Error("消息标识格式异常");
    // Attachment-only messages from the earlier UI can have no content field.
    message.content = this.text(message.content, "消息正文");
    message.status = this.text(message.status, "消息状态", "complete");
    message.statistics = this.statistics(message.statistics);
    if (message.generation != null) {
      this.object(message.generation, "生成任务");
      if (typeof message.generation.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(message.generation.id) ||
          typeof message.generation.pending !== "boolean") throw new Error("生成任务标识格式异常");
    }
    if (message.attachments != null) this.array(message.attachments, "附件");
    for (const attachment of message.attachments ||
      (message.attachment ? [message.attachment] : [])) {
      this.object(attachment, "附件");
      attachment.fileName = this.text(attachment.fileName, "附件名称");
      attachment.content = this.text(attachment.content, "附件内容");
    }
    if (message.browserTurns != null) {
      for (const turn of this.array(message.browserTurns, "执行过程")) {
        this.object(turn, "执行轮次");
        if (!Number.isInteger(turn.id)) throw new Error("执行轮次标识格式异常");
        turn.content = this.text(turn.content, "阶段回复");
        turn.reasoning = this.text(turn.reasoning, "推理");
        turn.statistics = this.statistics(turn.statistics);
        if (recover && !message.generation?.pending && turn.status === "streaming")
          turn.status =
            message.status === "complete"
              ? "final"
              : message.status === "streaming"
                ? "aborted"
                : message.status;
      }
    }
    if (message.browserSteps != null) {
      for (const step of this.array(message.browserSteps, "浏览器操作")) {
        this.object(step, "浏览器操作");
        if (typeof step.id !== "string" || typeof step.name !== "string")
          throw new Error("浏览器操作标识格式异常");
        if (recover && !message.generation?.pending && step.status === "running") {
          step.status = "aborted";
          step.error = "上次浏览器操作已中断";
        }
      }
    }
    if (recover && message.generation?.pending) {
      message.status = "streaming";
      message.connectionState = "reconnecting";
    } else if (recover && message.status === "streaming") {
      message.status = "aborted";
      message.error = "上次生成已中断，可以重新生成";
    }
    return message;
  },
  decode(raw, userId, { recover = true } = {}) {
    this.object(raw, "对话");
    if (raw.schemaVersion != null && raw.schemaVersion !== this.version)
      throw new Error("对话版本暂不支持");
    if (raw.userId !== String(userId) || typeof raw.id !== "string" || !raw.id)
      throw new Error("对话归属或标识异常");
    const chat = structuredClone(raw);
    chat.messages = this.array(chat.messages, "消息列表").map((message) =>
      this.message(message, recover),
    );
    if (chat.messageBranches != null) {
      this.object(chat.messageBranches, "消息版本");
      for (const versions of Object.values(chat.messageBranches))
        for (const version of this.array(versions, "消息版本")) {
          this.object(version, "消息版本");
          if (typeof version.id !== "string")
            throw new Error("消息版本标识格式异常");
          version.messages = this.array(version.messages, "版本消息").map(
            (message) => this.message(message, recover),
          );
        }
    }
    chat.schemaVersion = this.version;
    chat.timestamp = this.date(chat.timestamp);
    chat.title = this.text(chat.title, "对话标题");
    chat.summary = this.text(
      chat.summary,
      "对话摘要",
      chat.title ||
        chat.messages.find((m) => m.role === "user")?.content ||
        "新对话",
    );
    return chat;
  },
};
if (typeof module !== "undefined") module.exports = ChatRecords;
