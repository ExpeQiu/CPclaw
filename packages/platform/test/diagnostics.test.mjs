import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {openPlatform,listenPlatform,fixtureEmployees} from '../dist/index.js';

const pack={schemaVersion:1,kind:'diagnostic-pack',report:{schemaVersion:1,runId:'diag-test',autoRepair:false,checks:[],versions:{}},logs:[],recentChat:null};
const payload=value=>{const content=JSON.stringify(value);return {content,idempotencyKey:'diag-'+createHash('sha256').update(content).digest('hex')};};
test('diagnostic HTTP upload is verified, idempotent, private and rejects unsafe packages',async()=>{
 const dataDir=mkdtempSync('/tmp/cpclaw-diagnostic-http-');
 const opened=openPlatform({dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'diagnostic-fixture-secret-12345',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:()=>Date.now()});assert(opened.ok);
 const server=await listenPlatform(opened.app,{dataDir,port:0,aiMockMode:true});
 const login=id=>opened.app.login({employeeId:id,password:'fixture-'+id,deviceLabel:'diagnostic-test'});
 const a=login('employee-a'),b=login('employee-b'),base='http://127.0.0.1:'+server.port;
 const call=(token,path='/v1/diagnostics',body)=>fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const first=await call(a.accessToken,undefined,payload(pack));assert.equal(first.status,200);const saved=await first.json();
  assert.equal(saved.upload.status,'available');assert.equal(saved.upload.contentSha256,payload(pack).idempotencyKey.slice(5));
  const repeat=await (await call(a.accessToken,undefined,payload(pack))).json();assert.equal(repeat.upload.uploadId,saved.upload.uploadId);
  const read=await(await call(a.accessToken,'/v1/diagnostics/'+saved.upload.uploadId+'/content')).json();assert.equal(read.content,payload(pack).content);
  assert.equal((await call(b.accessToken,'/v1/diagnostics/'+saved.upload.uploadId)).status,404);
  assert.equal((await call('',undefined,payload(pack))).status,401);
  for(const message of ['Bearer hidden-token','refreshToken=private-value','password=hidden','/Users/private/file']) {
   assert.equal((await call(a.accessToken,undefined,payload({...pack,logs:[{message}]}))).status,400);
  }
  assert.equal((await call(a.accessToken,undefined,payload({...pack,recentChat:{chatId:'x',messages:[{content:'private conversation'}],operations:[]}}))).status,400);
  assert.equal((await call(a.accessToken,undefined,{...payload(pack),idempotencyKey:'different'})).status,400);
  assert.equal((await call(a.accessToken,undefined,payload({...pack,logs:[{message:'x'.repeat(270000)}]}))).status,400);
 }finally{await server.close();opened.app.close();rmSync(dataDir,{recursive:true,force:true});}
});
