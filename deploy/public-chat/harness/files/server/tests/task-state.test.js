const { test } = require('node:test');
const assert = require('node:assert/strict');
const Tasks = require('../../public/js/core/task-state');
const user = id => ({ id, role: 'user', content: id });
const snapshot = (id, status = 'waiting') => ({ id, role: 'assistant', status: 'complete', taskList: [{ id: 'one', title: '核对资料', status }] });

test('one committed snapshot feeds model context, live progress and historical counts', () => {
    const messages = [user('q1'), snapshot('a1'), user('q2'), { id: 'a2', role: 'assistant' }];
    const chat = { messages, taskPanel: { open: true, scope: 'a1' } };
    assert.equal(Tasks.read(messages).items, messages[1].taskList);
    assert.equal(Tasks.view(chat).mode, 'expanded');
    messages.push(snapshot('a3', 'completed'));
    assert.equal(Tasks.view(chat).text, '1/1 · 已完成');
    assert.equal(Tasks.view(chat).scope, 'a1');
    messages.push(user('q3'));
    assert.equal(Tasks.view(chat).mode, 'hidden');
    assert.equal(Tasks.read(messages).items, messages[4].taskList, 'hiding a completed card does not erase model context');
    messages.push(snapshot('a4'));
    assert.equal(Tasks.view(chat).mode, 'collapsed', 'the retired plan cannot auto-expand a fresh plan');
    assert.equal(Tasks.view(chat).scope, 'a4');
});

test('clearing or changing branches never falls back to a stale task snapshot', () => {
    const chat = { messages: [user('q1'), snapshot('a1')], taskPanel: { open: true, scope: 'a1' } };
    chat.messages.push({ id: 'a2', role: 'assistant', taskList: [] });
    assert.deepEqual(Tasks.read(chat.messages).items, []);
    assert.equal(Tasks.view(chat).mode, 'hidden');
    chat.messages = [user('q1'), snapshot('branch-b')];
    assert.equal(Tasks.view(chat).scope, 'branch-b');
    assert.equal(Tasks.view(chat).mode, 'collapsed');
});

test('presentation is read-only and distinguishes waiting, running, stopping and interrupted work', () => {
    const message = snapshot('a1', 'in_progress');
    const chat = { messages: [user('q1'), message], taskPanel: { open: false, scope: 'a1' } };
    assert.match(Tasks.view(chat).text, /待继续/);
    assert.match(Tasks.view(chat, { running: true }).text, /进行中/);
    message.generation = { stopRequested: true };
    assert.match(Tasks.view(chat, { running: true }).text, /正在停止/);
    message.status = 'aborted';
    assert.match(Tasks.view(chat).text, /已暂停/);
    message.status = 'error';
    assert.match(Tasks.view(chat).text, /已中断/);
    const before = structuredClone(chat);
    Object.freeze(chat.taskPanel);
    Object.freeze(chat.messages);
    Object.freeze(chat);
    for (let i = 0; i < 4; i++) Tasks.view(chat);
    assert.deepEqual(chat, before);
});
