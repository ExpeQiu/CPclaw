import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {openPlatform,listenPlatform,fixtureEmployees} from '../dist/index.js';
import {createChatService} from '../../../apps/desktop/chat-service.mjs';

test('桌面流式请求超过旧总时限仍完成，停顿时保留正文并明确提示',async()=>{
 let stall=false;
 const upstream=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});let n=0;const timer=setInterval(()=>{res.write('data: {"choices":[{"delta":{"content":"片段"}}]}\n\n');if(stall){clearInterval(timer);return;}if(++n===8){clearInterval(timer);res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":8}}\n\n');}},50);res.on('close',()=>clearInterval(timer));});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const dataDir=mkdtempSync('/tmp/cpclaw-timeout-platform-'),desktopDir=mkdtempSync('/tmp/cpclaw-timeout-desktop-');
 const opened=openPlatform({dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'chat-timeout-test-0123456789abcdef',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:true,now:()=>Date.now()});assert.ok(opened.ok);
 const server=await listenPlatform(opened.app,{dataDir,port:0,aiMockMode:false,reportGateway:{mode:'real',baseUrl:`http://127.0.0.1:${upstream.address().port}`,apiKey:'test',timeoutMs:2000}});
 const service=createChatService(desktopDir,()=>{},{chatIdleMs:200,chatTotalMs:2000});
 const call=(method,input={})=>service.dispatch(method,'employee-a',input);
 try{
  assert.ok((await call('account.login',{platformUrl:`http://127.0.0.1:${server.port}`,employeeId:'employee-a',password:'fixture-employee-a'})).ok);
  const {chatId}=await call('chat.create');
  assert.equal((await call('chat.send',{chatId,text:'长回复',requestId:'long'})).state,'done');
  stall=true;assert.equal((await call('chat.send',{chatId,text:'停顿',requestId:'stall'})).state,'error');
  const history=await call('chat.history',{chatId});assert.equal(history.messages.at(-1).content,'片段');assert.match(history.messages.at(-1).error,/连续.*未返回数据/);
 }finally{service.stop();await server.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));rmSync(dataDir,{recursive:true,force:true});rmSync(desktopDir,{recursive:true,force:true});}
});
