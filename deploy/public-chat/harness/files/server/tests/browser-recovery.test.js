const {test}=require('node:test'),assert=require('node:assert/strict');
const {browserFixture,complete}=require('./browser-fixture');
const {SSEDecoder}=require('../../public/js/core/sse');
test('stale recovery retains the actual fresh page in UI, one model copy and no automatic action replay',async()=>{
    const f=await browserFixture();
    try{
        const user=await f.register();f.bridge.toolError={code:'STALE_REFERENCE'};
        f.bridge.contextObservation={observation_id:12,text:'RECOVERY_PAGE_MARKER',elements:[{ref:'new-ref',label:'Actual current target'}],
            recovery:{target_reason:'NODE_REMOVED',snapshot_settle:{status:'quiet',elapsed_ms:120}}};
        let turn=0;
        f.state.onCompletion=async(body,res)=>{
            if(turn++===0)return complete(res,{tool:'browser_click',args:{ref:'old-ref'}});
            const tool=JSON.parse(body.messages.find(m=>m.role==='tool').content);
            assert.equal(tool.target_reason,'NODE_REMOVED');assert.equal(tool.recovery_observation_id,12);
            assert.equal(tool.recovery_page,undefined,'Do not duplicate the fresh page in model history');
            assert.equal(JSON.stringify(body.messages).split('RECOVERY_PAGE_MARKER').length-1,1);
            return complete(res,{content:'已根据新页面核对目标，未重复点击。'});
        };
        const raw=await(await f.request('/api/chat/completions',{messages:[{role:'user',content:'Inspect a local target'}],stream:true,
            browserContext:{conversationId:'recovery-case',messageId:'reply'}},user.token)).text();
        const events=new SSEDecoder().feed(raw,true).filter(e=>e.data!=='[DONE]').map(e=>JSON.parse(e.data));
        const step=events.find(e=>e.browser?.type==='step'&&e.browser.step.status==='error').browser.step;
        assert.match(step.error,/原目标节点已被页面移除/);
        const result=JSON.parse(step.result);assert.equal(result.recovery_page.observation_id,12);
        assert.equal(result.recovery_page.elements[0].ref,'new-ref');assert.equal(result.recovery_page.image,undefined);
        assert.equal(f.bridge.contexts,1);assert.equal(f.bridge.calls.length,1);
    }finally{await f.close();}
});
