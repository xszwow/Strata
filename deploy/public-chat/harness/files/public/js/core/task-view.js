// Conversation UI reads committed snapshots only; it never changes or runs tasks.
const TaskView = {
  init() {
    this.container = document.getElementById('conversation-tasks');
    this.entry = document.getElementById('task-entry');
    this.label = document.getElementById('task-entry-label');
    this.action = document.getElementById('task-entry-action');
    this.panel = document.getElementById('task-panel');
    this.list = document.getElementById('task-panel-list');
    this.scrollPositions = new WeakMap();
    this.entry.onclick = () => this.setOpen(this.model?.mode !== 'expanded');
    this.container.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.model?.mode === 'expanded') {
        event.preventDefault();
        event.stopPropagation();
        this.setOpen(false);
      }
    });
  },
  scrollFor(chat) {
    if (!this.scrollPositions.has(chat)) this.scrollPositions.set(chat, new Map());
    return this.scrollPositions.get(chat);
  },
  refresh() {
    if (!this.entry) return;
    // Rendering has no persistence effects. Remember only transient scroll in
    // this view, keyed by the owning conversation and plan, never globally.
    if (this.owner && this.model?.mode === 'expanded')
      this.scrollFor(this.owner).set(this.model.scope, this.list.scrollTop);
    const chat = AppState.currentChat;
    const model = TaskState.view(chat, {
      running: AppState.operations.has(chat?.id) || !!GenerationRecovery.pending(chat),
    });
    const changedOwner = this.owner !== chat || this.model?.scope !== model.scope;
    const hadListFocus = this.panel.contains(document.activeElement);
    if (changedOwner) this.list.replaceChildren();
    this.owner = chat;
    this.model = model;
    this.container.hidden = model.mode === 'hidden';
    this.panel.hidden = model.mode !== 'expanded';
    this.entry.setAttribute('aria-expanded', String(model.mode === 'expanded'));
    this.action.textContent = model.mode === 'expanded' ? '收起' : '展开';
    if (model.visible) {
      if (this.label.textContent !== model.text) this.label.textContent = model.text;
      this.entry.title = model.text;
      this.renderItems(model.items);
      if (model.mode === 'expanded') this.list.scrollTop = this.scrollFor(chat).get(model.scope) || 0;
    }
    if (hadListFocus && (changedOwner || model.mode !== 'expanded'))
      (model.visible ? this.entry : document.getElementById('user-input')).focus({ preventScroll: true });
  },
  renderItems(items) {
    const nodes = new Map([...this.list.children].map(node => [node.dataset.taskId, node]));
    items.forEach((item, index) => {
      let row = nodes.get(item.id);
      nodes.delete(item.id);
      if (!row) {
        row = document.createElement('li');
        row.dataset.taskId = item.id;
        row.innerHTML = '<span class="task-status-mark" aria-hidden="true"></span><div class="task-item-text"><div class="task-item-heading"><span class="task-item-title"></span><span class="task-item-status"></span></div><p class="task-item-note"></p></div>';
      }
      row.dataset.status = item.status;
      const set = (selector, value) => {
        const node = row.querySelector(selector);
        if (node.textContent !== value) node.textContent = value;
        return node;
      };
      set('.task-status-mark', item.status === 'completed' ? '✓' : item.status === 'waiting' ? '–' : '');
      set('.task-item-title', item.title);
      set('.task-item-status', TaskState.labels[item.status] || '待处理');
      set('.task-item-note', item.note || '').hidden = !item.note;
      if (this.list.children[index] !== row) this.list.insertBefore(row, this.list.children[index] || null);
    });
    for (const node of nodes.values()) node.remove();
  },
  renderHistory(items, body) {
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
    summary.textContent = "待办 · 已完成 " + TaskState.completed(items) + "/" + items.length;
    const list = document.createElement("ul");
    for (const item of items) {
      const row = document.createElement("li");
      row.textContent = [TaskState.labels[item.status], item.title, item.note].filter(Boolean).join(" · ");
      list.append(row);
    }
    details.replaceChildren(summary, list);
  },
  setOpen(open) {
    const chat = AppState.currentChat;
    const { visible, scope } = TaskState.read(chat?.messages);
    if (!chat || !visible) return;
    // User interaction is the sole writer of the disclosure preference.
    chat.taskPanel = { open, scope };
    this.refresh();
    if (!open) this.entry.focus({ preventScroll: true });
    void historyManager.persist(chat);
  },
};
