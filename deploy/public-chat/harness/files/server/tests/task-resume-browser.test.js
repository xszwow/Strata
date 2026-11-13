const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('playwright');
const {browserFixture, complete} = require('./browser-fixture');

test('closing before compaction or after a write resumes the same task and never repeats the write', async () => {
    const f = await browserFixture();
    const browser = await chromium.launch({headless:true,
        ...(!fs.existsSync(chromium.executablePath()) ? {channel:'chrome'} : {})});
    const context = await browser.newContext();
    const item = {id:'audit',title:'核对仓库记录',status:'waiting',note:'批号 MX-219，等待入库核验'};
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    try {
        const user = await f.register('task-reload');
        await context.addInitScript(user => {
            localStorage.setItem('token',user.token);
            localStorage.setItem('user',JSON.stringify(user.user));
        },user);
        const open = async () => {
            const page = await context.newPage();
            await page.goto(f.url + '/chat.html');
            await page.waitForFunction(() => AppState.historyReady && Composer.ready);
            return page;
        };
        let page = await open();
        await page.evaluate(async () => {
            const chat = AppState.currentChat;
            for (let i=0; i<110; i++) chat.messages.push(AppState.newMessage('user','问题 '+i),AppState.newMessage('assistant','答复 '+i));
            await historyManager.save(chat);
            const save = historyManager.save.bind(historyManager);
            historyManager.save = async chat => {
                await save(chat);
                if (chat.messages.at(-1)?.generation?.phase === 'prepared') {
                    window.preparedSaved = true;
                    await new Promise(() => {});
                }
            };
        });
        await page.fill('#user-input','核对记录并保存进度');
        await page.click('#send-button');
        await page.waitForFunction(() => window.preparedSaved);
        assert.equal(f.state.calls.length,0);
        await page.close();
        let turn = 0;
        f.state.onCompletion = async (body,res) => {
            switch (turn++) {
                case 0:
                    assert(body.messages.some(m => String(m.content).includes('历史摘要')));
                    assert(body.messages.some(m => m.content === '核对记录并保存进度'));
                    return complete(res,{tool:'task_update',args:{items:[item]}});
                case 1: return complete(res,{tool:'browser_click',args:{ref:'e1'}});
                case 2: await wait; return complete(res,{content:'保留核对进度'});
                default: return complete(res,{content:'已读到原待办'});
            }
        };
        page = await open();
        await page.waitForFunction(() => AppState.currentChat.messages.at(-1)?.taskList?.[0]?.id === 'audit');
        await page.waitForFunction(() => AppState.currentChat.messages.at(-1)?.browserSteps?.some(s=>s.name==='browser_click' && s.status==='complete'));
        await page.close();
        release();
        page = await open();
        await page.waitForFunction(() => AppState.currentChat.messages.at(-1)?.status === 'complete' && !AppState.operations.size);
        assert.deepEqual(await page.evaluate(()=>AppState.currentChat.messages.at(-1).taskList),[item]);
        const panel = page.locator('.session-tasks').last();
        await panel.locator('summary').click();
        assert.match(await panel.innerText(),/MX-219/);
        await page.setViewportSize({width:390,height:844});
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({path:require('node:path').join(__dirname,'../test-results/task-list-mobile.png')});
        assert.equal(turn,3);
        assert.equal(f.bridge.calls.filter(c=>c.tool==='browser_click').length,1);
        await page.fill('#user-input','下一步是什么？');
        await page.click('#send-button');
        await page.waitForFunction(() => AppState.currentChat.messages.at(-1)?.content==='已读到原待办' && !AppState.operations.size);
        assert.match(JSON.stringify(f.state.calls.at(-1).body.messages),/批号 MX-219/);
        // A worker can restart after committing tasks but before the browser
        // receives them. Reopen its SQLite store and recover through HTTP 410.
        const conversationId = await page.evaluate(async () => {
            const chat=historyManager.createNewChat();
            chat.messages.push(AppState.newMessage('user','待办保存后断线'));
            const reply=AppState.newMessage('assistant','');
            reply.generation={id:'expired-worker',pending:true,phase:'dispatched'};
            reply.status='streaming';
            chat.messages.push(reply);
            await historyManager.save(chat);
            return chat.id;
        });
        const {Store}=require('../db');
        const restored=new Store(f.config.dbPath);
        restored.saveTasks({userId:user.user.id,conversationId},'expired-worker',[item]);
        restored.close();
        await page.close();
        const beforeRestart=f.state.calls.length;
        page=await open();
        await page.waitForFunction(() => AppState.currentChat.messages.at(-1)?.status==='error' && !AppState.operations.size);
        assert.deepEqual(await page.evaluate(()=>AppState.currentChat.messages.at(-1).taskList),[item]);
        assert.equal(f.state.calls.length,beforeRestart,'Expired stream recovery must not rerun the model or browser');
        await page.close();
        page=await open();
        assert.deepEqual(await page.evaluate(()=>AppState.currentChat.messages.at(-1).taskList),[item]);
    } finally { release(); await browser.close(); await f.close(); }
});
