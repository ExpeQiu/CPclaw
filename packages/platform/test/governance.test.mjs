import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {openPlatform,listenPlatform,fixtureEmployees,restorePlatformSqlite} from '../dist/index.js';
import {LoginGuard} from '../dist/login-guard.js';
import {managementCatalog} from '../dist/management-catalog.js';
import {publicServices} from '../../../apps/desktop/service-runtime.mjs';

function fixture(){const dataDir=mkdtempSync('/tmp/cpclaw-governance-');let at=Date.now();const config={dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'{{SECRET_ewl73oni}}',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:[...fixtureEmployees,{...fixtureEmployees[3],employeeId:'other-admin',role:'admin',password:'isolated-other-admin'}]},keyPresent:false,now:()=>at++};const opened=openPlatform(config);assert(opened.ok);const app=opened.app;const login=(id,pw='fixture-'+id)=>{const x=app.login({employeeId:id,password:pw,deviceLabel:'governance-test'});assert(x.ok);return x.accessToken;};return {dataDir,config,app,login,close(){app.close();rmSync(dataDir,{recursive:true,force:true});}};}

test('desktop endpoint inventory covers current desktop cloud calls',()=>{
 const endpoints=new Set(managementCatalog.flatMap(m=>m.endpoints));
 for(const file of ['chat-service.mjs','diagnostic-center.mjs','session-refresh.mjs','workspace-worker.mjs']){const source=readFileSync(new URL('../../../apps/desktop/'+file,import.meta.url),'utf8');for(const match of source.matchAll(/["'`](\/v1\/[a-z0-9_/-]+)["'`]/g)){const path=match[1].replace(/\/$/,'');assert(endpoints.has(path)||endpoints.has(path+'/:id'),'missing endpoint '+path);}}
 assert(managementCatalog.some(m=>m.id==='im'&&m.scope==='reserved'));assert(managementCatalog.some(m=>m.id==='permissions'&&m.scope==='local'));
});

test('connector organization block takes precedence in actual desktop service catalog and survives owner writes',()=>{
 const f=fixture(),{app}=f;try{
 const admin=f.login('admin'),employee=f.login('employee-a'),other=f.login('other-admin','isolated-other-admin');
 const create=app.market(employee,'connector-save',{title:'Enterprise MCP',type:'MCP',target:'https://example.com/mcp',enabled:true});assert(create.ok);const id=create.connector.id;
 let rows=app.admin(admin,'connectors',{});assert(rows.ok);const r=rows.rows[0];assert.equal(r.id,id);assert.equal('target' in r,false);
 assert.equal(app.admin(other,'connector-control',{id,blocked:true,revision:0}).code,'NOT_FOUND');
 assert.equal(app.admin(admin,'connector-control',{id,blocked:true,revision:0}).ok,true);
 let snapshot=app.market(employee,'list',{});assert(snapshot.ok);assert.equal(snapshot.connectors[0].enabled,false);assert.equal(publicServices(snapshot.connectors).some(s=>s.id===id),false);
 assert(app.market(employee,'connector-save',{id,title:'Renamed',type:'MCP',target:'https://example.com/mcp',enabled:true}).ok);
 snapshot=app.market(employee,'list',{});assert.equal(snapshot.connectors[0].enabled,false);
 assert.equal(app.admin(admin,'connector-control',{id,blocked:false,revision:0}).code,'CONFLICT');
 assert.equal(app.admin(admin,'connector-control',{id,blocked:false,revision:1}).ok,true);assert.equal(publicServices(app.market(employee,'list',{}).connectors).some(s=>s.id===id),true);
 assert(app.market(employee,'connector-save',{id,title:'Renamed',type:'MCP',target:'https://example.com/mcp',enabled:false}).ok);
 assert.equal(app.admin(admin,'connector-control',{id,blocked:true,revision:2}).ok,true);assert.equal(app.admin(admin,'connector-control',{id,blocked:false,revision:3}).ok,true);assert.equal(app.market(employee,'list',{}).connectors[0].enabled,false);
 }finally{f.close();}
});

test('enterprise knowledge edits are visible to desktop, conflict checked and private libraries remain private',()=>{
 const f=fixture(),{app}=f;try{
 const admin=f.login('admin'),a=f.login('employee-a'),b=f.login('employee-b'),other=f.login('other-admin','isolated-other-admin');
 const library=app.knowledge(admin,'save',{scope:'enterprise',name:'企业规范',members:['employee-a']});assert(library.ok);
 const save=app.knowledge(admin,'document-save',{id:library.id,title:'制度',body:'当前版本'});assert(save.ok);
 assert.equal(app.knowledge(a,'read',{id:library.id}).documents.length,0);
 assert(app.knowledge(admin,'document-review',{id:library.id,documentId:save.id,decision:'approve'}).ok);
 assert.equal(app.knowledge(a,'read',{id:library.id}).documents[0].body,'当前版本');
 assert.equal(app.knowledge(b,'read',{id:library.id}).code,'NOT_FOUND');assert.equal(app.knowledge(other,'read',{id:library.id}).code,'NOT_FOUND');
 const doc=app.knowledge(admin,'read',{id:library.id}).documents[0];assert(app.knowledge(admin,'document-save',{id:library.id,documentId:doc.id,revision:doc.revision,title:'制度',body:'新版'}).ok);
 assert.equal(app.knowledge(a,'read',{id:library.id}).documents.length,0);
 assert.equal(app.knowledge(admin,'document-save',{id:library.id,documentId:doc.id,revision:doc.revision,title:'制度',body:'过时修改'}).code,'CONFLICT');
 assert(app.knowledge(admin,'document-review',{id:library.id,documentId:doc.id,decision:'approve'}).ok);
 const metadata=app.knowledge(admin,'list',{}).libraries[0];assert(app.knowledge(admin,'save',{id:library.id,baseUpdated:metadata.updated,name:'企业规范',members:['employee-b']}).ok);
 assert.equal(app.knowledge(a,'read',{id:library.id}).code,'NOT_FOUND');assert.equal(app.knowledge(b,'read',{id:library.id}).documents[0].body,'新版');
 assert.equal(app.revokeKnowledge(admin,doc.sourceDocId).ok,true);assert.equal(app.knowledge(b,'read',{id:library.id}).code,'CONFLICT');
 assert.equal(app.knowledge(admin,'save',{id:library.id,baseUpdated:metadata.updated,name:'过时',members:[]}).code,'CONFLICT');
 const personal=app.knowledge(a,'save',{scope:'personal',name:'私人库'});assert(personal.ok);assert.equal(app.knowledge(admin,'read',{id:personal.id}).code,'NOT_FOUND');
 }finally{f.close();}
});

test('org management lists, revision review, privacy, filters, pagination and audit isolation',()=>{
 const f=fixture(),{app}=f;try{
 const admin=f.login('admin'),a=f.login('employee-a'),other=f.login('other-admin','isolated-other-admin');const cmd=(action,input={},token=admin)=>app.admin(token,action,input);
 for(const action of ['catalog','audit-query','usage','quota-requests','uploads','log-receipts','connectors','learning-candidates','resources','wiki-revisions','originals','integrations'])assert.equal(cmd(action,{},a).code,'FORBIDDEN');
 assert.equal(cmd('learning-set',{enabled:'yes'}).ok,false);assert.equal(cmd('wiki-review',{id:'none',revision:1,decision:'garbage'}).ok,false);
 assert(cmd('learning-set',{enabled:true}).ok);assert(cmd('learning-set',{enabled:true},other).ok);
 const candidate=app.submitLearningCandidate(a,{kind:'experience',title:'安全学习样例',body:'共享的经验'});assert(candidate.ok);
 const foreign=app.submitLearningCandidate(other,{kind:'experience',title:'另一个组织',body:'不能跨组织阅读'});assert(foreign.ok);
 assert.equal(cmd('candidate-read',{id:foreign.candidate.candidateId}).code,'NOT_FOUND');
 assert.equal(cmd('learning-review',{id:candidate.candidate.candidateId,version:999,decision:'approve'}).code,'CONFLICT');
 assert.equal(cmd('candidate-read',{id:candidate.candidate.candidateId}).item.body,'共享的经验');
 assert(cmd('learning-review',{id:candidate.candidate.candidateId,version:candidate.candidate.version,decision:'approve'}).ok);
 const resource=cmd('resources').rows[0];assert.equal(resource.title,'安全学习样例');assert(cmd('resource-retire',{id:resource.resource_id}).ok);
 assert.equal(app.listOrgResources(a).resources.length,0);
 const reject=app.submitLearningCandidate(a,{kind:'memory',title:'待修订',body:'没有根据'});assert(reject.ok);assert(cmd('learning-review',{id:reject.candidate.candidateId,version:reject.candidate.version,decision:'reject'}).ok);
 assert(app.ingestKnowledge(admin,{docId:'source-governance',title:'来源',format:'markdown',body:'# 标题\n\n原始事实',aclGroup:'readers'}).ok);
 assert(app.draftWiki(a,{pageId:'wiki-governance',title:'知识页',body:'根据来源',sourceDocIds:['source-governance']}).ok);assert(app.submitWikiReview(a,'wiki-governance').ok);
 assert(cmd('wiki-review',{id:'wiki-governance',revision:1,decision:'approve'}).ok);assert(app.getPublishedWiki(a,'wiki-governance').ok);
 assert(cmd('original-revoke',{id:'source-governance'}).ok);assert.equal(app.getPublishedWiki(a,'wiki-governance').code,'CONFLICT');
 assert(app.requestOwnQuota(a,{requestId:'gov-increase',additionalTokens:1000}).ok);assert.equal(cmd('quota-requests').rows[0].request_id,'gov-increase');
 assert(app.reserve(a,{requestId:'gov-model'}).ok);assert.equal(cmd('usage').rows[0].request_id,'gov-model');assert.equal(cmd('usage',{},other).total,0);
 const text='PRIVATE-CONTENT-DO-NOT-EXPOSE';const upload=app.createUpload(a,{purpose:'artifact',byteSize:Buffer.byteLength(text),contentSha256:createHash('sha256').update(text).digest('hex'),idempotencyKey:'governance-private'});assert(upload.ok);assert(app.putUploadContent(a,upload.upload.uploadId,text).ok);assert(app.completeUpload(a,upload.upload.uploadId).ok);
 assert.equal(cmd('uploads').total,1);assert(!JSON.stringify(cmd('uploads')).includes(text));assert.equal(cmd('uploads',{},other).total,0);
 assert.equal(cmd('audit-query',{pageSize:1}).rows.length,1);assert(cmd('audit-query',{action:'learning_reject'}).rows.some(r=>r.target===reject.candidate.candidateId));
 assert.equal(cmd('audit-query',{actor:'other-admin'}).total,0);assert.equal(cmd('audit-query',{q:'%'}).total,0);assert.equal(cmd('audit-query',{from:'invalid'}).ok,false);assert.equal(cmd('audit-query',{page:-1}).ok,false);
 const first=cmd('audit-query',{pageSize:1,page:1}),second=cmd('audit-query',{pageSize:1,page:2});assert.notEqual(first.rows[0].id,second.rows[0].id);
 assert(app.ensureChannelInstallation(admin,{channel:'feishu',channelTenantId:'tenant',appId:'app'}).ok);assert.equal(cmd('integrations').installations.length,1);assert.equal(cmd('integrations',{},other).installations.length,0);
 const backup=app.backup(admin);assert(backup.ok);app.close();const restored=restorePlatformSqlite(f.dataDir,backup.fileName);assert(restored.ok,restored.message);
 }finally{try{f.close();}catch{rmSync(f.dataDir,{recursive:true,force:true});}}
});

test('login limiter expires and HTTP rejects repeated failures with Retry-After',async()=>{
 let at=100;const guard=new LoginGuard(()=>at,2,4,1000);guard.record('ip','a',false);guard.record('ip','a',false);assert.equal(guard.retryAfter('ip','a'),1);assert.equal(guard.retryAfter('ip','b'),0);at+=1001;assert.equal(guard.retryAfter('ip','a'),0);
 const f=fixture(),server=await listenPlatform(f.app,{dataDir:f.dataDir,port:0,aiMockMode:true});
 try{const base='http://127.0.0.1:'+server.port;const body={employeeId:'admin',password:'wrong-credential',deviceLabel:'limiter-test'};for(let i=0;i<10;i++)assert.equal((await fetch(base+'/v1/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,401);const blocked=await fetch(base+'/v1/session/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(blocked.status,429);assert(Number(blocked.headers.get('retry-after'))>0);}finally{await server.close();f.close();}
});

test('organization connector controls survive restore and explicit unblock remains authoritative',()=>{
 const f=fixture();let live=f.app;
 const auth=app=>{const r=app.login({employeeId:'admin',password:'fixture-admin',deviceLabel:'policy-restore'});assert(r.ok);return r.accessToken;};
 try{let token=auth(live);const saved=live.market(token,'connector-save',{title:'回放控制',type:'MCP',target:'https://example.com/mcp',enabled:true});assert(saved.ok);const id=saved.connector.id;const backup=live.backup(token);assert(backup.ok);
 assert(live.admin(token,'connector-control',{id,blocked:true,revision:0}).ok);live.close();assert(restorePlatformSqlite(f.dataDir,backup.fileName).ok);let reopened=openPlatform(f.config);assert(reopened.ok);live=reopened.app;token=auth(live);assert.equal(live.market(token,'list',{}).connectors[0].enabled,false);
 assert(live.admin(token,'connector-control',{id,blocked:false,revision:1}).ok);live.close();assert(restorePlatformSqlite(f.dataDir,backup.fileName).ok);reopened=openPlatform(f.config);assert(reopened.ok);live=reopened.app;token=auth(live);assert.equal(live.market(token,'list',{}).connectors[0].enabled,true);assert.equal(live.admin(token,'connectors',{}).rows[0].policyRevision,2);
 }finally{live.close();f.close();}
});
