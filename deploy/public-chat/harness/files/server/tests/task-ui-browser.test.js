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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
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
        if (calls === 6) return complete(res, { tool: 'task_update', args: { items } });
        return complete(res, { content: '已处理，请查看本次会话待办。' });
    };
    try {
        assert.equal(await page.locator('#task-entry').isVisible(), false);
        await send(page, '记录采购任务');
        assert.equal(await page.locator('#task-entry-label').textContent(), '1/3 · 等待跟进 · 确认采购预算');
        assert.equal(await page.locator('#task-panel').isVisible(), false);
        await page.locator('#task-entry').click();
        assert.equal(await page.locator('#task-panel-list li').count(), 3);
        assert.ok((await page.locator('#task-panel').boundingBox()).height < 310, 'short lists use content height');
        assert.equal(await page.locator('#task-entry-action').textContent(), '收起');
        assert.equal(await page.locator('#task-entry').getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('#task-entry').evaluate(node => node === document.activeElement), true);
        await page.waitForFunction(async () => (await historyManager.db.get('chats', [historyManager.userId, AppState.currentChat.id])).taskPanel?.open);
        await page.reload();
        await ready(page);
        await page.waitForFunction(() => !document.getElementById('task-panel').hidden);
        assert.equal(calls, 2, 'opening and restoring the panel never executes a model/tool call');
        await page.locator('#task-entry').click();
        assert.equal(await page.locator('#task-entry').evaluate(node => node === document.activeElement), true);
        await page.locator('#task-entry').click();
        await send(page, '预算已确认，全部完成');
        assert.equal(await page.locator('#task-panel').isVisible(), true, 'the next question can be sent while the list is open');
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
        await send(page, '开始下一份采购计划');
        assert.equal(await page.locator('#task-entry').isVisible(), true);
        assert.equal(await page.locator('#task-panel').isVisible(), false, 'new plan must not inherit the completed plan expansion');
        assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
});

test('one task card expands upward with a fixed toggle, usable composer, and isolated conversations', async () => {
    const s = await setup('task-ui-layout');
    const { page } = s;
    const positions = () => page.evaluate(() => {
        const rect = id => {
            const r = document.getElementById(id).getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return { entry: rect('task-entry'), input: rect('user-input'), chatScroll: document.getElementById('chat-container').scrollTop };
    });
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
        const initial = await positions();
        const compact = await page.locator('#task-card').boundingBox();
        await page.locator('#task-entry').click();
        await frame(page);
        assert.deepEqual(await positions(), initial, 'opening upward must not move the trigger, composer or reading position');
        const panel = await page.locator('#task-panel').boundingBox();
        assert.ok(panel.y < initial.entry.y && Math.abs(panel.y + panel.height - initial.entry.y) < 1, 'list and progress row meet with no gap');
        const card = await page.locator('#task-card').boundingBox();
        assert.equal(card.x, compact.x);
        assert.equal(card.width, compact.width);
        assert.equal(card.y + card.height, compact.y + compact.height, 'the same card grows upward from its fixed bottom edge');
        assert.ok(card.y < compact.y && Math.abs(card.height - compact.height - panel.height) < 1);
        const front = await page.locator('.input-container').boundingBox();
        const overlap = card.y + card.height - front.y;
        assert.ok(overlap >= 30 && overlap <= 34, 'front input covers only the padded lower portion of the smaller back card');
        assert.ok(card.width < front.width - 20, 'back card is visibly narrower than the original input');
        assert.ok(initial.entry.y + initial.entry.height <= front.y, 'progress and toggle stay clear of the front input');
        assert.equal(await page.locator('.input-container').evaluate(node => getComputedStyle(node).borderRadius), '32px');
        assert.equal(await page.locator('.input-container > #user-input').count(), 1, 'original input structure remains intact');
        assert.equal(await page.locator('#task-card > #task-entry').count(), 1);
        assert.equal(await page.locator('#task-card > #task-panel').count(), 1);
        // Text sizing is a layout input, not a duplicated fixed-height spacer.
        await page.locator('#task-entry').evaluate(node => {
            node.style.fontSize = '24px'; node.style.lineHeight = '36px';
        });
        await frame(page);
        const largerEntry = await page.locator('#task-entry').boundingBox();
        const inputBox = await page.locator('#user-input').boundingBox();
        assert.ok(largerEntry.height > initial.entry.height && largerEntry.y + largerEntry.height < inputBox.y);
        assert.ok((await page.locator('#conversation-tasks').boundingBox()).height >= largerEntry.height, 'normal flow must reserve the actual control height');
        await page.locator('#task-entry').evaluate(node => { node.style.removeProperty('font-size'); node.style.removeProperty('line-height'); });
        await frame(page);
        assert.equal(await page.locator('#conversation-tasks button').count(), 1, 'only one expand/collapse control');
        assert.equal(await page.locator('#task-panel').evaluate(node => node.tagName), 'SECTION');
        assert.equal(await page.locator(':modal').count(), 0);
        await page.locator('#task-panel-list').evaluate(node => { node.scrollTop = 420; });
        const before = await page.locator('#task-panel-list').evaluate(node => node.scrollTop);
        await page.evaluate(() => {
            const chat = AppState.currentChat;
            BrowserView.event(chat, chat.messages.at(-1), { type: 'task-list', items: chat.messages.at(-1).taskList.map((item, i) => i === 31 ? { ...item, note: '收到最新确认' } : item) });
        });
        assert.equal(await page.locator('#task-panel-list').evaluate(node => node.scrollTop), before);
        assert.deepEqual(await positions(), initial);
        await page.locator('#user-input').fill('可以一边查看任务，一边继续输入');
        assert.equal(await page.locator('#task-panel').isVisible(), true, 'typing outside the list does not close it');
        assert.equal(await page.locator('#send-button').isEnabled(), true);
        await page.locator('#user-input').fill('');
        await page.locator('#task-entry').focus();
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#task-panel-list').evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#user-input').evaluate(node => node === document.activeElement), true, 'no modal focus trap');
        await page.locator('#task-entry').click();
        assert.equal(await page.locator('#task-entry-action').textContent(), '展开');
        await page.evaluate(() => {
            const chat = AppState.currentChat;
            BrowserView.event(chat, chat.messages.at(-1), { type: 'task-list', items: chat.messages.at(-1).taskList.map((item, i) => i === 0 ? { ...item, note: '确认完成' } : item) });
        });
        assert.equal(await page.locator('#task-panel').isVisible(), false, 'updates must not reopen the list');
        await page.locator('#task-entry').click();
        assert.equal(await page.locator('#task-panel-list').evaluate(node => node.scrollTop), before, 'collapse and updates retain list position');
        await page.locator('#task-entry').click();
        for (const width of [320, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 410 });
            await page.waitForFunction(() => Math.abs(document.body.getBoundingClientRect().height - visualViewport.height) < 1);
            await frame(page);
            const closed = await positions();
            assert.ok(closed.entry.height >= 30 && closed.entry.height <= 32);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            await page.locator('#task-entry').click();
            await frame(page);
            assert.deepEqual(await positions(), closed);
            const bounds = await page.locator('#task-panel').boundingBox();
            assert.ok(bounds.y >= 0 && Math.abs(bounds.y + bounds.height - closed.entry.y) < 1);
            assert.equal(await page.locator('#task-panel').evaluate(node => node.scrollWidth > node.clientWidth), false);
            await page.locator('#user-input').fill('line\n'.repeat(8));
            await page.locator('#user-input').dispatchEvent('input');
            await frame(page);
            const multiline = await page.locator('#task-panel').boundingBox();
            assert.ok(multiline.y >= 0, 'multiline composer leaves the list in the available space');
            await page.locator('#user-input').fill('');
            await page.locator('#task-entry').click();
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#task-entry').click();
        await page.evaluate(() => {
            Object.defineProperty(visualViewport, 'height', { configurable: true, value: 460 });
            Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 96 });
            visualViewport.dispatchEvent(new Event('resize'));
            visualViewport.dispatchEvent(new Event('scroll'));
        });
        await frame(page);
        const panned = await page.locator('#task-panel').boundingBox();
        const entry = await page.locator('#task-entry').boundingBox();
        assert.ok(panned.y >= 96 && Math.abs(panned.y + panned.height - entry.y) < 1);
        await page.evaluate(() => {
            delete visualViewport.height;
            delete visualViewport.offsetTop;
            visualViewport.dispatchEvent(new Event('resize'));
        });
        await frame(page);
        await page.evaluate(id => historyManager.select(id), ids.second);
        assert.equal(await page.locator('#task-entry').isVisible(), false);
        assert.equal(await page.locator('#task-panel').isVisible(), false);
        await page.evaluate(id => historyManager.select(id), ids.first);
        assert.equal(await page.locator('#task-panel').isVisible(), true);
        // Preferences from the retired half/full-screen UI migrate to just open/closed.
        await page.evaluate(async () => {
            await historyManager.db.put('chats', { ...structuredClone(AppState.currentChat), taskPanel: { open: true, expanded: true } });
        });
        await page.reload();
        await ready(page);
        assert.equal(await page.locator('#task-panel').isVisible(), true);
        const preferences = await page.evaluate(() => AppState.currentChat.taskPanel);
        assert.equal(preferences.open, true);
        assert.equal(typeof preferences.scope, 'string');
        assert.equal(Object.hasOwn(preferences, 'expanded'), false);
        const readOnly = await page.evaluate(async () => {
            const chat = AppState.currentChat;
            const before = JSON.stringify(await historyManager.db.get('chats', [historyManager.userId, chat.id]));
            for (let i = 0; i < 5; i++) { UI.updateControls(); TaskView.refresh(); }
            const after = JSON.stringify(await historyManager.db.get('chats', [historyManager.userId, chat.id]));
            return { unchanged: before === after, rawLegacyPreference: JSON.parse(after).taskPanel };
        });
        assert.equal(readOnly.unchanged, true, 'rendering cannot rewrite IndexedDB or timestamps');
        assert.deepEqual(readOnly.rawLegacyPreference, { open: true, expanded: true });
        const out = path.resolve(__dirname, '../test-results/task-ui');
        fs.mkdirSync(out, { recursive: true });
        await page.screenshot({ path: path.join(out, 'mobile-expanded.png') });
        await page.locator('#task-panel-list').focus();
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#task-entry').evaluate(node => node === document.activeElement), true);
        await page.screenshot({ path: path.join(out, 'mobile-entry.png') });
        for (const [status, label] of [['aborted', '已暂停'], ['error', '已中断'], ['complete', '等待跟进']]) {
            await page.evaluate(status => { AppState.currentChat.messages.at(-1).status = status; UI.updateControls(); }, status);
            assert.match(await page.locator('#task-entry-label').textContent(), new RegExp(label));
        }
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
        await page.locator('#task-entry').click();
        await page.locator('#stop-button').click();
        await settled(page);
        assert.match(await page.locator('#task-entry-label').textContent(), /已暂停/);
        assert.equal(await page.locator('#send-button').isVisible(), true);
        releaseFinal();
        assert.equal(await page.locator('#task-panel').isVisible(), true, 'stop stays accessible while the list is open');
        await page.evaluate(() => {
            const chat = AppState.currentChat;
            const message = AppState.newMessage('assistant', '已清空待办');
            message.status = 'complete';
            chat.messages.push(message);
            BrowserView.event(chat, message, { type: 'task-list', items: [] });
        });
        assert.equal(await page.locator('#task-entry').isVisible(), false);
        assert.equal(await page.locator('#task-panel').isVisible(), false);
        assert.equal(await page.locator('.session-tasks li').count(), 1, 'historical saved list survives clearing');
        assert.deepEqual(s.errors, []);
    } finally { releasePartial(); releaseFinal(); await s.close(); }
});
