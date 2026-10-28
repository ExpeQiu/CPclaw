import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskIssue,recoveredMediaIssue} from '../task-issue.mjs';
test('quota notice describes the cause, impact, preserved task and direct action',()=>{
 const issue=taskIssue({error:'远程 Harness 网关返回 429',modelQuota:{availableTokens:0},safeToRetry:true,hasServiceSteps:true});
 assert.equal(issue.popup,true);assert.equal(issue.action,'quota');assert.match(issue.title,/额度不足/);assert.match(issue.impact,/即梦积分.*分别/);assert.match(issue.preserved,/尚无生成或写入提交/);
 assert(!issue.summary.includes('429'));assert(!issue.summary.includes('已生成'));
 const insufficient=taskIssue({error:'远程 Harness 网关返回 429',modelQuota:{availableTokens:20,minimumRequestTokens:100}});assert.equal(insufficient.code,'MODEL_QUOTA_EXHAUSTED');assert(!insufficient.summary.includes('已用完'));
});
test('temporary and partial failures do not make false outcome claims',()=>{
 const temporary=taskIssue({error:'远程 Harness 网关返回 502',hasServiceSteps:true});assert.equal(temporary.popup,false);assert.equal(temporary.action,'diagnose');assert.match(temporary.preserved,/核实原任务/);
 const image=taskIssue({error:'图片解码失败'});assert(!image.summary.includes('原图已保存'));assert.equal(image.action,'diagnose');
 assert.equal(taskIssue({error:'已停止生成',state:'cancelled'}),null);
 assert(!taskIssue({error:'Bearer private-token'}).details.includes('private-token'));
 const auth=taskIssue({error:'模型步骤达到上限',serviceAuthRequired:true});assert.equal(auth.code,'SERVICE_AUTH_REQUIRED');assert.equal(auth.popup,true);
});
test('verified recovery replaces a stale blocking message without declaring other goals complete',()=>{
 const previous=taskIssue({error:'模型步骤达到上限'});
 assert.equal(recoveredMediaIssue({status:'generated',images:[]},previous),previous);
 const recovered=recoveredMediaIssue({status:'delivered',images:[{delivered:true,local:{path:'/saved.png'}}]},previous);
 assert.equal(recovered.severity,'resolved');assert.equal(recovered.popup,false);assert(!recovered.summary.includes('任务已完成'));assert.match(recovered.preserved,/没有重新提交/);
});
