import {test} from 'node:test';
import assert from 'node:assert/strict';
import {creationProcess,skillMaterial,skillDraftMetadata,wrapSkillDraft} from '../creation-process.mjs';
const source={goal:'生成跑车图片',summary:'已生成跑车图片。',steps:[{step:1,service:{title:'即梦画布'},request:{action:'call',args:['node','run','--project-id','00000000-0000-4000-8000-000000000001','--node-id','node_actual1']},result:{ok:true,recovery:{items:[{submitId:'00000000-0000-4000-8000-000000000002'}]},accessToken:'PRIVATE',apiKey:'PRIVATE',path:'/Users/person/private/picture.png',status:'succeeded'}}]};
test('creation process includes real request, response and outcome without credentials',()=>{const body=creationProcess(source);assert.match(body,/创作过程/);assert.match(body,/node_actual1/);assert.match(body,/00000000-0000-4000-8000-000000000002/);assert.match(body,/succeeded/);assert(!body.includes('PRIVATE'));assert.match(body,/以执行回执为准/);});
test('process export cannot invent execution records',()=>{assert.throws(()=>creationProcess({...source,steps:[]}),/没有实际应用执行记录/);});
test('skill material parameterizes real identities and omits local paths',()=>{const body=skillMaterial(source);assert(!body.includes('node_actual1'));assert(!body.includes('00000000-0000-4000-8000-000000000001'));assert(!body.includes('/Users/person'));assert(!body.includes('PRIVATE'));assert.match(body,/<node_id>/);assert.match(body,/<id>/);});
test('skill wraps one metadata header with stable name, semver and explicit invocation',()=>{const metadata=skillDraftMetadata('message-1',source.goal);assert.deepEqual(metadata,skillDraftMetadata('message-1',source.goal));const body=wrapSkillDraft('---\nname: wrong\n---\n# 可复用工作流\n## 步骤\n检查能力。',metadata);assert.equal((body.match(/^---$/gm)||[]).length,2);assert.match(body,/version: "1.0.0"/);assert.match(body,/disable-model-invocation: true/);assert(!body.includes('name: wrong'));});

test('long model catalogs cannot remove late generation and download steps from skill material',()=>{
 const steps=Array.from({length:40},(_,i)=>({...source.steps[0],step:i+1,request:{action:'call',args:[i===39?'resource':'node',i===39?'download':'show','x'.repeat(1500)]},result:{ok:true,data:{items:Array.from({length:50},()=>({model:'catalog'.repeat(100)}))}}}));
 const material=skillMaterial({...source,steps}),parsed=JSON.parse(material);assert.equal(parsed.steps.length,40);assert.match(parsed.steps.at(-1).request,/download/);assert(material.length<14000);
});
