const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
const {browserFixture,complete}=require('./browser-fixture');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function finish(res,content){res.end('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
async function until(check){for(let n=0;n<200;n++){if(check())return;await delay(10);}throw Error('Missing test state');}
async function setup(t){
    const f=await browserFixture({REQUEST_TIMEOUT_MS:'20000',BROWSER_REQUEST_TIMEOUT_MS:'20000'});
    const browser=await chromium.launch({headless:true,...(!fs.existsSync(chromium.executablePath())?{channel:'chrome'}:{})});
    const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),requests=[],errors=[];
    context.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/chat/'))requests.push({path:url.pathname,url:request.url(),method:request.method()});});
    page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
    const user=await f.register();await page.goto(f.url+'/login.html');
    await page.evaluate(user=>{localStorage.setItem('token',user.token);localStorage.setItem('user',JSON.stringify(user.user));},user);
    await page.goto(f.url+'/chat.html');await page.waitForFunction(()=>AppState.historyReady&&Composer.ready);
    t.after(async()=>{await browser.close();await f.close();});
    return {f,browser,context,page,user,requests,errors};
}

test('mobile reload and leaving the page recover the original generation and tool result without a second action', {timeout:40000}, async t=>{
    const {f,page,user,requests,errors}=await setup(t);let final,turn=0;
    f.state.onCompletion=async(_,res)=>{
        if(turn++===0)return complete(res,{tool:'browser_click',args:{ref:'e1'},id:'one-local-click'});
        final=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return true;
    };
    await page.fill('#user-input','手机重载恢复测试');await page.click('#send-button');
    await page.waitForSelector('.browser-step[data-state="complete"]');await until(()=>final);
    const identity=await page.evaluate(()=>({chat:AppState.currentChatId,message:AppState.currentChat.messages.at(-1).id,generation:AppState.currentChat.messages.at(-1).generation.id}));
    await page.reload();await page.waitForFunction(()=>AppState.operations.size===1);
    await page.waitForSelector('.browser-step[data-state="complete"]');
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).generation.id),identity.generation);
    assert.equal(f.bridge.calls.length,1);assert.equal(f.bridge.finishes,0);
    assert.equal(requests.filter(r=>r.path==='/api/chat/cancel').length,0);
    await page.goto(f.url+'/settings.html');
    finish(final,'原任务唯一结果🌻');final=null;
    await page.goto(f.url+'/chat.html');await page.waitForFunction(()=>AppState.historyReady&&AppState.currentChat.messages.at(-1)?.status==='complete');
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).content),'原任务唯一结果🌻');
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).generation.pending),false);
    assert.equal(requests.filter(r=>r.path==='/api/chat/completions').length,1);
    assert.equal(f.bridge.calls.length,1);assert.equal(f.state.calls.length,2);
    assert.equal(f.store.getUser(user.user.id).free_messages,99);assert.deepEqual(errors,[]);
});

test('offline beyond the old retry budget, switching chats, and online recovery preserve the same task', {timeout:40000}, async t=>{
    const {f,page,context,requests,errors}=await setup(t);let final,turn=0;
    await page.evaluate(()=>{
        ApiClient.retryDelays=[15,20];ApiClient.reconnectWindowMs=40;ApiClient.streamIdleTimeoutMs=80;
        const original=window.fetch;window.__dropStreams=[];
        window.fetch=async(url,options)=>{
            const response=await original(url,options),path=new URL(url,location.href).pathname;
            if(!['/api/chat/completions','/api/chat/stream'].includes(path)||!response.ok)return response;
            const reader=response.body.getReader();let ended=false;
            return new Response(new ReadableStream({
                start(controller){window.__dropStreams.push(()=>{if(!ended){ended=true;controller.error(new TypeError('Simulated disconnect'));void reader.cancel();}});},
                async pull(controller){try{const chunk=await reader.read();if(ended)return;if(chunk.done){ended=true;controller.close();}else controller.enqueue(chunk.value);}catch(error){if(!ended){ended=true;controller.error(error);}}},
                cancel(){ended=true;return reader.cancel();}
            }),{status:response.status,headers:response.headers});
        };
    });
    f.state.onCompletion=async(_,res)=>{
        if(turn++===0)return complete(res,{tool:'browser_click',args:{ref:'e1'},id:'offline-once'});
        final=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return true;
    };
    await page.fill('#user-input','离线切换会话测试');await page.click('#send-button');await until(()=>final);
    await page.waitForSelector('.browser-step[data-state="complete"]');
    const identity=await page.evaluate(()=>({chat:AppState.currentChatId,generation:AppState.currentChat.messages.at(-1).generation.id}));
    await context.setOffline(true);await page.evaluate(()=>window.__dropStreams.forEach(drop=>drop()));
    await page.evaluate(chat=>{historyManager.createNewChat();historyManager.select(chat);},identity.chat);
    await delay(350); // More than the configured old recovery window and retry count.
    assert.equal(await page.evaluate(()=>AppState.operations.size),1);
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).status),'streaming');
    assert.equal(f.bridge.calls.length,1);assert.equal(f.bridge.finishes,0);
    finish(final,'断网任务恢复结果🌻');final=null;
    await context.setOffline(false);await page.evaluate(()=>dispatchEvent(new Event('online')));
    await page.waitForFunction(()=>!AppState.operations.size&&AppState.currentChat.messages.at(-1)?.status==='complete');
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).content),'断网任务恢复结果🌻');
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).generation.id),identity.generation);
    assert.equal(requests.filter(r=>r.path==='/api/chat/completions').length,1);
    assert.equal(f.bridge.calls.length,1);assert.equal(f.state.calls.length,2);assert.deepEqual(errors,[]);
});

test('switching conversations keeps two existing generations; a third draft is retained without starting a rejected task', {timeout:40000}, async t=>{
    const {f,page,requests,errors}=await setup(t);const held=[];
    f.state.onCompletion=async(_,res)=>{held.push(res);res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return true;};
    await page.fill('#user-input','任务一');await page.click('#send-button');await until(()=>held.length===1);
    await page.evaluate(()=>historyManager.createNewChat());
    await page.fill('#user-input','任务二');await page.click('#send-button');await until(()=>held.length===2);
    await page.evaluate(()=>historyManager.createNewChat());
    await page.fill('#user-input','这个草稿不能丢');await page.click('#send-button');
    await page.getByText('已有后台任务占满生成名额，请在历史会话中查看进度；本次输入已保留',{exact:true}).waitFor();
    assert.equal(await page.inputValue('#user-input'),'这个草稿不能丢');
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.length),0);
    assert.equal(requests.filter(r=>r.path==='/api/chat/completions').length,2);
    finish(held[0],'任务一结果');finish(held[1],'任务二结果');
    await page.waitForFunction(()=>!AppState.operations.size);
    assert.equal(await page.inputValue('#user-input'),'这个草稿不能丢');assert.equal(f.state.calls.length,2);assert.deepEqual(errors,[]);
});

test('slow task discovery locks repeated clicks and sends only to the original chat after a switch', {timeout:30000}, async t=>{
    const {f,page,requests,errors}=await setup(t);
    await page.evaluate(async()=>{
        await GenerationRecovery.sync();
        const original=GenerationRecovery.tasks.bind(GenerationRecovery);
        GenerationRecovery.tasks=async()=>{await new Promise(resolve=>{window.__releaseDiscovery=resolve;});return original();};
    });
    const chat=await page.evaluate(()=>AppState.currentChatId);
    await page.fill('#user-input','只发往原对话');
    await page.evaluate(()=>{void sendMessage();void sendMessage();});
    assert.equal(await page.locator('#send-button').isDisabled(),true);
    await page.evaluate(()=>{historyManager.createNewChat();window.__releaseDiscovery();});
    await page.waitForFunction(id=>AppState.chats.get(id).messages.at(-1)?.status==='complete',chat);
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.length),0);
    assert.equal(await page.evaluate(id=>AppState.chats.get(id).messages.length,chat),2);
    assert.equal(requests.filter(r=>r.path==='/api/chat/completions').length,1);
    assert.equal(f.state.calls.length,1);assert.deepEqual(errors,[]);
});

test('editing the draft during task discovery preserves the new text without sending old text', {timeout:30000}, async t=>{
    const {page,requests,errors}=await setup(t);
    await page.evaluate(async()=>{
        await GenerationRecovery.sync();
        const original=GenerationRecovery.tasks.bind(GenerationRecovery);
        GenerationRecovery.tasks=async()=>{await new Promise(resolve=>{window.__releaseDiscovery=resolve;});return original();};
    });
    await page.fill('#user-input','发送前的文字');await page.click('#send-button');
    await page.fill('#user-input','检查期间修改的草稿');
    await page.evaluate(()=>window.__releaseDiscovery());
    await page.waitForFunction(()=>!GenerationRecovery.preparing.size);
    assert.equal(await page.inputValue('#user-input'),'检查期间修改的草稿');
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.length),0);
    assert.equal(requests.filter(r=>r.path==='/api/chat/completions').length,0);assert.deepEqual(errors,[]);
});

test('offline Stop stays pending until acknowledged, then cancels the same task on reconnection', {timeout:30000}, async t=>{
    const {f,page,context,requests,errors}=await setup(t);let held;
    f.state.onCompletion=async(_,res)=>{held=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();return true;};
    await page.fill('#user-input','断网停止测试');await page.click('#send-button');await until(()=>held);
    const id=await page.evaluate(()=>AppState.currentChat.messages.at(-1).generation.id);
    await context.setOffline(true);await page.click('#stop-button');
    await page.waitForFunction(()=>!AppState.operations.size);
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).generation.pending),true);
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).generation.stopRequested),true);
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).status),'reconnecting');
    await context.setOffline(false);await page.evaluate(()=>dispatchEvent(new Event('online')));
    await page.waitForFunction(()=>!AppState.operations.size&&AppState.currentChat.messages.at(-1)?.status==='aborted');
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).generation.pending),false);
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).generation.id),id);
    assert.equal(requests.filter(r=>r.path==='/api/chat/completions').length,1);
    assert.equal(f.state.calls.length,1);assert.deepEqual(errors,[]);
});

test('Stop while saving a new generation leaves the next question ready to send', {timeout:30000}, async t=>{
    const {f,page,requests,errors}=await setup(t);
    await page.evaluate(()=>{
        const save=historyManager.save.bind(historyManager);
        historyManager.save=async chat=>{
            if(chat.messages.at(-1)?.generation?.pending && !window.releaseGenerationSave){
                await new Promise(resolve=>{window.releaseGenerationSave=resolve;});
            }
            return save(chat);
        };
    });
    await page.fill('#user-input','第一条测试问题');
    await page.click('#send-button');
    await page.waitForFunction(()=>typeof window.releaseGenerationSave==='function');
    await page.click('#stop-button');
    await page.evaluate(()=>window.releaseGenerationSave());
    await page.waitForFunction(()=>AppState.operations.size===0);
    const first=await page.evaluate(()=>AppState.currentChat.messages.at(-1));
    assert.equal(first.status,'aborted');
    assert.equal(first.generation.pending,false);
    assert.equal(requests.filter(r=>r.path==='/api/chat/cancel'||r.path==='/api/chat/stream'||r.path==='/api/chat/completions').length,0);
    f.state.onCompletion=async(_,res)=>complete(res,{content:'第二条已完成'});
    await page.fill('#user-input','第二条测试问题');
    await page.click('#send-button');
    await page.waitForFunction(()=>AppState.currentChat.messages.at(-1)?.status==='complete');
    assert.equal(await page.evaluate(()=>AppState.currentChat.messages.at(-1).content),'第二条已完成');
    assert.equal(requests.filter(r=>r.path==='/api/chat/completions').length,1);
    assert.equal(f.state.calls.length,1);
    assert.deepEqual(errors,[]);
});

test('Stop after DONE during postprocessing does not leave a completed generation pending', {timeout:30000}, async t=>{
    const {f,page,requests,errors}=await setup(t);
    await page.evaluate(()=>{
        ChartRecovery.run=async()=>{
            await new Promise(resolve=>{window.releasePostprocessing=resolve;});
        };
    });
    f.state.onCompletion=async(_,res)=>complete(res,{content:'已生成的结果'});
    await page.fill('#user-input','完成阶段停止测试');
    await page.click('#send-button');
    await page.waitForFunction(()=>typeof window.releasePostprocessing==='function');
    await page.click('#stop-button');
    await page.evaluate(()=>window.releasePostprocessing());
    await page.waitForFunction(()=>AppState.operations.size===0);
    const result=await page.evaluate(()=>AppState.currentChat.messages.at(-1));
    assert.equal(result.status,'aborted');
    assert.equal(result.generation.pending,false);
    assert.equal(result.content,'已生成的结果');
    assert.equal(f.state.calls.length,1);
    assert.equal(requests.filter(r=>r.path==='/api/chat/stream'||r.path==='/api/chat/cancel').length,0);
    assert.deepEqual(errors,[]);
});
