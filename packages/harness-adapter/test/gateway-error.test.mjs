import {test} from 'node:test';
import assert from 'node:assert/strict';
import {harnessGatewayError} from '../dist/index.js';

test('gateway retains quota and concurrency reasons instead of reducing both to 429',async()=>{
 for(const [message,reason]of [['额度不足','平台模型额度不足'],['并发已达上限','平台模型并发位已满']]){
  const error=await harnessGatewayError(Response.json({ok:false,code:'QUOTA_EXCEEDED',message},{status:429}));
  assert.match(error.message,new RegExp(reason));assert.equal(error.httpStatus,429);assert.equal(error.platformCode,'QUOTA_EXCEEDED');
 }
});
test('untrusted gateway errors do not leak response bodies or assume a quota cause',async()=>{
 const error=await harnessGatewayError(Response.json({code:'unsafe-secret-code',message:'Bearer private-token',secret:'private'},{status:429,headers:{'retry-after':'12'}}));
 assert(!JSON.stringify(error).includes('private'));assert(!error.message.includes('private'));assert(!error.message.includes('额度不足'));assert.equal(error.retryAfterSeconds,12);
 const plain=await harnessGatewayError(new Response('private raw error',{status:502}));assert.equal(plain.message,'远程 Harness 网关返回 502');
});
