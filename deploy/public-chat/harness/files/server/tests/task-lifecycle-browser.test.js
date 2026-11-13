const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { browserFixture, complete } = require('./browser-fixture');

const launch = { headless: true,
    ...(!fs.existsSync(chromium.executablePath()) ? { channel: 'chrome' } : {}) };
const ready = page => page.waitForFunction(() => AppState.historyReady && Composer.ready);
const snapshot = page => page.evaluate(async () =>
    JSON.stringify(await historyManager.db.getAllFromIndex('chats', 'userId', historyManager.userId)));
async function authorize(context, user) {
    assert.ok(user.token && user.user, 'fixture registration must succeed');
    await context.addInitScript(user => {
        localStorage.setItem('token', user.token);
        localStorage.setItem('user', JSON.stringify(user.user));
    }, user);
}
async function open(context, url) {
    const page = await context.newPage();
    await page.goto(url + '/chat.html');
    await ready(page);
    return page;
}
async function seed(page) {
    return page.evaluate(async () => {
        const ids = {};
        for (const name of ['A', 'B', 'Empty']) {
            const chat = historyManager.createNewChat(false);
            chat.title = '边界验收 ' + name;
            chat.messages.push(AppState.newMessage('user', chat.title));
            const answer = AppState.newMessage('assistant', '已保存 ' + name);
            answer.status = 'complete';
            if (name !== 'Empty') answer.taskList = Array.from({ length: 20 }, (_, i) => ({
                // Intentionally shared task IDs: ownership must come from the conversation.
                id: 'item-' + i, title: name + ' 的事项 ' + i,
                status: i === 0 ? 'waiting' : 'pending', note: name + ' 的独立备注',
            }));
            chat.messages.push(answer);
            await historyManager.save(chat);
            ids[name] = chat.id;
        }
        historyManager.select(ids.A);
        return ids;
    });
}
async function select(page, name) {
    await page.locator('#history-btn').click();
    await page.getByRole('button', { name: '边界验收 ' + name, exact: true }).click();
}

test('history navigation isolates identical task IDs, disclosure and scrolling; reads never rewrite records', { timeout: 40000 }, async () => {
    const f = await browserFixture();
    const browser = await chromium.launch(launch);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
        await authorize(context, await f.register('task-history'));
        const page = await open(context, f.url);
        const ids = await seed(page);
        await page.locator('#task-entry').click();
        await page.locator('#task-panel-list').evaluate(node => { node.scrollTop = 160; });
        const scroll = await page.locator('#task-panel-list').evaluate(node => node.scrollTop);
        await select(page, 'B');
        assert.equal(await page.locator('#task-panel').isVisible(), false);
        await page.locator('#task-entry').click();
        assert.match(await page.locator('#task-panel-list').textContent(), /B 的事项/);
        assert.doesNotMatch(await page.locator('#task-panel-list').textContent(), /A 的事项/);
        assert.equal(await page.locator('#task-panel-list').evaluate(node => node.scrollTop), 0);
        await page.locator('#task-entry').click();
        await page.waitForFunction(async id => (await historyManager.db.get('chats', [historyManager.userId, id])).taskPanel?.open === false, ids.B);
        const before = await snapshot(page);
        await select(page, 'A');
        assert.equal(await page.locator('#task-panel').isVisible(), true);
        assert.equal(await page.locator('#task-panel-list').evaluate(node => node.scrollTop), scroll);
        await page.locator('.session-tasks summary').click();
        assert.match(await page.locator('.session-tasks').textContent(), /A 的独立备注/);
        assert.doesNotMatch(await page.locator('.session-tasks').textContent(), /B 的独立备注/);
        await select(page, 'Empty');
        assert.equal(await page.locator('#conversation-tasks').isVisible(), false);
        await page.reload();
        await ready(page);
        assert.equal(await page.evaluate(() => AppState.currentChatId), ids.Empty);
        assert.equal(await page.locator('#conversation-tasks').isVisible(), false);
        await select(page, 'A');
        assert.equal(await page.locator('#task-panel').isVisible(), true);
        await select(page, 'B');
        assert.equal(await page.locator('#task-panel').isVisible(), false);
        assert.equal(await snapshot(page), before, 'history viewing, selecting and reload must not change saved snapshots or timestamps');
        assert.equal(f.state.calls.length, 0, 'reading history must not run the model or tools');
        await page.locator('#history-btn').click();
        await page.getByRole('button', { name: '删除会话：边界验收 B', exact: true }).click();
        await page.waitForFunction(id => !AppState.chats.has(id), ids.B);
        await page.reload();
        await ready(page);
        assert.equal(await page.evaluate(id => AppState.chats.has(id), ids.B), false);
        assert.doesNotMatch(await page.locator('#task-entry-label').textContent(), /B 的事项/);
    } finally { await browser.close(); await f.close(); }
});

test('renderer crash and full browser restart restore committed tasks and both disclosure states from disk', { timeout: 60000 }, async () => {
    const f = await browserFixture();
    const profile = path.join(f.directory, 'browser-profile');
    let context;
    const start = () => chromium.launchPersistentContext(profile, { ...launch, viewport: { width: 390, height: 844 } });
    try {
        context = await start();
        await authorize(context, await f.register('task-restart'));
        let page = await open(context, f.url);
        const ids = await seed(page);
        await page.locator('#task-entry').click();
        await page.waitForFunction(async () => (await historyManager.db.get('chats', [historyManager.userId, AppState.currentChatId])).taskPanel?.open);
        const saved = await snapshot(page);
        const session = await context.newCDPSession(page);
        const crashed = page.waitForEvent('crash');
        void session.send('Page.crash').catch(() => {});
        await crashed;
        await context.close();
        context = await start();
        // No injected auth or state on relaunch: use the same real browser profile.
        page = await open(context, f.url);
        assert.equal(await page.evaluate(() => AppState.currentChatId), ids.A);
        assert.equal(await page.locator('#task-panel').isVisible(), true);
        assert.equal(await page.locator('#task-panel-list li').count(), 20);
        assert.equal(await snapshot(page), saved);
        await page.locator('#task-entry').click();
        // Immediate reload after the user command, without explicitly awaiting its DB write.
        await page.reload();
        await ready(page);
        assert.equal(await page.locator('#task-panel').isVisible(), false);
        await context.close();
        context = await start();
        page = await open(context, f.url);
        assert.equal(await page.locator('#task-panel').isVisible(), false);
        assert.match(await page.locator('#task-entry-label').textContent(), /A 的事项/);
        assert.equal(f.state.calls.length, 0);
    } finally { await context?.close(); await f.close(); }
});

test('background task updates survive closing and reopening the page without leaking into the selected conversation or replaying a tool', { timeout: 45000 }, async () => {
    const f = await browserFixture({ REQUEST_TIMEOUT_MS: '30000' });
    const browser = await chromium.launch(launch);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const item = { id: 'item-0', title: 'A 后台任务', status: 'waiting', note: '保留到下次继续' };
    f.state.onCompletion = async (body, res) => {
        if (++calls === 1) { await gate; return complete(res, { tool: 'task_update', args: { items: [item] } }); }
        return complete(res, { content: '后台已保存' });
    };
    try {
        await authorize(context, await f.register('task-background'));
        let page = await open(context, f.url);
        const ids = await seed(page);
        await page.fill('#user-input', '后台保存一个任务');
        await page.click('#send-button');
        await page.waitForFunction(() => AppState.currentChat.messages.at(-1)?.generation?.phase === 'dispatched');
        await select(page, 'B');
        const bRecord = await page.evaluate(async () => JSON.stringify(await historyManager.db.get('chats', [historyManager.userId, AppState.currentChatId])));
        await page.close();
        release();
        page = await open(context, f.url);
        await page.waitForFunction(id => AppState.chats.get(id).messages.at(-1)?.status === 'complete' && !AppState.operations.size, ids.A);
        assert.equal(await page.evaluate(() => AppState.currentChatId), ids.B);
        assert.equal(await page.locator('#task-panel').isVisible(), false);
        assert.match(await page.locator('#task-entry-label').textContent(), /B 的事项/);
        assert.doesNotMatch(await page.locator('#task-entry-label').textContent(), /A 后台任务/);
        assert.equal(await page.evaluate(async () => JSON.stringify(await historyManager.db.get('chats', [historyManager.userId, AppState.currentChatId]))), bRecord);
        await select(page, 'A');
        assert.match(await page.locator('#task-entry-label').textContent(), /A 后台任务/);
        await page.locator('#task-entry').click();
        assert.match(await page.locator('#task-panel-list').textContent(), /保留到下次继续/);
        await page.reload();
        await ready(page);
        assert.equal(await page.locator('#task-panel').isVisible(), true);
        assert.equal(calls, 2, 'one task tool call plus its answer, with no replayed model generation');
        assert.equal(f.bridge.calls.length, 0);
    } finally { release(); await browser.close(); await f.close(); }
});
