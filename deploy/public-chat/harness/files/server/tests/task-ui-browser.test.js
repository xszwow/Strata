const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { browserFixture, complete } = require('./browser-fixture');

async function setup(name) {
    const f = await browserFixture();
    const browser = await chromium.launch({ headless: true,
        ...(!fs.existsSync(chromium.executablePath()) ? { channel: 'chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const user = await f.register(name);
    await context.addInitScript(user => {
        localStorage.setItem('token', user.token);
        localStorage.setItem('user', JSON.stringify(user.user));
    }, user);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(f.url + '/chat.html');
    await ready(page);
    return { f, browser, page, errors, close: async () => { await browser.close(); await f.close(); } };
}
const ready = page => page.waitForFunction(() => AppState.historyReady && Composer.ready);
const settled = page => page.waitForFunction(() => !AppState.operations.size && !GenerationRecovery.pending(AppState.currentChat));
const send = async (page, text) => {
    const previous = await page.evaluate(() => AppState.currentChat.messages.at(-1)?.id || null);
    await page.locator('#user-input').fill(text);
    await page.locator('#send-button').click();
    await page.waitForFunction(previous => AppState.currentChat.messages.at(-1)?.id !== previous && AppState.currentChat.messages.at(-1)?.status === 'complete', previous);
    await settled(page);
};
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('saved tool events drive the entry; reload restores its panel; completion retires on next send', async () => {
    const s = await setup('task-ui-events');
    const { page, f } = s;
    let calls = 0;
    const items = [
        { id: 'research', title: '核对三家报价', status: 'completed', note: '已收齐同规格报价' },
        { id: 'budget', title: '确认采购预算', status: 'waiting', note: '等待用户提供预算上限' },
        { id: 'chart', title: '整理对比表', status: 'pending' },
    ];
    f.state.onCompletion = (body, res) => {
        calls++;
        if (calls === 1) return complete(res, { content: '我会记录这些待办。', tool: 'task_update', args: { items } });
        if (calls === 3) return complete(res, { tool: 'task_update', args: { items: items.map(item => ({ ...item, status: 'completed' })) } });
        return complete(res, { content: '已处理，请查看本次会话待办。' });
    };
    try {
        assert.equal(await page.locator('#task-entry').isVisible(), false);
        await send(page, '记录采购任务');
        assert.equal(await page.locator('#task-entry-label').textContent(), '1/3 · 等待跟进 · 确认采购预算');
        assert.equal(await page.locator('#task-panel').evaluate(node => node.open), false);
        await page.locator('#task-entry').click();
        assert.equal(await page.locator('#task-panel-list li').count(), 3);
        await page.waitForFunction(async () => (await historyManager.db.get('chats', [historyManager.userId, AppState.currentChat.id])).taskPanel?.open);
        await page.reload();
        await ready(page);
        await page.waitForFunction(() => document.getElementById('task-panel').open);
        assert.equal(calls, 2, 'opening and restoring the panel never executes a model/tool call');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#task-entry').evaluate(node => node === document.activeElement), true);
        await send(page, '预算已确认，全部完成');
        assert.equal(await page.locator('#task-entry-label').textContent(), '3/3 · 已完成');
        await send(page, '谢谢');
        assert.equal(await page.locator('#task-entry').isVisible(), false);
        const historical = page.locator('.session-tasks').last();
        await historical.locator('summary').click();
        assert.match(await historical.textContent(), /已完成 3\/3/);
        assert.equal(await historical.locator('li').count(), 3);
        await page.reload();
        await ready(page);
        assert.equal(await page.locator('#task-entry').isVisible(), false);
        assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
});

test('mobile sheet stays within the viewport, preserves reading position, and isolates conversations', async () => {
    const s = await setup('task-ui-layout');
    const { page } = s;
    try {
        const ids = await page.evaluate(async () => {
            const chat = AppState.currentChat;
            chat.messages.push(AppState.newMessage('user', '安排项目交付'));
            const answer = AppState.newMessage('assistant', Array.from({ length: 35 }, (_, i) => '### 阶段 ' + i + '\n\n已核对需求，等待进一步确认。').join('\n\n'));
            answer.status = 'complete';
            answer.taskList = Array.from({ length: 32 }, (_, i) => ({ id: 'task-' + i,
                title: i === 4 ? '确认产品、设计和交付团队共同参与的下一轮需求评审时间' : ['梳理需求范围', '核对已有资料', '整理风险清单', '准备评审材料'][i % 4],
                status: i < 4 ? 'completed' : i === 4 ? 'waiting' : 'pending',
                note: i === 4 ? '等待负责人确认时间；已完成的准备工作保留，无需重复。' : '根据本次讨论逐项推进。' }));
            chat.messages.push(answer);
            await historyManager.save(chat);
            const other = historyManager.createNewChat();
            await historyManager.save(other);
            historyManager.select(chat.id);
            return { first: chat.id, second: other.id };
        });
        await frame(page);
        await page.evaluate(() => { document.getElementById('chat-container').scrollTop = 300; });
        await page.locator('#task-entry').click();
        const half = await page.locator('#task-panel').boundingBox();
        assert.ok(half.height > 400 && half.height < 530);
        await page.locator('#task-panel-expand').click();
        assert.ok((await page.locator('#task-panel').boundingBox()).height > half.height + 150);
        await page.locator('#task-panel-list').evaluate(node => { node.scrollTop = 420; });
        const before = await page.evaluate(() => ({ chat: document.getElementById('chat-container').scrollTop, list: document.getElementById('task-panel-list').scrollTop }));
        await page.evaluate(() => {
            const chat = AppState.currentChat;
            BrowserView.event(chat, chat.messages.at(-1), { type: 'task-list', items: chat.messages.at(-1).taskList.map((item, i) => i === 31 ? { ...item, note: '收到最新确认' } : item) });
        });
        await frame(page);
        assert.deepEqual(await page.evaluate(() => ({ chat: document.getElementById('chat-container').scrollTop, list: document.getElementById('task-panel-list').scrollTop })), before);
        await page.locator('#task-panel-close').click();
        await page.evaluate(() => document.getElementById('chat-container').scrollTop = 300);
        await page.evaluate(() => {
            const chat = AppState.currentChat;
            BrowserView.event(chat, chat.messages.at(-1), { type: 'task-list', items: chat.messages.at(-1).taskList.map((item, i) => i === 0 ? { ...item, note: '确认完成' } : item) });
        });
        assert.equal(await page.locator('#task-panel').evaluate(node => node.open), false, 'updates must not reopen the panel');
        assert.equal(await page.locator('#chat-container').evaluate(node => node.scrollTop), 300);
        for (const width of [320, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 844 });
            await page.locator('#user-input').focus();
            await page.setViewportSize({ width, height: 410 });
            await frame(page);
            const box = await page.locator('#task-entry').boundingBox();
            assert.ok(box.height >= 44 && box.height <= 46, 'entry remains one line with keyboard-sized viewport');
            assert.ok(box.y >= 0 && box.y + box.height < 410);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            await page.locator('#task-entry').click();
            await frame(page);
            const panel = await page.locator('#task-panel').boundingBox();
            assert.ok(panel.y >= -1 && panel.y + panel.height <= 411);
            assert.equal(await page.locator('#task-panel').evaluate(node => node.scrollWidth > node.clientWidth), false);
            // Native modal traps focus; the composer cannot receive keystrokes behind it.
            for (let i = 0; i < 5; i++) {
                await page.keyboard.press('Tab');
                assert.equal(await page.evaluate(() => document.getElementById('task-panel').contains(document.activeElement)), true);
            }
            await page.keyboard.press('Escape');
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#task-entry').click();
        // Simulate mobile keyboard panning separately from layout-viewport resizing.
        await page.evaluate(() => {
            Object.defineProperty(visualViewport, 'height', { configurable: true, value: 460 });
            Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 96 });
            visualViewport.dispatchEvent(new Event('resize'));
            visualViewport.dispatchEvent(new Event('scroll'));
        });
        await frame(page);
        const panned = await page.locator('#task-panel').boundingBox();
        assert.ok(panned.y >= 96 && Math.abs(panned.y + panned.height - 556) < 2);
        await page.evaluate(() => {
            delete visualViewport.height;
            delete visualViewport.offsetTop;
            visualViewport.dispatchEvent(new Event('resize'));
        });
        await frame(page);
        await page.evaluate(id => historyManager.select(id), ids.second);
        assert.equal(await page.locator('#task-entry').isVisible(), false);
        assert.equal(await page.locator('#task-panel').evaluate(node => node.open), false);
        await page.evaluate(id => historyManager.select(id), ids.first);
        assert.equal(await page.locator('#task-panel').evaluate(node => node.open), true);
        const out = path.resolve(__dirname, '../test-results/task-ui');
        fs.mkdirSync(out, { recursive: true });
        await page.locator('#task-panel-expand').click();
        await page.screenshot({ path: path.join(out, 'mobile-sheet.png') });
        await page.mouse.click(10, 40);
        assert.equal(await page.locator('#task-panel').evaluate(node => node.open), false);
        await page.screenshot({ path: path.join(out, 'mobile-entry.png') });
        await page.locator('#task-entry').click();
        const handle = await page.locator('#task-panel-handle').boundingBox();
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 12);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2, handle.y - 100);
        await page.mouse.up();
        assert.equal(await page.locator('#task-panel').evaluate(node => node.classList.contains('is-expanded')), true);
        await page.keyboard.press('Escape');
        for (const [status, label] of [['aborted', '已暂停'], ['error', '已中断'], ['complete', '等待跟进']]) {
            await page.evaluate(status => { AppState.currentChat.messages.at(-1).status = status; UI.updateControls(); }, status);
            assert.match(await page.locator('#task-entry-label').textContent(), new RegExp(label));
        }
        // Moving to a branch without the snapshot removes the conversation entry.
        await page.evaluate(() => { AppState.currentChat.messages = [AppState.currentChat.messages[0]]; UI.renderChat(); });
        assert.equal(await page.locator('#task-entry').isVisible(), false);
        assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
});

test('invalid or partial task calls stay hidden; stop retains tasks and clearing closes the panel', async () => {
    const s = await setup('task-ui-stop');
    const { page, f } = s;
    let calls = 0, releasePartial, releaseFinal;
    const partial = new Promise(resolve => { releasePartial = resolve; });
    const final = new Promise(resolve => { releaseFinal = resolve; });
    f.state.onCompletion = async (body, res) => {
        calls++;
        if (calls === 1) return complete(res, { tool: 'task_update', args: { items: [{ id: 'bad', title: '不应保存', status: 'made-up' }] } });
        if (calls === 2) return complete(res, { content: '清单未保存。' });
        if (calls === 3) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const event = data => res.write('data: ' + JSON.stringify(data) + '\n\n');
            event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'save-task', type: 'function', function: { name: 'task_update', arguments: '{"items":[' } }] } }] });
            await partial;
            event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"id":"check","title":"核对资料","status":"in_progress"}]}' } }] }, finish_reason: 'tool_calls' }] });
            res.end('data: [DONE]\n\n');
            return true;
        }
        await final;
        return complete(res, { content: '完成。' });
    };
    try {
        await send(page, '无效的待办');
        assert.equal(await page.locator('#task-entry').isVisible(), false);
        await page.locator('#user-input').fill('保存有效的待办，然后执行');
        await page.locator('#send-button').click();
        await page.waitForFunction(() => AppState.currentChat.messages.at(-1)?.processing?.phase === 'tool-call' || AppState.currentChat.messages.at(-1)?.browserTurns?.some(turn => turn.phase === 'tool-call'));
        assert.equal(await page.locator('#task-entry').isVisible(), false, 'partial arguments are not a saved task list');
        releasePartial();
        await page.locator('#task-entry').waitFor({ state: 'visible' });
        assert.match(await page.locator('#task-entry-label').textContent(), /进行中/);
        await page.locator('#stop-button').click();
        await settled(page);
        assert.match(await page.locator('#task-entry-label').textContent(), /已暂停/);
        assert.equal(await page.locator('#send-button').isVisible(), true);
        releaseFinal();
        await page.locator('#task-entry').click();
        await page.evaluate(() => {
            const chat = AppState.currentChat;
            const message = AppState.newMessage('assistant', '已清空待办');
            message.status = 'complete';
            chat.messages.push(message);
            BrowserView.event(chat, message, { type: 'task-list', items: [] });
        });
        assert.equal(await page.locator('#task-entry').isVisible(), false);
        assert.equal(await page.locator('#task-panel').evaluate(node => node.open), false);
        assert.equal(await page.locator('.session-tasks li').count(), 1, 'historical saved list survives clearing');
        assert.deepEqual(s.errors, []);
    } finally { releasePartial(); releaseFinal(); await s.close(); }
});
