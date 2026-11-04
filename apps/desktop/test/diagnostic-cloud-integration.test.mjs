import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {openPlatform,listenPlatform,fixtureEmployees} from '@cpclaw/platform';
import {createWorkspaceClient} from '../workspace-client.mjs';

test('real worker refreshes its session and uploads a verified diagnostic package to the platform',async()=>{
 const platformDir=mkdtempSync('/tmp/cpclaw-doctor-e2e-platform-'),dataDir=mkdtempSync('/tmp/cpclaw-doctor-e2e-worker-');
 const opened=openPlatform({dataDir:platformDir,port:0,listenHost:'127.0.0.1',sessionSecret:'{{SECRET_vazpdpr5}}',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:()=>Date.now()});assert(opened.ok);
 const server=await listenPlatform(opened.app,{dataDir:platformDir,port:0,aiMockMode:true});
 const worker=createWorkspaceClient(dataDir,resolve(import.meta.dirname,'..'));
 const call=(method,input={})=>worker.request({method,actorId:'employee-a',input});
 try{
  assert((await call('account.login',{platformUrl:'http://127.0.0.1:'+server.port,employeeId:'employee-a',password:'fixture-employee-a'})).ok);
  const checked=await call('doctor.center',{action:'check',host:{version:'test',kernel:{ready:true}}});assert(checked.ok,checked.message);
  const uploaded=await call('doctor.center',{action:'upload'});assert(uploaded.ok,uploaded.message);assert.equal(uploaded.upload.status,'available');assert.equal(uploaded.upload.contentSha256,checked.sha256);
  const repeat=await call('doctor.center',{action:'upload'});assert(repeat.ok,repeat.message);assert.equal(repeat.upload.uploadId,uploaded.upload.uploadId);
  const status=await call('doctor.center',{action:'status'});assert(status.ok,status.message);assert.equal(status.upload.contentSha256,checked.sha256);
  const denied=await worker.request({method:'doctor.center',actorId:'employee-b',input:{action:'upload'}});assert.equal(denied.ok,false);
 }finally{worker.stop();await server.close();opened.app.close();rmSync(platformDir,{recursive:true,force:true});rmSync(dataDir,{recursive:true,force:true});}
});
