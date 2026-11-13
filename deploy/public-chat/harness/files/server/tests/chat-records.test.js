const { test } = require('node:test');
const assert = require('node:assert/strict');
const ChatRecords = require('../../public/js/core/chat-records');

const record = () => ({
    id: 'chat',
    userId: '1',
    timestamp: '2026年10月15日',
    summary: '旧记录',
    messages: [{ id: 'user', role: 'user', attachment: { fileName: 'table.xlsx', content: 'A,1' } }]
});

test('task display preferences normalize at the record boundary without rewriting stored input', () => {
    const raw = record();
    raw.messages.push({ id: 'task-source', role: 'assistant', taskList: [{ id: 'one', title: '核对', status: 'waiting' }] });
    raw.taskPanel = { open: true, expanded: true };
    const before = structuredClone(raw);
    const chat = ChatRecords.decode(raw, '1');
    assert.deepEqual(chat.taskPanel, { open: true, scope: 'task-source' });
    assert.deepEqual(raw, before);
    raw.taskPanel = { open: 'yes', expanded: 'bad' };
    assert.equal(ChatRecords.decode(raw, '1').taskPanel.open, false);
});

test('legacy decoding normalizes display fields without changing persisted source', () => {
    const raw = record();
    const before = structuredClone(raw);
    const chat = ChatRecords.decode(raw, '1');
    assert.equal(chat.schemaVersion, 1);
    assert.equal(chat.messages[0].content, '');
    assert.equal(chat.messages[0].status, 'complete');
    assert.equal(chat.timestamp, null);
    assert.deepEqual(raw, before);
    assert.deepEqual(chat.messages[0].attachment, before.messages[0].attachment);
});

test('interrupted message and branch states are recovered only when loading', () => {
    const raw = record();
    const message = {
        id: 'a',
        role: 'assistant',
        content: '已有回复',
        status: 'streaming',
        browserTurns: [{ id: 0, status: 'streaming', reasoning: '已有推理' }],
        browserSteps: [{ id: 's', name: 'browser_navigate', status: 'running' }]
    };
    raw.messages.push(message);
    raw.messageBranches = { a: [{ id: 'v', messages: [message] }] };
    const loaded = ChatRecords.decode(raw, '1');
    assert.equal(loaded.messages[1].status, 'aborted');
    assert.equal(loaded.messages[1].browserTurns[0].status, 'aborted');
    assert.equal(loaded.messages[1].browserSteps[0].status, 'aborted');
    assert.equal(loaded.messageBranches.a[0].messages[0].status, 'aborted');
    assert.equal(loaded.messages[1].browserTurns[0].reasoning, '已有推理');
    const saved = ChatRecords.decode(raw, '1', { recover: false });
    assert.equal(saved.messages[1].status, 'streaming');
    assert.equal(saved.messages[1].browserSteps[0].status, 'running');
    assert.equal(raw.messages[1].status, 'streaming');
});

test('unsupported records are rejected at the data boundary rather than reaching renderers', () => {
    for (const modify of [
        (raw) => {
            raw.schemaVersion = 99;
        },
        (raw) => {
            raw.messages = null;
        },
        (raw) => {
            raw.messages[0].browserSteps = [null];
        },
        (raw) => {
            raw.messages[0].statistics = { output: '30' };
        },
        (raw) => {
            raw.messageBranches = { a: [{ id: 'v', messages: null }] };
        }
    ]) {
        const raw = record();
        modify(raw);
        const before = structuredClone(raw);
        assert.throws(() => ChatRecords.decode(raw, '1'));
        assert.deepEqual(raw, before);
    }
    assert.throws(() => ChatRecords.decode(record(), 'other'), /归属/);
});

test('saved unfinished generation remains resumable after reload without marking tool actions aborted', () => {
    const raw=record();raw.messages.push({id:'reply',role:'assistant',content:'partial',status:'streaming',
        generation:{id:'known-generation',pending:true},
        browserTurns:[{id:0,status:'streaming',reasoning:'partial'}],
        browserSteps:[{id:'click-once',name:'browser_click',status:'running'}]});
    const recovered=ChatRecords.decode(raw,'1').messages[1];
    assert.equal(recovered.status,'streaming');assert.equal(recovered.connectionState,'reconnecting');
    assert.equal(recovered.generation.id,'known-generation');assert.equal(recovered.browserSteps[0].status,'running');
    assert.equal(recovered.error,undefined);
});
