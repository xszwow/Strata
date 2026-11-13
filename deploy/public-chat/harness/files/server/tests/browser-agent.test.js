const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserFixture, complete } = require('./browser-fixture');
const { SSEDecoder } = require('../../public/js/core/sse');
const { reportBrowserToolFailure } = require('../browser-errors');
const { BrowserBridge } = require('../browser-bridge');

const payload = (conversationId = 'conversation-a', messageId = 'reply-a') => ({
    messages: [{ role: 'user', content: '读取网页然后生成表格' }],
    stream: true,
    browserContext: { conversationId, messageId }
});

test('empty answers distinguish early reasoning stop from limits without leaking text or retrying tools', async (t) => {
    const f = await browserFixture();
    const logs = [];
    t.mock.method(console, 'warn', (...parts) => logs.push(parts));
    try {
        const user = await f.register();
        const quota = f.store.getUser(user.user.id).free_messages;
        for (const [reasoning, content, finish, expected] of [
            ['PRIVATE_REASONING', '', 'stop', '模型在思考后提前结束'],
            ['PRIVATE_REASONING', '', 'length', '模型达到生成上限'],
            ['', '  \n', 'PRIVATE_FINISH', '模型返回了空回复']
        ]) {
            const callsBefore = f.state.calls.length;
            f.state.onCompletion = async (body, res) => {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                const frame = {
                    choices: [{ delta: { reasoning_content: reasoning, content }, finish_reason: finish }],
                    usage: { completion_tokens: 585 }
                };
                res.end('data: ' + JSON.stringify(frame) + '\n\ndata: [DONE]\n\n');
                return true;
            };
            const response = await f.request('/api/chat/completions', payload(), user.token);
            const events = new SSEDecoder().feed(await response.text(), true);
            const data = events
                .filter((event) => event.data !== '[DONE]')
                .map((event) => JSON.parse(event.data));
            assert(data.some((event) => event.error?.message.includes(expected)));
            assert(!events.some((event) => event.data === '[DONE]'));
            assert.equal(f.state.calls.length, callsBefore + 1, 'no replay of an agent round');
            assert.equal(f.bridge.calls.length, 0);
            assert.equal(f.store.getUser(user.user.id).free_messages, quota);
            const diagnostic = JSON.parse(logs.at(-1)[1]);
            assert.equal(diagnostic.event, 'empty_answer');
            assert.equal(diagnostic.finishReason, finish.startsWith('PRIVATE_') ? 'unknown' : finish);
            assert.equal(diagnostic.reasoningCharacters, reasoning.length);
            assert.equal(diagnostic.outputTokens, 585);
            assert(!JSON.stringify(logs).includes('PRIVATE_'));
        }
    } finally {
        await f.close();
    }
});

test('scroll failures preserve their cause for the model, UI and diagnostic log', async (t) => {
    const f = await browserFixture();
    const logs = [];
    t.mock.method(console, 'warn', (line) => logs.push(line));
    try {
        const user = await f.register();
        const failures = [
            ['INVALID_SCROLL', 'pixels 必须'],
            ['TAB_NOT_OWNED', 'browser_tabs'],
            ['PAGE_UNAVAILABLE', '页面暂不可用'],
            ['STALE_REFERENCE', '新的元素引用'],
            ['TARGET_BLOCKED', '本次未点击'],
            ['TARGET_UNSTABLE', '位置仍在变化'],
            ['INVALID_WAIT', 'wait_for'],
            ['CHROME_TIMEOUT', '操作超时'],
            ['CHROME_ERROR', 'Chrome 未能完成']
        ];
        for (const [code, message] of failures) {
            f.bridge.toolError = { code, error: 'PRIVATE_EXTENSION_DETAILS' };
            let turn = 0;
            f.state.onCompletion = async (body, res) => {
                if (turn++ === 0) return complete(res, { tool: 'browser_scroll', args: { pixels: '600' } });
                const observation = JSON.parse(body.messages.find((item) => item.role === 'tool').content);
                assert.equal(observation.code, code);
                assert(observation.error.includes(message));
                return complete(res, { content: '已收到具体失败原因。' });
            };
            const events = await (await f.request('/api/chat/completions', payload(), user.token)).text();
            assert(events.includes('[DONE]'));
            assert(events.includes('"code":"' + code + '"'));
            assert(events.includes(message));
            assert(!events.includes('PRIVATE_EXTENSION_DETAILS'));
            const log = JSON.parse(logs.at(-1).slice('[browser-tool] '.length));
            assert.equal(log.code, code);
            assert.equal(log.tool, 'browser_scroll');
            assert.equal(log.scroll.pixels.type, 'string');
            assert.equal(log.scroll.pixels.value, undefined);
            assert.equal(log.scroll.horizontal.type, 'missing');
        }
    } finally {
        await f.close();
    }
});

test('browser diagnostics retain numeric scroll details without arbitrary tool arguments', () => {
    const logs = [];
    for (const name of ['browser_scroll', 'browser_type'])
        reportBrowserToolFailure(
            {
                name,
                code: 'INVALID_SCROLL',
                status: 502,
                startedAt: Date.now(),
                params: {
                    pixels: 6000,
                    horizontal: -5,
                    tab_id: 'PRIVATE_TAB',
                    text: 'PRIVATE_INPUT',
                    url: 'PRIVATE_URL'
                }
            },
            (line) => logs.push(line)
        );
    const scroll = JSON.parse(logs[0].slice('[browser-tool] '.length));
    assert.deepEqual(scroll.scroll.pixels, { type: 'number', value: 6000 });
    assert.deepEqual(scroll.scroll.horizontal, { type: 'number', value: -5 });
    assert.equal(scroll.scroll.tab_id_type, 'string');
    assert.equal(JSON.parse(logs[1].slice('[browser-tool] '.length)).scroll, undefined);
    assert(!logs.join('').includes('PRIVATE_'));
});

test('bridge distinguishes timeouts, unavailable service and cancellation without exposing remote error details', async () => {
    const config = { browserUrl: 'http://127.0.0.1:1', browserKey: 'private-test-key' };
    for (const [name, code, status] of [
        ['TimeoutError', 'BRIDGE_TIMEOUT', 504],
        ['TypeError', 'BRIDGE_UNAVAILABLE', 503]
    ]) {
        const bridge = new BrowserBridge(config, async () => {
            throw Object.assign(new Error('PRIVATE_NETWORK_DETAILS'), { name });
        });
        await assert.rejects(bridge.request('/tools'), (error) => {
            assert.equal(error.code, code);
            assert.equal(error.status, status);
            assert(!error.message.includes('PRIVATE_'));
            return true;
        });
    }
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancelled'));
    const bridge = new BrowserBridge(config, async () => {
        throw cancelled.signal.reason;
    });
    await assert.rejects(
        bridge.request('/tools', { signal: cancelled.signal }),
        (error) => error === cancelled.signal.reason
    );
    const invalidCode = new BrowserBridge(config, async () =>
        Response.json({ code: 'PRIVATE_ERROR\nDETAILS', error: 'PRIVATE_MESSAGE' }, { status: 502 })
    );
    await assert.rejects(invalidCode.request('/tools'), (error) => {
        assert.equal(error.code, 'BROWSER_ERROR');
        assert(!error.message.includes('PRIVATE_'));
        return true;
    });
});

test('fragmented tool calls execute server-side, feed observations back and charge one quota', async () => {
    const f = await browserFixture();
    try {
        const user = await f.register();
        const before = f.store.getUser(user.user.id).free_messages;
        const turns = [
            { tool: 'browser_navigate', args: { url: 'https://example.com' }, id: 'navigate' },
            { tool: 'browser_type', args: { ref: 'e1', text: '测试输入' }, id: 'type' },
            { tool: 'browser_finish', id: 'finish' },
            { content: '| 数值 |\n|---|\n| 42 |' }
        ];
        f.state.onCompletion = async (body, res) =>
            complete(res, {
                ...turns.shift(),
                timings: { prompt_n: 10, cache_n: 20, predicted_n: 5, predicted_ms: 100, prompt_ms: 50 }
            });
        const response = await f.request('/api/chat/completions', payload(), user.token);
        const events = await response.text();
        assert(events.includes('[DONE]'));
        assert(events.includes('42'));
        assert.equal(f.bridge.calls.length, 2);
        assert.equal(f.bridge.begins, 1);
        assert.equal(f.bridge.finishes, 1);
        assert.equal(f.store.getUser(user.user.id).free_messages, before - 1);
        assert.equal(f.state.calls.length, 4);
        assert.equal(f.state.calls[0].body.tools.length, 11);
        assert.equal(
            f.state.calls[1].body.messages.find((message) => message.role === 'tool').tool_call_id,
            'navigate'
        );
        assert.equal(
            JSON.parse(f.state.calls[1].body.messages.at(-1).content.split('\n').slice(1).join('\n'))
                .current_page.text,
            '42'
        );
        assert.equal(f.bridge.contexts, 0, 'successful page actions are not observed again');
        assert(!events.includes('test-browser-bridge-key'));
        assert(!events.includes('private-test-browser-session'));
        assert(!events.includes('测试输入'), 'typed arguments stay on server');
        assert(!events.includes('<script>'), 'page content is not a UI tool label');
        const totals = new SSEDecoder()
            .feed(events, true)
            .filter((event) => event.data !== '[DONE]')
            .map((event) => JSON.parse(event.data))
            .filter((event) => event.agent_usage)
            .at(-1).agent_usage;
        assert.deepEqual(totals, {
            fresh: 40,
            cached: 80,
            prompt: 120,
            output: 20,
            generationMs: 400,
            promptMs: 200,
            tokensPerSecond: 50
        });
    } finally {
        await f.close();
    }
});

test('live frames require authentication and the owning user and conversation', async () => {
    const f = await browserFixture();
    try {
        const owner = await f.register('owner'),
            other = await f.register('other');
        let turn = 0;
        f.state.onCompletion = async (body, res) =>
            complete(res, turn++ === 0 ? { tool: 'browser_observe' } : { content: '页面已读取' });
        await (await f.request('/api/chat/completions', payload(), owner.token)).text();
        const route = '/api/browser/events?conversationId=conversation-a';
        assert.equal((await f.request(route)).status, 401);
        assert.equal((await f.request(route, null, other.token)).status, 403);
        assert.equal(
            (await f.request('/api/browser/events?conversationId=conversation-b', null, owner.token)).status,
            403
        );
        const status = await (
            await f.request('/api/browser/status?conversationId=conversation-a', null, owner.token)
        ).json();
        assert.equal(status.sharing, true);
        assert.equal(status.messageId, 'reply-a');
        const stranger = await (
            await f.request('/api/browser/status?conversationId=conversation-a', null, other.token)
        ).json();
        assert.equal(stranger.sharing, false);
        assert.equal(stranger.messageId, undefined);
        const controller = new AbortController();
        const stream = await f.request(route, null, owner.token, { signal: controller.signal });
        const reader = stream.body.getReader();
        assert(new TextDecoder().decode((await reader.read()).value).includes('event: frame'));
        controller.abort();
        await reader.cancel().catch(() => {});
        turn = 0;
        const denied = await (
            await f.request('/api/chat/completions', payload('conversation-b'), other.token)
        ).text();
        assert(denied.includes('另一个对话正在使用浏览器'));
        assert.equal(f.bridge.begins, 1);
        assert.equal(f.bridge.finishes, 0, 'another conversation must not close the owner session');
    } finally {
        await f.close();
    }
});

test('unknown tools and excessive tool loops never reach arbitrary endpoints and clean up', async () => {
    const f = await browserFixture({ BROWSER_MAX_ACTIONS: '2' });
    try {
        const user = await f.register();
        let attempts = 0;
        f.state.onCompletion = async (body, res) => {
            if (!attempts++) return complete(res, { tool: 'shell_execute' });
            const error = JSON.parse(body.messages.findLast(m => m.role === 'tool').content);
            assert.equal(error.code, 'UNKNOWN_TOOL');
            assert.equal(error.outcome, 'not_dispatched');
            return complete(res, { content: '未声明的工具，结束查询。' });
        };
        const invalid = await (await f.request('/api/chat/completions', payload(), user.token)).text();
        assert(invalid.includes('未声明的工具'));
        assert.equal(f.bridge.begins, 0);
        f.state.onCompletion = async (body, res) => complete(res, { tool: 'browser_observe' });
        const limited = await (await f.request('/api/chat/completions', payload(), user.token)).text();
        assert(limited.includes('上限'));
        assert.equal(f.bridge.calls.length, 2);
        assert.equal(f.bridge.finishes, 1);
        assert.equal(f.bridge.connected, false);
    } finally {
        await f.close();
    }
});

test('offline extension is reported as a tool failure, and unapproved accounts get no browser tools', async () => {
    const f = await browserFixture({ BROWSER_ALLOWED_USER_IDS: '1' });
    try {
        const owner = await f.register('allowed'),
            other = await f.register('notallowed');
        f.bridge.offline = true;
        let turn = 0;
        f.state.onCompletion = async (body, res) =>
            complete(res, turn++ === 0 ? { tool: 'browser_observe' } : { content: '浏览器扩展尚未连接。' });
        const result = await (await f.request('/api/chat/completions', payload(), owner.token)).text();
        assert(result.includes('扩展尚未连接'));
        assert.equal(f.bridge.calls.length, 0);
        f.state.onCompletion = async (body, res) => complete(res, { content: '普通聊天' });
        await (await f.request('/api/chat/completions', payload(), other.token)).text();
        assert.equal(f.state.calls.at(-1).body.tools, undefined);
        assert.equal(
            (
                await (
                    await f.request('/api/browser/status?conversationId=conversation-a', null, other.token)
                ).json()
            ).available,
            false
        );
    } finally {
        await f.close();
    }
});

test('disconnecting generation preserves the owned task for reload, while explicit Stop closes it', async () => {
    const f = await browserFixture();
    let release;
    try {
        const user = await f.register();
        let turn = 0;
        f.state.onCompletion = async (body, res) => {
            if (turn++ === 0) return complete(res, { tool: 'browser_observe' });
            await new Promise((resolve) => {
                release = resolve;
            });
            if (!res.destroyed) complete(res, { content: '完成' });
            return true;
        };
        const controller = new AbortController();
        const response = await f.request('/api/chat/completions', payload(), user.token, {
            signal: controller.signal
        });
        const reader = response.body.getReader();
        while (!f.bridge.calls.length) await reader.read();
        for (let attempt = 0; attempt < 100 && !release; attempt++)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert(release, 'the next model round is waiting before reload');
        controller.abort();
        await reader.cancel().catch(() => {});
        const disconnectedAt = f.bridge.calls.length;
        for (let attempt = 0; attempt < 20; attempt++)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(f.bridge.finishes, 0);
        assert.equal(f.bridge.connected, true);
        assert.equal(f.bridge.calls.length, disconnectedAt, 'disconnect does not execute more tools');
        const restored = await (
            await f.request('/api/browser/status?conversationId=conversation-a', null, user.token)
        ).json();
        assert.equal(restored.sharing, true);
        assert.equal(restored.messageId, 'reply-a');
        const other = await f.register('not-the-owner');
        assert.equal(
            (
                await f.request(
                    '/api/browser/stop?conversationId=conversation-a',
                    { messageId: 'reply-a' },
                    other.token
                )
            ).status,
            403
        );
        assert.equal(
            (
                await f.request(
                    '/api/browser/stop?conversationId=conversation-a',
                    { messageId: 'old-reply' },
                    user.token
                )
            ).status,
            409
        );
        assert.equal(f.bridge.connected, true);
        assert.equal(
            (
                await f.request(
                    '/api/browser/stop?conversationId=conversation-a',
                    { messageId: 'reply-a' },
                    user.token
                )
            ).status,
            200
        );
        assert.equal(f.bridge.finishes, 1);
        assert.equal(f.bridge.connected, false);
        assert.equal(f.store.getUser(user.user.id).free_messages, 99);
    } finally {
        release?.();
        await f.close();
    }
});

test('reload during Chrome connection preserves the lease, but explicit Stop wins the connection race', async () => {
    for (const stop of [false, true]) {
        let releaseConnect,
            finishes = 0;
        const bridge = new BrowserBridge(
            { browserUrl: 'http://127.0.0.1:1234', browserKey: 'test' },
            async (url) => {
                if (url.pathname === '/browser/status') return Response.json({ sharing: false });
                if (url.pathname === '/browser/connect') {
                    await new Promise((resolve) => {
                        releaseConnect = resolve;
                    });
                    return Response.json({ browser_session: 'test-session' });
                }
                if (url.pathname === '/browser/finish') {
                    finishes++;
                    return Response.json({ sharing: false });
                }
                throw new Error('Unexpected route');
            }
        );
        const identity = { userId: 1, conversationId: 'reload', messageId: 'reply' };
        const cancellation = new AbortController();
        const disconnected = new AbortController();
        const release = bridge.claim(identity, () => cancellation.abort());
        const signal = AbortSignal.any([disconnected.signal, cancellation.signal]);
        const connected = bridge.connect(identity, signal);
        const rejected = assert.rejects(connected, (error) => error.code === 'CLIENT_DISCONNECTED');
        while (!releaseConnect) await new Promise((resolve) => setTimeout(resolve, 1));
        disconnected.abort(
            Object.assign(new Error('reload'), { name: 'AbortError', code: 'CLIENT_DISCONNECTED' })
        );
        if (stop) await bridge.stop(identity, AbortSignal.timeout(1000));
        releaseConnect();
        await rejected;
        assert.equal(bridge.owns(identity), !stop);
        assert.equal(finishes, stop ? 1 : 0);
        release();
    }
});

test('a session replacement between status and connect never dispatches an action with old page refs', async () => {
    let connects = 0,
        actions = 0,
        finishes = 0;
    const bridge = new BrowserBridge(
        { browserUrl: 'http://127.0.0.1:1234', browserKey: 'test' },
        async (url) => {
            if (url.pathname === '/browser/status') return Response.json({ sharing: connects > 0 });
            if (url.pathname === '/browser/connect')
                return Response.json({ browser_session: 'session-' + ++connects });
            if (url.pathname === '/tools') {
                actions++;
                return Response.json({ browser_observation: { text: 'done' } });
            }
            if (url.pathname === '/browser/finish') {
                finishes++;
                return Response.json({ sharing: false });
            }
            throw new Error('Unexpected route');
        }
    );
    const identity = { userId: 1, conversationId: 'connection-race', messageId: 'reply' };
    const release = bridge.claim(identity);
    const signal = AbortSignal.timeout(3000);
    try {
        await bridge.execute(identity, 'browser_click', { ref: 'old-ref' }, signal);
        await assert.rejects(bridge.execute(identity, 'browser_click', { ref: 'old-ref' }, signal), {
            code: 'BROWSER_SESSION_LOST'
        });
        assert.equal(actions, 1);
        await bridge.finish(identity, signal);
        assert.equal(
            finishes,
            1,
            'The replacement task is owned and can be cleaned up without acting on its page'
        );
    } finally {
        release();
    }
});

test('invalid JSON returns to model, rejected call never executes and a corrected call gets one receipt', async () => {
    const f = await browserFixture();
    try {
        const user = await f.register();
        let n = 0;
        f.bridge.makeObservation = () => ({ action_performed: true, receipt_id: 'DRAFT-941' });
        f.state.onCompletion = (body, res) => {
            if (n++ === 0) return complete(res, { tool:'browser_click', id:'bad-json', malformed:'{"ref":' });
            if (n === 2) {
                const error = JSON.parse(body.messages.findLast(m => m.role === 'tool').content);
                assert.equal(error.code,'INVALID_TOOL_ARGUMENTS');
                assert.equal(error.outcome,'not_dispatched');
                assert.equal(f.bridge.calls.length,0);
                return complete(res, { tool:'browser_click', id:'write-1', args:{ref:'e1'} });
            }
            return complete(res,{content:'草稿已核对'});
        };
        const body = {...payload(), generationId:'gen-receipts'};
        const response = await f.request('/api/chat/completions',body,user.token);
        assert((await response.text()).includes('[DONE]'));
        const params = {conversationId:'conversation-a',generationId:body.generationId};
        const stopped = await (await f.request('/api/chat/cancel',params,user.token)).json();
        assert.deepEqual(stopped.receipts.map(r => [r.id,r.state]),[['bad-json','not_dispatched'],['write-1','returned']]);
        assert.equal(stopped.receipts[1].receipt_id,'DRAFT-941');
        const other = await f.register();
        assert.deepEqual((await (await f.request('/api/chat/cancel',params,other.token)).json()).receipts,[]);
        f.state.onCompletion = (body,res) => {
            assert(body.messages.some(m => m.role==='assistant' && m.content.includes('DRAFT-941')));
            return complete(res,{content:'已有一份草稿，继续核对。'});
        };
        const next = payload('conversation-a','next-reply');
        next.browserContext.previousRuns=[params.generationId];
        assert((await (await f.request('/api/chat/completions',next,user.token)).text()).includes('[DONE]'));
        assert.equal(f.bridge.calls.length,1);
    } finally { await f.close(); }
});

test('stop keeps an in-flight write unknown, even when its browser effect has no acknowledged result', async () => {
    const f = await browserFixture();
    try {
        const user = await f.register();
        let resolveEntered, release;
        const entered = new Promise(r => { resolveEntered = r; });
        const wait = new Promise(r => { release = r; });
        f.bridge.beforeResult = () => { resolveEntered(); return wait; };
        f.state.onCompletion = (body,res) => complete(res,{tool:'browser_click',id:'click-once',args:{ref:'e1'}});
        const generationId = 'inflight-stop';
        const running = f.request('/api/chat/completions',{...payload(),generationId},user.token).then(r=>r.text());
        try {
            await Promise.race([entered,
                new Promise((_,reject) => AbortSignal.timeout(5000).addEventListener('abort',()=>reject(Error('tool never started')),{once:true}))]);
            const ack = await (await f.request('/api/chat/cancel',{generationId,conversationId:'conversation-a'},user.token)).json();
            assert.equal(ack.receipts[0].state,'unknown');
            assert.equal(ack.receipts[0].id,'click-once');
        } finally { release(); }
        await running;
        assert.equal(f.bridge.calls.length,1);
        let round = 0;
        f.state.onCompletion = (body, res) => {
            if (round++ === 0) return complete(res,{tool:'browser_click',id:'unsafe-repeat',args:{ref:'e1'}});
            if (round === 2) {
                const error = JSON.parse(body.messages.findLast(m => m.role === 'tool').content);
                assert.equal(error.code,'VERIFY_PREVIOUS_ACTION');
                assert.equal(error.outcome,'not_dispatched');
                return complete(res,{tool:'browser_observe'});
            }
            return complete(res,{content:'已核实，未重复操作'});
        };
        const next = payload('conversation-a','second-reply');
        next.browserContext.previousRuns = [generationId];
        assert((await (await f.request('/api/chat/completions',next,user.token)).text()).includes('[DONE]'));
        assert.deepEqual(f.bridge.calls.map(c=>c.tool),['browser_click','browser_observe']);
    } finally { await f.close(); }
});
