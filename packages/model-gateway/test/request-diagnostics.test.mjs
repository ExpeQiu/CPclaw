import {test} from 'node:test';import assert from 'node:assert/strict';
import {streamChat,RequestDiagnosticError,cleanRequestDiagnostic} from '../dist/index.js';
const frame=value=>'data: '+JSON.stringify(value)+'\n\n';
const secret='private-prompt-and-tool-body-7264';
for(const [finish,args,expected]of [['length','{"content":"'+secret,'MODEL_OUTPUT_LIMIT'],[null,'{"content":"'+secret,'MODEL_STREAM_INCOMPLETE'],['stop','{}','TOOL_FINISH_MISMATCH'],['tool_calls','{"content":"'+secret,'TOOL_ARGUMENTS_INVALID']])test(`tool failure ${expected} has metadata without content`,async t=>{
 let diagnostic,executed=false;
 t.mock.method(globalThis,'fetch',async()=>new Response(frame({choices:[{delta:{tool_calls:[{index:0,id:'tool',function:{name:'deliver_document',arguments:args}}]}}]})+frame({choices:[{delta:{},finish_reason:finish}]})+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream','x-request-id':'provider-7264'}}));
 await assert.rejects(streamChat({baseUrl:'https://fixture.invalid',apiKey:'private-key',timeoutMs:1000},[{role:'user',content:secret}],new AbortController().signal,async()=>{}, {context:{files:[]},onDocument:async()=>{executed=true;}},r=>{diagnostic=r;}),error=>{
  assert(error instanceof RequestDiagnosticError);assert.equal(error.diagnostic.code,expected);assert(!error.message.includes(secret));return true;
 });
 assert.equal(executed,false);assert.equal(diagnostic.code,expected);assert.equal(diagnostic.toolName,'deliver_document');assert.equal(diagnostic.toolArgumentBytes,Buffer.byteLength(args));assert.equal(diagnostic.providerRequestId,'provider-7264');assert(diagnostic.normalEof);assert(diagnostic.sawDone);assert(!JSON.stringify(diagnostic).includes(secret));
});
test('malformed model event is distinct from transport failure',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('data: {private-secret-bad-json}\n\n',{headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(streamChat({baseUrl:'https://fixture.invalid',apiKey:'x',timeoutMs:1000},[{role:'user',content:'x'}],new AbortController().signal,async()=>{}),e=>e.diagnostic.code==='MODEL_EVENT_INVALID'&&!e.message.includes('private-secret'));
});
test('HTTP status is retained, provider response bodies are excluded',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response(secret,{status:503}));
 await assert.rejects(streamChat({baseUrl:'https://fixture.invalid',apiKey:'x',timeoutMs:1000},[{role:'user',content:'x'}],new AbortController().signal,async()=>{}),e=>e.diagnostic.code==='MODEL_HTTP_ERROR'&&e.diagnostic.httpStatus===503&&!e.message.includes(secret));
 assert.deepEqual(cleanRequestDiagnostic({code:'MODEL_OUTPUT_LIMIT',prompt:secret,toolArguments:secret,providerRequestId:'Bearer secret'}),{code:'MODEL_OUTPUT_LIMIT'});
});
test('transport diagnostics retain safe cause codes and reject arbitrary private values',()=>{assert.equal(cleanRequestDiagnostic({code:'MODEL_CONNECTION_FAILED',stage:'model_connect',transportCode:'ECONNRESET'}).transportCode,'ECONNRESET');assert.equal(cleanRequestDiagnostic({transportCode:'https://private.invalid?token=secret',cause:{headers:{authorization:'secret'}}}).transportCode,undefined);assert.equal(cleanRequestDiagnostic({transportCode:'PRIVATE_TOKEN'}).transportCode,undefined);});
