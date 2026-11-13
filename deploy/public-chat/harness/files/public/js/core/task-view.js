// Conversation UI reads committed snapshots only; it never changes or runs tasks.
const TaskView = {
  init() {
    this.entry = document.getElementById('task-entry');
    this.label = document.getElementById('task-entry-label');
    this.panel = document.getElementById('task-panel');
    this.list = document.getElementById('task-panel-list');
    this.summary = document.getElementById('task-panel-summary');
    this.expand = document.getElementById('task-panel-expand');
    this.entry.onclick = () => this.setOpen(true);
    document.getElementById('task-panel-close').onclick = () => this.setOpen(false);
    this.expand.onclick = () => this.setExpanded(!this.panel.classList.contains('is-expanded'));
    this.panel.addEventListener('cancel', event => {
      event.preventDefault();
      this.setOpen(false);
    });
    this.panel.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const targets = [...this.panel.querySelectorAll('button, [tabindex="0"]')];
      const next = event.shiftKey ? targets.at(-1) : targets[0];
      const edge = event.shiftKey ? targets[0] : targets.at(-1);
      if (document.activeElement === edge) {
        event.preventDefault();
        next.focus({ preventScroll: true });
      }
    });
    const outside = event => {
      const rect = this.panel.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom;
    };
    this.panel.addEventListener('pointerdown', event => { this.backdropDown = outside(event); });
    this.panel.addEventListener('click', event => {
      if (this.backdropDown && outside(event)) this.setOpen(false);
      this.backdropDown = false;
    });
    const handle = document.getElementById('task-panel-handle');
    handle.addEventListener('pointerdown', event => {
      this.drag = { id: event.pointerId, y: event.clientY };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointerup', event => {
      if (this.drag?.id !== event.pointerId) return;
      const distance = event.clientY - this.drag.y;
      this.drag = null;
      if (distance < -32) this.setExpanded(true);
      if (distance > 32) {
        if (this.panel.classList.contains('is-expanded')) this.setExpanded(false);
        else this.setOpen(false);
      }
    });
    handle.addEventListener('pointercancel', () => { this.drag = null; });
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
    if (this.chatId !== chat?.id) {
      if (this.panel.open) this.panel.close();
      this.chatId = chat?.id;
      this.list.replaceChildren();
      this.resetScroll = true;
    }
    this.entry.hidden = !state;
    if (!state) {
      if (this.panel.open) this.panel.close();
      this.entry.setAttribute('aria-expanded', 'false');
      if (chat?.taskPanel?.open) {
        chat.taskPanel = { ...chat.taskPanel, open: false };
        void historyManager.persist(chat);
      }
      return;
    }
    if (this.label.textContent !== state.text) this.label.textContent = state.text;
    this.entry.title = state.text;
    this.summary.textContent = '已完成 ' + state.completed + ' / ' + state.items.length;
    this.renderItems(state.items);
    this.panel.classList.toggle('is-expanded', chat.taskPanel?.expanded === true);
    this.expand.textContent = chat.taskPanel?.expanded ? '半屏' : '展开';
    this.expand.setAttribute('aria-label', chat.taskPanel?.expanded ? '恢复半屏待办面板' : '展开待办面板');
    const open = chat.taskPanel?.open === true;
    this.entry.setAttribute('aria-expanded', String(open));
    if (open && !this.panel.open) this.panel.showModal();
    if (this.panel.open && this.resetScroll) {
      this.list.scrollTop = 0;
      this.resetScroll = false;
    }
    if (!open && this.panel.open) this.panel.close();
  },
  renderItems(items) {
    const scroll = this.list.scrollTop;
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
  },
  setOpen(open) {
    const chat = AppState.currentChat;
    if (!chat || !this.snapshot(chat)) return;
    chat.taskPanel = { ...chat.taskPanel, open };
    this.refresh();
    if (!open) this.entry.focus({ preventScroll: true });
    void historyManager.persist(chat);
  },
  setExpanded(expanded) {
    const chat = AppState.currentChat;
    if (!chat || !this.panel.open) return;
    chat.taskPanel = { ...chat.taskPanel, expanded };
    this.refresh();
    void historyManager.persist(chat);
  },
};
