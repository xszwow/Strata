const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserFixture, complete } = require('./browser-fixture');
const { SSEDecoder } = require('../../public/js/core/sse');
const { updateTasks } = require('../task-list');
const prompts = require('../../public/js/config/prompts');

test('batch edits are atomic, preserve unrelated work and can clear or reopen an item', () => {
    const tasks = updateTasks([], [
        { id: 'document', title: '修订提案', status: 'pending' },
        { id: 'chart', title: '更新库存图', status: 'in_progress', note: '单位为箱' }
    ]);
    assert.throws(() => updateTasks(tasks, [{ id: 'chart', status: 'removed' }, { id: 'new', status: 'pending' }]));
    assert.equal(tasks.length, 2);
    const next = updateTasks(tasks, [{ id: 'document', status: 'waiting', note: '等待预算' }]);
    assert.deepEqual(next[1], tasks[1]);
    assert.equal(updateTasks(next, [{ id: 'document', status: 'completed' }])[0].title, '修订提案');
    assert.deepEqual(updateTasks(next, next.map(({id}) => ({ id, status: 'removed' }))), []);
});

test('task-only chat returns validation errors, persists before acknowledgement and restores only the owning branch', async () => {
    const f = await browserFixture({ BROWSER_ALLOWED_USER_IDS: '2' });
    try {
        const owner = await f.register('plan-owner'), other = await f.register('other-user');
        const body = { messages: [{ role: 'user', content: '规划调研' }], stream: true, generationId: 'g-1',
            browserContext: { conversationId: 'topic', messageId: 'm-1', taskList: [] } };
        const item = { id: 'report', title: '调研三种材料', status: 'waiting', note: '已查 A、B 的密度，待查 C' };
        let turn = 0;
        f.state.onCompletion = (request, res) => {
            assert.deepEqual(request.tools.map(t => t.function.name), ['task_update']);
            if (turn++ === 0) return complete(res, {tool:'task_update', id:'bad',args:{items:[{id:'no-title',status:'pending'}]}});
            if (turn === 2) {
                assert.match(request.messages.find(m => m.tool_call_id === 'bad').content, /INVALID_TOOL_ARGUMENTS/);
                return complete(res, { tool:'task_update', id:'fixed', args:{items:[item]} });
            }
            assert.deepEqual(f.store.savedTasks(owner.user.id,'topic','g-1'), [item]);
            return complete(res, {content:'已记下'});
        };
        const response = await f.request('/api/chat/completions', body, owner.token);
        const frames = new SSEDecoder().feed(await response.text(), true);
        assert(frames.some(e => e.data === '[DONE]'));
        const exported = frames.filter(e=>e.data !== '[DONE]').map(e=>JSON.parse(e.data)).find(e=>e.browser?.type==='task-list');
        assert.deepEqual(exported.browser.items, [item]);
        assert.equal(f.bridge.calls.length, 0);
        const cancel = async (user, topic) => (await f.request('/api/chat/cancel',
            {generationId:'g-1',conversationId:topic},user.token)).json();
        assert.deepEqual((await cancel(owner,'topic')).taskList, [item]);
        assert.equal((await cancel(owner,'different')).taskList, undefined);
        assert.equal((await cancel(other,'topic')).taskList, undefined);
        // Simulate expired stream but committed checkpoint after restarting the worker.
        f.store.saveTasks({userId:owner.user.id,conversationId:'topic'},'expired', [item]);
        const url = '/api/chat/stream?generationId=expired&after=0&conversationId=topic';
        const expired = await f.request(url, null, owner.token);
        assert.equal(expired.status, 410);
        assert.deepEqual((await expired.json()).taskList, [item]);
        assert.equal((await (await f.request(url,null,other.token)).json()).taskList, undefined);
        for (const active of [[item], []]) {
            const history = Array.from({length:112}, (_,i) => [
                {role:'user',content:'问题 '+i},{role:'assistant',content:'答复 '+i}]).flat();
            f.state.onCompletion = (request,res) => {
                assert.equal(JSON.stringify(request.messages).includes(item.note), Boolean(active.length));
                return complete(res, {content:'继续'});
            };
            const next = {...body, messages:prompts.messages([...history,{role:'user',content:'继续'}]),
                generationId:'g-'+active.length+'-next', browserContext:{...body.browserContext,taskList:active}};
            assert.match(await (await f.request('/api/chat/completions',next,owner.token)).text(), /\[DONE\]/);
        }
    } finally { await f.close(); }
});
