import {test} from 'node:test';import assert from 'node:assert/strict';import {completeHarness,HarnessFinalCheckpointError} from '../dist/index.js';
const frame=delta=>'data: '+JSON.stringify(delta)+'\n\n';const config={baseUrl:'https://fixture.invalid',apiKey:'fixture',timeoutMs:1000};
test('Harness length preserves displayable text and real text metrics without private reasoning',async t=>{
 const text='# 架构\n已经生成的结论';let diagnostic;t.mock.method(globalThis,'fetch',async()=>new Response(frame({choices:[{delta:{reasoning_content:'private-thinking',content:text},finish_reason:'length'}],usage:{prompt_tokens:12,completion_tokens:20}}),{headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(completeHarness(config,{messages:[{role:'user',content:'fixture'}],tools:[]},new AbortController().signal,d=>{diagnostic=d;}),e=>{assert(e instanceof HarnessFinalCheckpointError);assert.equal(e.content,text);assert.equal(e.usage.state,'known');assert.equal(e.diagnostic.code,'MODEL_OUTPUT_LIMIT');return true;});assert.equal(diagnostic.textChars,text.length);assert(!JSON.stringify(diagnostic).includes(text));assert(!JSON.stringify(diagnostic).includes('private-thinking'));
});
test('truncated tool arguments are not mistaken for a recoverable final answer',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response(frame({choices:[{delta:{content:'preface',tool_calls:[{function:{name:'service_action',arguments:'{"request":'}}]},finish_reason:'length'}]}),{headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(completeHarness(config,{messages:[],tools:[]},new AbortController().signal),e=>!(e instanceof HarnessFinalCheckpointError)&&e.diagnostic.code==='MODEL_OUTPUT_LIMIT');
});
