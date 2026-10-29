import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareServiceCompletion, serviceModelBudget } from '../dist/loop-budget.js';

test('service loop reserves final calls without losing prior tool receipts', () => {
  const body = { messages: [{role:'user',content:'内置哪些技能？'},
    {role:'assistant',content:null,tool_calls:[{id:'t1',type:'function',function:{name:'service_action',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'t1',content:'已找到技能目录'}],
    tools:[{type:'function',function:{name:'service_action'}}],tool_choice:'auto',parallel_tool_calls:false };
  assert.equal(prepareServiceCompletion(body,19),body);
  const warning = prepareServiceCompletion(body,20);
  assert.deepEqual(warning.tools,body.tools);
  assert.match(warning.messages.at(-1).content,/仅剩 4 次/);
  for (const count of [22,23]) {
    const final = prepareServiceCompletion(body,count);
    assert.deepEqual(final.messages.slice(0,-1),body.messages);
    assert.match(final.messages.at(-1).content,/立即.*回答用户/);
    assert.equal('tools' in final,false);
    assert.equal('tool_choice' in final,false);
    assert.equal('parallel_tool_calls' in final,false);
  }
  assert.equal(body.messages.length,3);
  assert.equal(body.tools.length,1);
});

test('configured limit derives both closing thresholds and rejects invalid input', () => {
  assert.deepEqual(serviceModelBudget('24'),{limit:24,wrapUpAt:20,finalOnlyAt:22});
  assert.deepEqual(serviceModelBudget('40'),{limit:40,wrapUpAt:36,finalOnlyAt:38});
  assert.deepEqual(serviceModelBudget('5'),{limit:5,wrapUpAt:1,finalOnlyAt:3});
  for(const value of ['', ' ', '0', '4', '-1', '24.5', 'Infinity', 'NaN', '40abc', '0x28', '1e2', '9007199254740992']) {
    assert.throws(()=>serviceModelBudget(value),/CPCLAW_SERVICE_MODEL_CALL_LIMIT/);
  }
  const body={messages:[{role:'user',content:'query'}],tools:[]};
  const budget=serviceModelBudget('40');
  assert.equal(prepareServiceCompletion(body,35,budget),body);
  assert.match(prepareServiceCompletion(body,36,budget).messages.at(-1).content,/仅剩 4 次/);
  assert.equal('tools' in prepareServiceCompletion(body,38,budget),false);
});
