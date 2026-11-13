const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BrowserContext, BrowserProgress } = require('../browser-context');
const { browserFixture, complete } = require('./browser-fixture');
const payload = {
    messages: [{ role: 'user', content: 'Compare earlier page facts and finish only after verification.' }],
    stream: true,
    browserContext: { conversationId: 'long-flow', messageId: 'reply' }
};
const tail = (messages) => JSON.parse(messages.at(-1).content.split('\n').slice(1).join('\n'));

test('epoch compaction drops obsolete failures with paired calls and retains an uncertain write', () => {
    const memory = new BrowserContext({browserContextStrategy:'epoch',browserEpochChars:1});
    const calls = ['bad','good','uncertain'].map(id=>({id,type:'function',
        function:{name:id==='uncertain'?'browser_click':'browser_observe',arguments:'{}'}}));
    const messages = [{role:'assistant',tool_calls:calls,reasoning_content:'OLD_WRONG_ATTEMPT'},
        {role:'tool',tool_call_id:'bad',content:'{"error":"REJECTED","outcome":"not_dispatched"}'},
        {role:'tool',tool_call_id:'good',content:'{"text":"confirmed fact"}'},
        {role:'tool',tool_call_id:'uncertain',content:'{"error":"TIMEOUT","outcome":"unknown"}'}];
    for(let i=0;i<4;i++){
        const observation={text:'PAGE_'+i};
        const id=memory.capture(observation);
        messages.push({role:'tool',tool_call_id:'page'+i,content:JSON.stringify(memory.receipt(observation,id))});
    }
    memory.compact(messages);
    assert.equal(memory.compactions,1);
    assert.doesNotMatch(JSON.stringify(messages),/REJECTED|OLD_WRONG_ATTEMPT|TIMEOUT/);
    assert.deepEqual(messages[0].tool_calls.map(c=>c.id),['good','uncertain']);
    assert(!messages.some(m=>m.tool_call_id==='bad'));
    assert.match(messages.find(m=>m.tool_call_id==='uncertain').content,/unknown/);
});

test('50-step agent run keeps an immutable cache prefix, retrieves old facts without Chrome and retains one full live page', async () => {
    const f = await browserFixture({ BROWSER_MAX_ACTIONS: '55', BROWSER_STRATA_PREFIX_CACHE: 'true' });
    try {
        f.bridge.makeObservation = (_body, n) => ({
            url: 'https://fixture.test/' + n,
            title: 'Fixture ' + n,
            text: 'PAGE_FACT_' + n + ' ' + '页面资料'.repeat(3000),
            elements: Array.from({ length: 100 }, (_, i) => ({
                ref: 'page' + n + '-ref' + i,
                tag: 'button',
                label: 'Button ' + i + ' ' + 'label '.repeat(15)
            }))
        });
        const user = await f.register();
        let turn = 0,
            priorHead,
            priorTools,
            maxChars = 0;
        f.state.onCompletion = async (body, res) => {
            assert.deepEqual(
                body.strata_prefix,
                { messages: body.messages.length - 1 },
                'Checkpoint ends before live text and screenshot'
            );
            if (priorHead)
                assert.deepEqual(
                    body.messages.slice(0, priorHead.length),
                    priorHead,
                    'Already-sent prefix must remain byte-for-byte equivalent'
                );
            if (priorTools)
                assert.deepEqual(body.tools, priorTools, 'Tool schema/order stays fixed across all rounds');
            priorHead = structuredClone(body.messages.slice(0, -1));
            priorTools = structuredClone(body.tools);
            maxChars = Math.max(maxChars, JSON.stringify(body.messages).length);
            const state = tail(body.messages);
            if (turn === 49) {
                assert.match(state.requested_history.text, /PAGE_FACT_1/);
                assert.ok(state.requested_history.elements.every((e) => !Object.hasOwn(e, 'ref')));
                assert.match(
                    state.current_page.text,
                    /PAGE_FACT_48/,
                    'Recall must not replace the live page'
                );
                assert.equal(f.bridge.calls.length, 48, 'History recall must not touch Chrome');
            }
            if (turn === 50) {
                assert.equal(state.page_closed, true);
                assert.match(
                    state.requested_history.text,
                    /PAGE_FACT_1/,
                    'Retrieved evidence survives finish for the final comparison'
                );
                assert.match(
                    state.current_page.text,
                    /PAGE_FACT_48/,
                    'Final answer can still inspect the last verified state'
                );
            }
            const step = turn++;
            return complete(
                res,
                step < 48
                    ? { tool: 'browser_observe', id: 'read-' + step }
                    : step === 48
                      ? { tool: 'browser_observe', args: { history_id: 'page-1' }, id: 'recall' }
                      : step === 49
                        ? { tool: 'browser_finish', id: 'finish' }
                        : { content: 'Verified historic fact PAGE_FACT_1 and latest PAGE_FACT_48.' }
            );
        };
        const text = await (await f.request('/api/chat/completions', payload, user.token)).text();
        assert.ok(text.includes('[DONE]'));
        assert.equal(turn, 51);
        assert.equal(f.bridge.finishes, 1);
        assert.ok(maxChars < 100000, '50 rounds must not accumulate 50 full page snapshots: ' + maxChars);
        for (const request of f.state.calls) {
            for (const message of request.body.messages.filter((m) => m.role === 'tool')) {
                const receipt = JSON.parse(message.content);
                assert.equal(receipt.elements, undefined);
                assert.equal(receipt.text, undefined);
            }
        }
    } finally {
        await f.close();
    }
});

test('history is request-local, rejects mixed live parameters and omits images and credentials', () => {
    const memory = new BrowserContext();
    const id = memory.capture({
        text: 'original fact',
        elements: [{ ref: 'r1', label: 'Open', href: 'https://fixture.test/1' }],
        image: { mime: 'image/png', data: 'private-image' },
        browser_session: 'private-session'
    });
    assert.throws(() => new BrowserContext().recall({ history_id: id }), { code: 'INVALID_HISTORY' });
    assert.throws(() => memory.recall({ history_id: id, ref: 'r1' }), { code: 'INVALID_HISTORY' });
    memory.recall({ history_id: id });
    assert.ok(!JSON.stringify(memory.recalled).includes('private-'));
    assert.equal(memory.recalled.elements[0].ref, undefined);
    assert.match(memory.recalled.text, /original fact/);
});

test('read-only success does not erase action failure streak; actual successful action permits recovery', () => {
    const progress = new BrowserProgress(50);
    for (let i = 0; i < 4; i++) {
        progress.record('browser_click', null, { code: 'TARGET_BLOCKED' });
        progress.record('browser_observe', {}, null);
    }
    assert.equal(progress.failures, 4);
    assert.equal(progress.stopReason, null);
    progress.record('browser_press', {}, null);
    assert.equal(progress.failures, 0);
    for (let i = 0; i < 5; i++) progress.record('browser_type', null, { code: 'STALE_REFERENCE' });
    assert.match(progress.stopReason, /连续 5 次/);
});

test('five failed actions with intervening observations end with one tool-free explanation and close only owned task', async () => {
    const f = await browserFixture({ BROWSER_MAX_ACTIONS: '50' });
    try {
        const user = await f.register();
        let turn = 0;
        f.state.onCompletion = async (body, res) => {
            const step = turn++;
            if (step === 9) {
                assert.equal(body.tool_choice, 'none');
                assert.equal(f.bridge.finishes, 1);
                assert.match(tail(body.messages).task.stop_reason, /连续 5 次/);
                return complete(res, { content: '连续 5 次动作失败，任务未完成。' });
            }
            f.bridge.toolError = step % 2 === 0 ? { code: 'TARGET_BLOCKED' } : null;
            return complete(res, {
                tool: step % 2 === 0 ? 'browser_click' : 'browser_observe',
                args: step % 2 === 0 ? { ref: 'e1' } : {}
            });
        };
        const text = await (await f.request('/api/chat/completions', payload, user.token)).text();
        assert.ok(text.includes('[DONE]'));
        assert.equal(turn, 10);
        assert.equal(f.bridge.calls.length, 9);
        assert.equal(f.bridge.finishes, 1);
    } finally {
        await f.close();
    }
});

test('action budget allows a final explanation without executing or replaying another action', async () => {
    const f = await browserFixture({ BROWSER_MAX_ACTIONS: '2' });
    try {
        const user = await f.register();
        let turn = 0;
        f.state.onCompletion = async (body, res) => {
            if (turn++ < 2) return complete(res, { tool: 'browser_click', args: { ref: 'e1' } });
            assert.equal(body.tool_choice, 'none');
            assert.equal(f.bridge.finishes, 1);
            assert.equal(tail(body.messages).task.actions_remaining, 0);
            return complete(res, { content: '已达操作上限，已完成的动作见记录，剩余任务未完成。' });
        };
        const text = await (await f.request('/api/chat/completions', payload, user.token)).text();
        assert.ok(text.includes('[DONE]'));
        assert.equal(f.bridge.calls.length, 2);
        assert.equal(f.bridge.finishes, 1);
    } finally {
        await f.close();
    }
});

test('a lost Chrome session stops the generation instead of creating a new task and replaying actions', async () => {
    const f = await browserFixture({ BROWSER_MAX_ACTIONS: '50' });
    try {
        const user = await f.register();
        let turn = 0;
        f.state.onCompletion = async (body, res) => {
            const step = turn++;
            if (step === 0) return complete(res, { tool: 'browser_click', args: { ref: 'e1' } });
            if (step === 1) {
                f.bridge.connected = false;
                // A UI status refresh can clear the local lease before the next action.
                await f.request('/api/browser/status?conversationId=long-flow', null, user.token);
                return complete(res, { tool: 'browser_click', args: { ref: 'e1' } });
            }
            assert.equal(body.tool_choice, 'none');
            assert.match(tail(body.messages).task.stop_reason, /原浏览器任务已中断/);
            assert.equal(f.bridge.begins, 1, 'Must not open a replacement task');
            assert.equal(f.bridge.calls.length, 1, 'No action dispatch after losing the original task');
            return complete(res, { content: '首次动作已执行，原浏览器任务中断，剩余动作未执行。' });
        };
        const text = await (await f.request('/api/chat/completions', payload, user.token)).text();
        assert.ok(text.includes('[DONE]'));
        assert.ok(text.includes('BROWSER_SESSION_LOST'));
        assert.equal(turn, 3);
        // A later user request has its own generation and may start a new task.
        f.state.onCompletion = async (body, res) =>
            complete(res, turn++ === 3 ? { tool: 'browser_observe' } : { content: '新任务已打开。' });
        const next = await (await f.request('/api/chat/completions', payload, user.token)).text();
        assert.ok(next.includes('[DONE]'));
        assert.equal(f.bridge.begins, 2);
    } finally {
        await f.close();
    }
});
