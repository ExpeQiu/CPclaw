import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {openPlatform,fixtureEmployees,listenPlatform} from '../dist/index.js';

test('own quota application is automatically approved, auditable, isolated and idempotent',async()=>{
 const dataDir=mkdtempSync('/tmp/cpclaw-quota-request-');
 const opened=openPlatform({dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'quota-request-test-secret',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:()=>Date.now()});
 assert(opened.ok);const app=opened.app;
 const login=id=>{const r=app.login({employeeId:id,password:'fixture-'+id,deviceLabel:'test'});assert(r.ok);return r;};
 const a=login('employee-a'),b=login('employee-b'),admin=login('admin');
 try{
  assert.equal(typeof app.requestOwnQuota,'function');
  const before=app.readOwnQuota(a.accessToken).quota;
  const first=app.requestOwnQuota(a.accessToken,{requestId:'request-a',additionalTokens:1000000});
  assert.equal(first.ok,true);assert.equal(first.approvalMode,'auto');assert.equal(first.status,'approved');assert.equal(first.quota.limitTokens,before.limitTokens+1000000);
  assert.equal(first.quota.minimumRequestTokens,100);
  const repeat=app.requestOwnQuota(a.accessToken,{requestId:'request-a',additionalTokens:1000000});assert.equal(repeat.replayed,true);assert.equal(repeat.quota.limitTokens,first.quota.limitTokens);
  assert.equal(app.requestOwnQuota(a.accessToken,{requestId:'request-a',additionalTokens:1}).code,'CONFLICT');
  assert.equal(app.readOwnQuota(b.accessToken).quota.limitTokens,1000);
  for(const n of [0,-1,0.5,1000001,Infinity])assert.equal(app.requestOwnQuota(a.accessToken,{requestId:'invalid-'+n,additionalTokens:n}).ok,false);
  assert.equal(app.requestOwnQuota('invalid',{requestId:'forged',additionalTokens:1000}).ok,false);
  assert(app.listAudit(admin.accessToken).entries.some(e=>e.action==='quota_request_approved'));
  assert.equal(app.readOwnQuota(a.accessToken).quota.settledKnown,before.settledKnown);
 }finally{app.close();rmSync(dataDir,{recursive:true,force:true});}
});

test('quota request HTTP route authenticates the caller and ignores forged employee targets',async()=>{
 const dataDir=mkdtempSync('/tmp/cpclaw-quota-http-');
 const opened=openPlatform({dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'quota-http-test-secret',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:()=>Date.now()});assert(opened.ok);
 const server=await listenPlatform(opened.app,{dataDir,port:0,aiMockMode:true});
 const a=opened.app.login({employeeId:'employee-a',password:'fixture-employee-a',deviceLabel:'test'});assert(a.ok);
 const base=`http://127.0.0.1:${server.port}`;
 try{
  const r=await fetch(base+'/v1/me/quota-requests',{method:'POST',headers:{authorization:`Bearer ${a.accessToken}`,'content-type':'application/json'},body:JSON.stringify({requestId:'http-request',additionalTokens:5000,employeeId:'employee-b'})});
  assert.equal(r.status,200);const result=await r.json();assert.equal(result.status,'approved');assert.equal(result.quota.limitTokens,6000);
  const unauth=await fetch(base+'/v1/me/quota-requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:'bad',additionalTokens:5000})});assert.equal(unauth.status,401);
 }finally{await server.close();opened.app.close();rmSync(dataDir,{recursive:true,force:true});}
});
