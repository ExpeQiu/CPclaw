import {test} from 'node:test';import assert from 'node:assert/strict';import {fetchModel} from '../dist/model-retry.js';import {partialDocument} from '../dist/document-checkpoint.js';
test('529 retries only rejected model request with Retry-After and keeps the same payload',async t=>{
 const calls=[],attempts=[];t.mock.method(globalThis,'fetch',async(url,init)=>{calls.push(init.body);return calls.length<3?new Response('',{status:529,headers:{'retry-after':'0'}}):new Response('ok');});
 const r=await fetchModel('https://fixture.invalid',{body:'same-payload',method:'POST'},a=>attempts.push(a));assert.equal(await r.text(),'ok');assert.equal(calls.length,3);assert.equal(new Set(calls).size,1);assert.deepEqual(attempts.map(a=>a.httpStatus),[529,529,200]);
});
test('long Retry-After and non-transient rejection do not retry',async t=>{
 for(const status of [401,403,429]){let count=0;t.mock.method(globalThis,'fetch',async()=>{count++;return new Response('',{status,headers:{'retry-after':'60'}});});assert.equal((await fetchModel('https://fixture.invalid',{})).status,status);assert.equal(count,1);}
});
test('partial tool JSON is retained as draft only, preserving escaped content safely',()=>{
 const context={files:[]};const draft=partialDocument('{"filename":"report.md","content":"第一段\\n内容\\u4e2d\\u',context);assert.equal(draft.content,'第一段\n内容中');assert.equal(draft.complete,false);assert.equal(partialDocument('{"filename":"../bad.md","content":"text',context),undefined);assert.equal(partialDocument('{"filename":"report.md","content":"text',{files:[{id:'old',name:'old.md'}]}),undefined);
});

test('a 200 response that loses its stream is not fetched again',async t=>{
 const {streamChat}=await import('../dist/index.js');let calls=0,reads=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(new ReadableStream({pull(controller){if(reads++===0)controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));else controller.error(Error('stream disconnected'));}}),{headers:{'content-type':'text/event-stream'}});});
 await assert.rejects(streamChat({baseUrl:'https://fixture.invalid',apiKey:'fixture',timeoutMs:1000},[{role:'user',content:'fixture'}],new AbortController().signal,async()=>{}));assert.equal(calls,1);
});
