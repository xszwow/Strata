const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { fixture } = require('./fixture');

async function main() {
    const f = await fixture({ REQUEST_TIMEOUT_MS: '5000' });
    const browser = await chromium.launch({
        headless: true,
        ...(!fs.existsSync(chromium.executablePath()) ? { channel: 'chrome' } : {})
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const passed = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const check = async (name, fn) => {
        await fn();
        passed.push(name);
        console.log('PASS ' + name);
    };
    const ready = () => page.waitForFunction(() => window.historyManager && Composer.ready);
    const select = async (level) => {
        await page.click('#reasoning-button');
        await page.click('[data-effort="' + level + '"]');
        await page.waitForFunction((value) => !Composer.isOpen() && Composer.effort() === value, level);
    };
    const send = async (text) => {
        const previous = await page.evaluate(() => AppState.currentChat.messages.at(-1)?.id || null);
        await page.fill('#user-input', text);
        await page.click('#send-button');
        await page.waitForFunction(
            previous => !AppState.operations.size && AppState.currentChat.messages.at(-1)?.id !== previous && AppState.currentChat.messages.at(-1)?.status === 'complete',
            previous
        );
    };
    try {
        const user = await f.register('composer-browser');
        f.store.setQuota(user.user.id, 100);
        await page.goto(f.url + '/login.html');
        await page.evaluate((user) => {
            localStorage.setItem('token', user.token);
            localStorage.setItem('user', JSON.stringify(user.user));
        }, user);
        await page.goto(f.url + '/chat.html');
        await ready();
        await check(
            'compact composer starts at one line, grows with text and shrinks after clearing on every screen',
            async () => {
                const out = path.resolve(__dirname, '../test-results/composer');
                fs.mkdirSync(out, { recursive: true });
                for (const width of [319, 390, 767, 768, 1440]) {
                    await page.setViewportSize({ width, height: 604 });
                    await page.fill('#user-input', '一行消息');
                    const expected = width < 768 ? 87 : 88;
                    await page.waitForFunction(
                        (height) =>
                            document.querySelector('.input-container').getBoundingClientRect().height ===
                            height,
                        expected
                    );
                    await page.fill(
                        '#user-input',
                        Array.from({ length: 8 }, (_, i) => '第 ' + i + ' 行').join('\n')
                    );
                    assert((await page.locator('.input-container').boundingBox()).height > expected + 80);
                    await page.fill('#user-input', '');
                    assert.equal((await page.locator('.input-container').boundingBox()).height, expected);
                    for (const selector of ['#upload-btn', '#send-button']) {
                        const rect = await page.locator(selector).boundingBox();
                        assert.equal(rect.width, 32);
                        assert.equal(rect.height, 32);
                        assert.equal((await page.locator(selector + ' svg').boundingBox()).width, 14);
                    }
                    assert.equal((await page.locator('#reasoning-button').boundingBox()).height, 20);
                    assert.equal((await page.locator('#model-button').boundingBox()).height, 22);
                    if (width === 319)
                        await page.screenshot({
                            path: path.join(out, 'compact-mobile.png'),
                            clip: { x: 0, y: 454, width, height: 150 }
                        });
                }
                await page.setViewportSize({ width: 1440, height: 1000 });
            }
        );
        await check('Llama default shows only the bulb, model and compact two-row composer', async () => {
            assert.equal(await page.textContent('#model-name'), 'test-model');
            assert.equal(await page.textContent('#reasoning-label'), '');
            assert(await page.isVisible('#context-button'));
            assert(await page.isDisabled('#send-button'));
            assert.equal((await page.locator('.input-container').boundingBox()).width, 768);
            assert.equal(await page.locator('body > header').count(), 0);
            const input = await page.locator('#user-input').boundingBox();
            const toolbar = await page.locator('.composer-toolbar').boundingBox();
            assert(input.y + input.height <= toolbar.y + 1);
            await page.click('#model-button');
            assert((await page.textContent('#composer-panel')).includes('262,144'));
            assert((await page.textContent('#composer-panel')).includes('不单独限制（受剩余上下文约束）'));
            await page.keyboard.press('Escape');
            assert(await page.locator('#model-button').evaluate((el) => el === document.activeElement));
        });
        await check(
            'only sidebar trigger remains outside chat; quota, settings and new chat stay in sidebar',
            async () => {
                const toggle = await page.locator('#history-btn').boundingBox();
                const glyph = await page.locator('#history-btn svg').boundingBox();
                assert.equal(toggle.width, 36, 'llama desktop navigation button');
                assert.equal(toggle.height, 36);
                assert.equal(glyph.width, 16, 'llama navigation glyph');
                assert.equal(glyph.height, 16);
                assert(await page.isHidden('#free-quota'));
                assert(await page.isHidden('#settings-btn'));
                await page.click('#history-btn');
                await page.waitForSelector('#free-quota', { state: 'visible' });
                assert(await page.isVisible('#free-quota'));
                assert(await page.isVisible('#settings-btn'));
                assert(await page.isVisible('.new-chat-btn'));
                for (const selector of ['.history-close svg', '.danger-btn svg']) {
                    const rect = await page.locator(selector).boundingBox();
                    assert(rect.width >= 18 && rect.height >= 18, selector + ' must be visibly sized');
                }
                await page.click('.new-chat-btn');
                await page.waitForSelector('#free-quota', { state: 'hidden' });
                assert(await page.locator('#history-panel').evaluate((el) => el.inert));
                assert(await page.isHidden('#free-quota'));
                assert.equal(await page.textContent('#reasoning-label'), '');
            }
        );
        await check(
            'desktop reasoning uses nonmodal source-style dropdown; High appears only after selection',
            async () => {
                await page.fill('#user-input', '保留输入');
                await page.click('#reasoning-button');
                assert(
                    await page
                        .locator('#composer-panel')
                        .evaluate((el) => el.matches(':popover-open') && !el.open)
                );
                assert.equal((await page.locator('#composer-panel').boundingBox()).width, 224);
                await page.click('[data-effort="high"]');
                assert.equal(await page.textContent('#reasoning-label'), 'High');
                assert.equal(await page.inputValue('#user-input'), '保留输入');
                await select('default');
                assert.equal(await page.textContent('#reasoning-label'), '');
            }
        );
        const firstChat = await page.evaluate(() => AppState.currentChatId);
        await check(
            'reasoning selection keeps draft and attachment, supports keyboard navigation and persists per chat',
            async () => {
                await page.fill('#user-input', '保留草稿');
                await page.evaluate(() => {
                    AppState.file = { fileName: '项目.xlsx', content: '阶段,预算\n设计,100' };
                    UI.updateControls();
                });
                await page.click('#reasoning-button');
                await page.keyboard.press('End');
                assert.equal(await page.evaluate(() => document.activeElement.dataset.effort), 'max');
                await page.keyboard.press('Enter');
                assert.equal(await page.inputValue('#user-input'), '保留草稿');
                assert.equal(await page.textContent('#attachment-name'), '项目.xlsx');
                await page.evaluate(async () => {
                    await historyManager.persist(AppState.currentChat);
                    historyManager.createNewChat();
                });
                assert.equal(await page.evaluate(() => Composer.effort()), 'default');
                await select('off');
                await page.evaluate((id) => historyManager.select(id), firstChat);
                assert.equal(await page.textContent('#reasoning-label'), 'Max');
                await page.reload();
                await ready();
                assert.equal(await page.textContent('#reasoning-label'), 'Max');
            }
        );
        await check(
            'real usage reaches gauge, is stored on assistant and counts cached input once',
            async () => {
                f.state.statistics = {
                    timings: { prompt_n: 100, cache_n: 200, predicted_n: 40, predicted_per_second: 20 },
                    usage: {
                        prompt_tokens: 300,
                        completion_tokens: 40,
                        prompt_tokens_details: { cached_tokens: 200 }
                    }
                };
                await send('读取上下文');
                assert.equal(f.state.calls.at(-1).body.thinking_budget_tokens, -1);
                assert.equal(f.state.calls.at(-1).body.reasoning_budget_tokens, 0);
                assert.equal(
                    await page.evaluate(() => AppState.currentChat.messages.at(-1).statistics.total),
                    340
                );
                await page.click('#context-button');
                assert((await page.textContent('[data-stat="used"]')).startsWith('340'));
                assert.equal(await page.textContent('[data-stat="prompt"]'), '300');
                assert.equal(await page.textContent('[data-stat="cached"]'), '200');
                assert.equal(await page.textContent('[data-stat="allPrompt"]'), '100');
                await page.keyboard.press('Escape');
                await page.reload();
                await ready();
                assert.equal(await page.evaluate(() => Composer.currentStats().total), 340);
            }
        );
        await check(
            'current and cumulative usage differ and regenerated branches inherit effort',
            async () => {
                f.state.statistics = {
                    usage: {
                        prompt_tokens: 500,
                        completion_tokens: 60,
                        prompt_tokens_details: { cached_tokens: 300 }
                    }
                };
                const previousRing = await page
                    .locator('#context-ring')
                    .evaluate((ring) => ring.style.strokeDashoffset);
                f.state.delay = 800;
                await page.fill('#user-input', '第二次请求');
                await page.click('#send-button');
                await page.waitForFunction(() => AppState.operations.size > 0);
                assert.equal(await page.evaluate(() => Composer.currentStats().total), undefined);
                assert.equal(
                    await page.locator('#context-ring').evaluate((ring) => ring.style.strokeDashoffset),
                    previousRing
                );
                assert((await page.getAttribute('#context-button', 'title')).includes('本轮统计中'));
                await page.click('#context-button');
                assert((await page.textContent('[data-stat="used"]')).startsWith('340'));
                assert((await page.textContent('.composer-panel-note')).includes('上次已确认'));
                assert.equal(await page.textContent('[data-stat="prompt"]'), '未提供');
                await page.keyboard.press('Escape');
                await page.waitForFunction(() => !AppState.operations.size);
                f.state.delay = 0;
                assert(!(await page.getAttribute('#context-button', 'title')).includes('上次已确认'));
                await page.click('#context-button');
                assert((await page.textContent('[data-stat="used"]')).startsWith('560'));
                assert.equal(await page.textContent('[data-stat="allOutput"]'), '100');
                assert.equal(await page.textContent('[data-stat="allCached"]'), '500');
                await page.keyboard.press('Escape');
                await page.evaluate(async () => {
                    const chat = AppState.currentChat;
                    await regenerateMessage(chat.id, chat.messages[1].id);
                });
                assert.equal(await page.evaluate(() => AppState.currentChatId), firstChat);
                assert.equal(await page.evaluate(() => AppState.currentChat.messages.length), 2);
                assert.equal(await page.textContent('#reasoning-label'), 'Max');
                assert.equal(f.state.calls.at(-1).body.thinking_budget_tokens, -1);
                await page.evaluate(() => historyManager.createNewChat());
                assert.equal(await page.evaluate(() => Composer.currentStats().total), undefined);
            }
        );
        await check('attachment chip previews, removes and enables sending without typed text', async () => {
            await page.fill('#user-input', '');
            await page.evaluate(() => {
                AppState.file = { fileName: '预算.xlsx', content: '阶段,预算\n设计,100' };
                UI.updateControls();
            });
            assert(!(await page.isDisabled('#send-button')));
            await page.click('#preview-btn');
            assert((await page.textContent('.file-preview-content')).includes('预算.xlsx'));
            await page.click('.file-preview-close');
            await page.click('#remove-file-button');
            assert(await page.isHidden('#composer-attachment'));
            assert(await page.isDisabled('#send-button'));
            await page.evaluate(() => {
                AppState.file = { fileName: '预算.xlsx', content: '阶段,预算\n设计,100' };
                UI.updateControls();
            });
            await send('');
            assert(f.state.calls.at(-1).body.messages.at(-1).content.includes('设计,100'));
            assert(await page.isHidden('#composer-attachment'));
        });
        await check(
            '320/390/768/1440px controls stay inside composer with long model name and Max selected',
            async () => {
                await select('max');
                await page.evaluate(() => {
                    Composer.model.id = 'qwen3.8-flash-next-iq4-xs-very-long-model-name';
                    Composer.update();
                });
                for (const width of [320, 390, 768, 1440]) {
                    await page.setViewportSize({ width, height: 900 });
                    const boxes = await page.evaluate(() => {
                        const box = document.querySelector('.input-container').getBoundingClientRect();
                        const tools = [...document.querySelectorAll('.composer-toolbar button')]
                            .filter((el) => el.offsetWidth)
                            .map((el) => ({
                                id: el.id,
                                left: el.getBoundingClientRect().left,
                                right: el.getBoundingClientRect().right
                            }));
                        return {
                            left: box.left,
                            right: box.right,
                            tools,
                            scroll: document.documentElement.scrollWidth,
                            width: innerWidth
                        };
                    });
                    assert(boxes.scroll <= width);
                    for (const button of boxes.tools) {
                        assert(button.left >= boxes.left, button.id + ' left ' + width);
                        assert(button.right <= boxes.right, button.id + ' right ' + width);
                    }
                    assert((await page.locator('#model-name').boundingBox()).width > 16);
                }
                await page.click('#model-button');
                assert((await page.textContent('.composer-model-id')).includes('very-long-model-name'));
                await page.keyboard.press('Escape');
            }
        );
        await check(
            'phone reasoning opens a reachable bottom sheet and desktop panel stays on screen',
            async () => {
                for (const [width, height] of [
                    [390, 844],
                    [320, 440],
                    [1440, 1000]
                ]) {
                    await page.setViewportSize({ width, height });
                    await page.click('#reasoning-button');
                    const rect = await page.locator('#composer-panel').boundingBox();
                    assert(rect.x >= 0 && rect.y >= 0);
                    assert(rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1);
                    if (width < 768) {
                        assert(Math.abs(rect.y + rect.height - height) <= 1);
                        assert((await page.locator('[data-effort="max"]').boundingBox()).height >= 44);
                    }
                    await page.keyboard.press('Escape');
                    assert(
                        await page
                            .locator('#reasoning-button')
                            .evaluate((el) => el === document.activeElement)
                    );
                }
            }
        );
        await check(
            'new request does not reuse previous metrics; stop and background chat isolation still work',
            async () => {
                const chatId = await page.evaluate(() => AppState.currentChatId);
                await page.fill('#user-input', 'slow');
                await page.click('#send-button');
                await page.waitForFunction(() =>
                    AppState.currentChat.messages.at(-1).content.includes('第一段')
                );
                assert.equal(await page.evaluate(() => Composer.currentStats().total), undefined);
                await page.evaluate(() => historyManager.createNewChat());
                assert.equal(await page.evaluate(() => Composer.currentStats().total), undefined);
                await select('low');
                await page.evaluate((id) => historyManager.select(id), chatId);
                assert.equal(await page.textContent('#reasoning-label'), 'Max');
                await page.click('#stop-button');
                await page.waitForFunction(() => !AppState.operations.size);
                assert.equal(
                    await page.evaluate(() => AppState.currentChat.messages.at(-1).status),
                    'aborted'
                );
            }
        );
        assert.deepEqual(errors, []);
        const out = path.resolve(__dirname, '../test-results/composer');
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed, errors }, null, 2));
        console.log(passed.length + ' composer browser checks passed');
    } finally {
        await browser.close();
        await f.close();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
