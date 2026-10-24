import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {streamChat} from '../dist/index.js';

test('持续有正文输出的聊天超过单次等待时限仍应完整结束',async()=>{
 const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});let count=0;
 const timer=setInterval(()=>{res.write(`data: ${JSON.stringify({choices:[{delta:{content:'继续输出'}}]})}\n\n`);if(++count===8){clearInterval(timer);res.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:8}})}\n\n`);}},50);res.on('close',()=>clearInterval(timer));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let chunks=0;
 try{await streamChat({mode:'real',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'test',timeoutMs:200},[{role:'user',content:'测试长回复'}],new AbortController().signal,async()=>{chunks++;});assert.equal(chunks,8);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('连续无数据仍应超时并给出明确原因',async()=>{
 const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"已收到部分"}}]}\n\n');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let received='';
 try {await assert.rejects(streamChat({mode:'real',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'test',timeoutMs:100},[{role:'user',content:'测试'}],new AbortController().signal,async text=>{received+=text;}),/连续.*未返回数据/);assert.equal(received,'已收到部分');}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('流式计时器总上限和取消后清理',async()=>{
 const {createStreamDeadline}=await import('../dist/index.js');
 const controller=new AbortController();const deadline=createStreamDeadline({signal:controller.signal,idleMs:100,totalMs:140,label:'测试'});
 const timer=setInterval(()=>deadline.touch(),20);
 try{await new Promise(resolve=>deadline.signal.addEventListener('abort',resolve,{once:true}));assert.match(deadline.signal.reason.message,/运行上限/);}finally{clearInterval(timer);deadline.dispose();}
 const cancelled=createStreamDeadline({signal:controller.signal,idleMs:100,label:'测试'});controller.abort(new Error('用户停止'));assert.equal(cancelled.signal.reason.message,'用户停止');cancelled.dispose();
});
