import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {createWorkspaceClient} from '../workspace-client.mjs';

test('diagnostic center works through worker RPC and reserves repair against new work',async()=>{
 const dataDir=mkdtempSync('/tmp/cpclaw-doctor-worker-');
 const client=createWorkspaceClient(dataDir,resolve(import.meta.dirname,'..'));
 try{
  const call=(method,input={})=>client.request({method,actorId:'local-doctor',input});
  const result=await call('doctor.center',{action:'check',host:{kernel:{ready:true}}});assert(result.ok,result.message);assert.equal(result.report.autoRepair,false);assert.equal(result.app.kernel.ready,true);
  assert((await call('doctor.center',{action:'file'})).path.endsWith('.json'));
  const reserve=await call('doctor.preflight',{reserve:true});assert.equal(reserve.busy,false);
  const blocked=await call('chat.create');assert.equal(blocked.ok,false);assert.equal(blocked.code,'SLOT_BUSY');
  assert((await call('doctor.run')).ok);
 }finally{client.stop();rmSync(dataDir,{recursive:true,force:true});}
});
