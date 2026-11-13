// Conversation UI reads committed snapshots only; it never changes or runs tasks.
const TaskView = {
  init() {
    this.container = document.getElementById('conversation-tasks');
    this.entry = document.getElementById('task-entry');
    this.label = document.getElementById('task-entry-label');
    this.action = document.getElementById('task-entry-action');
    this.panel = document.getElementById('task-panel');
    this.list = document.getElementById('task-panel-list');
    this.entry.onclick = () => this.setOpen(this.panel.hidden);
    // This is a disclosure anchored to the composer, not a modal. Tab can
    // continue through the list to the input, and outside interaction stays live.
    this.container.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !this.panel.hidden) {
        event.preventDefault();
        event.stopPropagation();
        this.setOpen(false);
      }
    });
  },
  snapshot(chat) {
    const messages = chat?.messages || [];
    const index = messages.findLastIndex(message => message.role === 'assistant' && Array.isArray(message.taskList));
    const items = messages[index]?.taskList || [];
    if (!items.length) return null;
    const completed = items.filter(item => item.status === 'completed').length;
    // A completed plan remains in its message, but leaves the composer on the next question.
    if (completed === items.length && messages.slice(index + 1).some(message => message.role === 'user')) return null;
    const latest = messages.findLast(message => message.role === 'assistant');
    const running = AppState.operations.has(chat.id) || !!GenerationRecovery.pending(chat);
    const current = items.find(item => item.status === 'in_progress') ||
      items.find(item => item.status === 'waiting') || items.find(item => item.status !== 'completed');
    let text = '已完成';
    if (current) {
      let state = current.status === 'waiting' ? '等待跟进' : current.status === 'in_progress'
        ? (running ? '进行中' : '待继续') : '待处理';
      if (!running && latest?.status === 'aborted') state = '已暂停';
      if (!running && latest?.status === 'error') state = '已中断';
      if (latest?.generation?.stopRequested && running) state = '正在停止';
      text = state + ' · ' + current.title;
    }
    return { items, completed, text: completed + '/' + items.length + ' · ' + text };
  },
  refresh() {
    if (!this.entry) return;
    const chat = AppState.currentChat;
    const state = this.snapshot(chat);
    if (!this.panel.hidden) this.listScroll = this.list.scrollTop;
    // Retain the open preference from the previous UI, retire its height mode.
    if (chat?.taskPanel && Object.hasOwn(chat.taskPanel, 'expanded')) {
      chat.taskPanel = { open: chat.taskPanel.open === true };
      void historyManager.persist(chat);
    }
    if (this.chatId !== chat?.id) {
      this.panel.hidden = true;
      this.chatId = chat?.id;
      this.list.replaceChildren();
      this.listScroll = 0;
      this.resetScroll = true;
    }
    this.container.hidden = !state;
    this.entry.hidden = !state;
    if (!state) {
      if (this.panel.contains(document.activeElement)) document.getElementById('user-input').focus({ preventScroll: true });
      this.panel.hidden = true;
      this.entry.setAttribute('aria-expanded', 'false');
      if (chat?.taskPanel?.open) {
        chat.taskPanel = { open: false };
        void historyManager.persist(chat);
      }
      return;
    }
    if (this.label.textContent !== state.text) this.label.textContent = state.text;
    this.entry.title = state.text;
    this.renderItems(state.items);
    const open = chat.taskPanel?.open === true;
    this.entry.setAttribute('aria-expanded', String(open));
    this.action.textContent = open ? '收起' : '展开';
    this.panel.hidden = !open;
    if (open) this.list.scrollTop = this.listScroll || 0;
    if (open && this.resetScroll) {
      this.list.scrollTop = 0;
      this.resetScroll = false;
    }
  },
  renderItems(items) {
    const scroll = this.panel.hidden ? this.listScroll || 0 : this.list.scrollTop;
    const nodes = new Map([...this.list.children].map(node => [node.dataset.taskId, node]));
    const labels = { pending: '待处理', in_progress: '进行中', waiting: '待跟进', completed: '已完成' };
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
      set('.task-item-status', labels[item.status] || '待处理');
      set('.task-item-note', item.note || '').hidden = !item.note;
      if (this.list.children[index] !== row) this.list.insertBefore(row, this.list.children[index] || null);
    });
    for (const node of nodes.values()) node.remove();
    this.list.scrollTop = scroll;
    this.listScroll = scroll;
  },
  setOpen(open) {
    const chat = AppState.currentChat;
    if (!chat || !this.snapshot(chat)) return;
    chat.taskPanel = { open };
    this.refresh();
    if (!open) this.entry.focus({ preventScroll: true });
    void historyManager.persist(chat);
  },
};
