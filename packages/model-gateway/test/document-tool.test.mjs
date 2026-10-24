import test from 'node:test';
import assert from 'node:assert/strict';
import {streamChat} from '../dist/index.js';
import {documentModelFixture} from '../../../scripts/document-model-fixture.mjs';

test('原生文档工具：分片、普通回答、未知工具/目标、坏参数和取消',async()=>{
 let choice={kind:'document',filename:'Meeting notes.md',content:'# Meeting\n## Decisions\nSafe text.',sourceId:''},seenRequest;
 const server=documentModelFixture(request=>{seenRequest=request;return choice;});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const config={mode:'real',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'test',timeoutMs:2000};
 const context={files:[{id:'base-1',name:'Meeting notes.md'}],active:{id:'base-1',name:'Meeting notes.md',body:'# Original'}};
 let deliveries=[],text='',activity=0;
 const run=signal=>streamChat(config,[{role:'user',content:'准备明天开会用的材料'}],signal??new AbortController().signal,async delta=>{text+=delta;},{context,onDocument:async d=>{deliveries.push(d);},onActivity:async()=>{activity++;}});
 try{
  await run();assert.equal(deliveries.length,1);assert.equal(deliveries[0].filename,'Meeting notes.md');assert.equal(text,'');assert.ok(activity>0);assert.equal(seenRequest.body.tool_choice,'auto');assert.equal(seenRequest.body.tools[0].function.name,'deliver_document');
  choice={kind:'answer',content:'直接解释即可'};deliveries=[];await run();assert.equal(deliveries.length,0);assert.match(text,/直接解释/);
  choice={kind:'document',sourceId:'base-1'};await run();assert.equal(deliveries.at(-1).sourceId,'base-1');
  const count=deliveries.length;choice={kind:'document',sourceId:'someone-else'};await assert.rejects(run(),/目标无效/);assert.equal(deliveries.length,count);
  choice={kind:'document',filename:'../escape.md'};await assert.rejects(run(),/名称/);assert.equal(deliveries.length,count);
  choice={kind:'document',toolName:'exec_shell'};await assert.rejects(run(),/未知文档工具/);
  choice={kind:'document',rawArgs:'{broken'};await assert.rejects(run());
  choice={kind:'document',finish:'length'};await assert.rejects(run(),/未完整结束/);
  choice={kind:'document',slow:true,content:'长文'.repeat(500)};const abort=new AbortController();const pending=run(abort.signal);setTimeout(()=>abort.abort(),70);await assert.rejects(pending);assert.equal(deliveries.length,count);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
