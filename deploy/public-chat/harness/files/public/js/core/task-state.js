// Task snapshots belong to messages. UI preferences never change their contents.
const TaskState = {
  labels: { pending: '待处理', in_progress: '进行中', waiting: '待跟进', completed: '已完成' },
  completed(items) {
    return items.filter(item => item.status === 'completed').length;
  },
  read(messages = []) {
    let items = [], source = null, scope = null, visible = false;
    for (const message of messages) {
      if (message.role === 'user' && items.length && this.completed(items) === items.length) {
        // A new question retires a completed plan from the composer, while its
        // last committed snapshot remains available to the model and history.
        scope = null;
        visible = false;
      }
      if (message.role === 'assistant' && Array.isArray(message.taskList)) {
        items = message.taskList;
        source = message;
        visible = items.length > 0;
        scope = visible ? scope || message.id : null;
      }
    }
    return { items, source, scope, visible };
  },
  preference(value, messages) {
    // Normalize at the record boundary, including the retired height setting.
    return {
      open: value?.open === true,
      scope: typeof value?.scope === 'string' ? value.scope : this.read(messages).scope,
    };
  },
  view(chat, { running = false } = {}) {
    const state = this.read(chat?.messages);
    const completed = this.completed(state.items);
    const latest = chat?.messages.findLast(message => message.role === 'assistant');
    const current = state.items.find(item => item.status === 'in_progress') ||
      state.items.find(item => item.status === 'waiting') || state.items.find(item => item.status !== 'completed');
    let text = '已完成';
    if (current) {
      let label = current.status === 'waiting' ? '等待跟进' : current.status === 'in_progress'
        ? (running ? '进行中' : '待继续') : '待处理';
      if (!running && latest?.status === 'aborted') label = '已暂停';
      if (!running && latest?.status === 'error') label = '已中断';
      if (running && latest?.generation?.stopRequested) label = '正在停止';
      text = label + ' · ' + current.title;
    }
    return {
      ...state,
      completed,
      text: completed + '/' + state.items.length + ' · ' + text,
      mode: !state.visible ? 'hidden' : chat.taskPanel?.open === true && chat.taskPanel.scope === state.scope ? 'expanded' : 'collapsed',
    };
  },
};
if (typeof module !== 'undefined') module.exports = TaskState;
