const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const { browserFixture, complete } = require('./browser-fixture');

async function main() {
    const f = await browserFixture();
    const browser = await chromium.launch({ headless: true,
        ...(!fs.existsSync(chromium.executablePath()) ? { channel: 'chrome' } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const fact = 'FACT-' + randomUUID(), receipt = 'RECEIPT-' + randomUUID();
    const send = async text => {
        await page.fill('#user-input', text);
        await page.click('#send-button');
        await page.waitForFunction(() => !AppState.operations.size && !GenerationRecovery.preparing.size &&
            AppState.currentChat.messages.at(-1)?.role === 'assistant' &&
            AppState.currentChat.messages.at(-1)?.status !== 'streaming');
    };
    const latest = () => f.state.calls.at(-1).body.messages;
    const text = () => JSON.stringify(latest());
    try {
        const user = await f.register('conversation-memory');
        await page.goto(f.url + '/login.html');
        await page.evaluate(account => {
            localStorage.setItem('token', account.token);
            localStorage.setItem('user', JSON.stringify(account.user));
        }, user);
        await page.goto(f.url + '/chat.html');
        await page.waitForFunction(() => AppState.historyReady && Composer.ready);
        f.state.onCompletion = (body, res) => complete(res, { content: '明白，只操作一次。' });
        await send('记住代号 ' + fact + '，只操作一次。');
        await send('我前面要求了什么？');
        assert(text().includes(fact));
        assert(latest().some(message => message.role === 'assistant' && message.content === '明白，只操作一次。'));
        console.log('PASS ordinary multi-turn text reaches the model endpoint');

        let round = 0;
        f.bridge.makeObservation = () => ({ text: '操作已执行，凭证 ' + receipt,
            url: 'https://example.test/result', action_performed: true, wait_result: { status: 'timed_out' } });
        f.state.onCompletion = (body, res) => {
            switch (round++) {
                case 0: return complete(res, { tool: 'browser_navigate', args: { url: 'https://example.test' },
                    content: '阶段说明：核对订单 68。', reasoning: 'unshared-reasoning' });
                case 1: return complete(res, { tool: 'browser_click', args: { ref: 'e1' }, content: '执行一次操作。' });
                case 2: return complete(res, { tool: 'browser_finish' });
                default: return complete(res, { content: '已处理，详情见执行过程。' });
            }
        };
        await send('打开验收页并执行一次操作。');
        const originalChat = await page.evaluate(() => AppState.currentChatId);
        const actionCount = f.bridge.calls.length;
        f.state.onCompletion = (body, res) => complete(res, { content: '依据历史记录回答。' });
        await send('刚才的凭证和操作是什么？');
        for (const expected of [fact, receipt, '订单 68', 'browser_click', 'timed_out', 'action_performed'])
            assert(text().includes(expected), `upstream missed ${expected}`);
        assert(!text().includes('unshared-reasoning'));
        assert.equal(f.bridge.calls.length, actionCount, 'a follow-up must not replay tools');
        console.log('PASS real send, SSE and next request retain phase replies, actions and results');

        await page.reload();
        await page.waitForFunction(() => AppState.historyReady && Composer.ready);
        assert.equal(await page.evaluate(() => AppState.currentChatId), originalChat);
        await send('刷新后再说一次凭证。');
        assert(text().includes(receipt));
        assert(text().includes(fact));
        await page.locator('.regenerate-btn').last().click();
        await page.waitForFunction(() => !AppState.operations.size && !GenerationRecovery.preparing.size &&
            AppState.currentChat.messages.at(-1)?.status === 'complete');
        assert(text().includes(receipt));
        assert.equal(latest().filter(message => message.role === 'assistant' &&
            message.content === '依据历史记录回答。').length, 1, 'regeneration excludes the replaced reply');
        console.log('PASS IndexedDB reload and regeneration preserve the earlier selected history');

        await page.evaluate(() => historyManager.createNewChat());
        await send('独立的新会话');
        assert(!text().includes(receipt) && !text().includes(fact));
        await page.evaluate(id => historyManager.select(id), originalChat);
        const failedReceipt = 'PARTIAL-' + randomUUID();
        f.bridge.makeObservation = () => ({ text: '失败前已完成操作 ' + failedReceipt });
        round = 0;
        f.state.onCompletion = (body, res) => {
            if (round++ === 0) return complete(res, { tool: 'browser_navigate', args: { url: 'https://example.test/partial' } });
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'simulated final-answer failure' }));
            return true;
        };
        await send('先完成操作，再模拟最终回复失败。');
        assert.equal(await page.evaluate(() => AppState.currentChat.messages.at(-1).status), 'error');
        const failedActions = f.bridge.calls.length;
        f.state.onCompletion = (body, res) => complete(res, { content: '保留之前已发生的操作。' });
        await send('不要重做，先说出失败前做过什么。');
        assert(text().includes(failedReceipt));
        assert(latest().some(message => message.role === 'assistant' &&
            message.content.includes(failedReceipt) && message.content.includes('"status":"error"')));
        assert.equal(f.bridge.calls.length, failedActions);
        assert.deepEqual(errors, []);
        console.log('PASS new chat isolation and preservation of executed work after a failed final reply');
    } finally {
        await browser.close();
        await f.close();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
