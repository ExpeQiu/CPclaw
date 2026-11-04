import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
import {openPlatform,listenPlatform,fixtureEmployees} from '../dist/index.js';
import {adminPage} from '../dist/admin-page.js';

test('admin page contains executable script',()=>{new Script(adminPage().match(/<script>([\s\S]*)<\/script>/)[1]);});
test('admin employee maintenance, organization boundaries, revocation, diagnostics and backup receipts',async()=>{
 const dataDir=mkdtempSync('/tmp/cpclaw-admin-');
 const config={dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'admin-test-isolated-session-secret-123',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:Date.now};
 let opened=openPlatform(config);assert(opened.ok);let app=opened.app;
 const server=await listenPlatform(app,{dataDir,port:0,aiMockMode:true});
 const login=(id,pw='fixture-'+id)=>app.login({employeeId:id,password:pw,deviceLabel:'admin-test'});
 const admin=login('admin'),a=login('employee-a'),c=login('employee-c');
 const cmd=(action,input={},token=admin.accessToken)=>app.admin(token,action,input);
 const base='http://127.0.0.1:'+server.port;
 try{
  const page=await fetch(base+'/admin');assert.equal(page.status,200);assert.equal(page.headers.get('x-frame-options'),'DENY');assert.equal((await fetch(base+'/',{redirect:'manual'})).headers.get('location'),'/admin');
  assert.equal((await fetch(base+'/v1/admin/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'diagnostics'})})).status,401);
  for(const action of ['employee-create','employee-update','backups','diagnostics','diagnostic-read'])assert.equal(cmd(action,{},a.accessToken).code,'FORBIDDEN');
  const employee={employeeId:'new-person',name:'新员工',role:'employee',password:'isolated-new-pass'};
  assert.equal(cmd('employee-create',{...employee,orgId:'org-other'}).ok,true);
  const user=login(employee.employeeId,employee.password);assert(user.ok);assert.equal(user.orgId,'org-demo');
  assert.equal(cmd('employee-create',employee).code,'CONFLICT');
  assert.equal(cmd('employee-update',{employeeId:'employee-c',name:'跨组织',role:'admin'}).code,'NOT_FOUND');
  assert.equal(cmd('employee-update',{employeeId:'admin',name:'管理员',role:'employee'}).code,'CONFLICT');
  assert.equal(cmd('employee-update',{...employee,role:'admin',password:'isolated-reset-pass'}).ok,true);
  assert.equal(app.listOwnSessions(user.accessToken).code,'SESSION_REVOKED');
  assert.equal(login(employee.employeeId,employee.password).ok,false);
  assert.equal(login(employee.employeeId,'isolated-reset-pass').role,'admin');
  assert.equal(app.setQuota(admin.accessToken,{employeeId:employee.employeeId,limitTokens:5000,concurrentLimit:2}).ok,true);
  assert.equal(app.setQuota(admin.accessToken,{employeeId:employee.employeeId,limitTokens:NaN,concurrentLimit:2}).ok,false);
  assert.equal(app.disable(admin.accessToken,employee.employeeId).ok,true);
  assert.equal(cmd('employee-update',employee).code,'CONFLICT');
  const pack={schemaVersion:1,kind:'diagnostic-pack',report:{schemaVersion:1,runId:'diag-admin-test',autoRepair:false,checks:[],versions:{}},logs:[]};
  const upload=async(token,value)=>{const content=JSON.stringify(value);const res=await fetch(base+'/v1/diagnostics',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({content,idempotencyKey:'diag-'+createHash('sha256').update(content).digest('hex')})});assert.equal(res.status,200);return (await res.json()).upload;};
  const ours=await upload(a.accessToken,pack),other=await upload(c.accessToken,{...pack,app:{version:'other'}});
  assert.equal(cmd('diagnostics').reports.length,1);
  assert.deepEqual(cmd('diagnostic-read',{uploadId:ours.uploadId}).report,pack);
  assert.equal(cmd('diagnostic-read',{uploadId:other.uploadId}).code,'NOT_FOUND');
  const text='private ordinary artifact';const own=app.createUpload(a.accessToken,{purpose:'artifact',contentSha256:createHash('sha256').update(text).digest('hex'),byteSize:Buffer.byteLength(text),idempotencyKey:'ordinary-artifact'});assert(own.ok);assert(app.putUploadContent(a.accessToken,own.upload.uploadId,text).ok);assert(app.completeUpload(a.accessToken,own.upload.uploadId).ok);
  assert.equal(cmd('diagnostics').reports.length,1);assert.equal(cmd('diagnostic-read',{uploadId:own.upload.uploadId}).code,'NOT_FOUND');
  assert.equal(cmd('backups').backups.length,0);const backup=app.backup(admin.accessToken);assert(backup.ok);assert.equal(cmd('backups').backups[0].fileName,backup.fileName);
  const entries=app.listAudit(admin.accessToken).entries;assert(entries.some(e=>e.action==='employee-create'));assert(entries.some(e=>e.action==='diagnostic_read'));assert(!JSON.stringify(entries).includes('isolated-reset-pass'));
 }finally{await server.close();app.close();}
 try{opened=openPlatform(config);assert(opened.ok);app=opened.app;const admin2=login('admin');assert.equal(app.listEmployees(admin2.accessToken).employees.find(e=>e.employeeId==='new-person').status,'disabled');}finally{app.close();rmSync(dataDir,{recursive:true,force:true});}
});
