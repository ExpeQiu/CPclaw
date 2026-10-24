import {documentModelFixture} from '../../../scripts/document-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,symlinkSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {openPlatform,listenPlatform,fixtureEmployees} from '../dist/index.js';
import {createWorkspaceClient} from '../../../apps/desktop/workspace-client.mjs';
import {createKnowledgeStore,knowledgeSnippets} from '../../../apps/desktop/knowledge-service.mjs';

test('知识库：企业授权、个人隔离、版本冲突、平台接口及桌面真实工作进程',async()=>{
 const dir=mkdtempSync('/tmp/cpclaw-knowledge-');
 const config={dataDir:join(dir,'platform'),port:0,listenHost:'127.0.0.1',sessionSecret:'knowledge-secret-0123456789abcdef',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:()=>Date.now()};
 let app,server,worker,upstream;
 const modelInputs=[];
 try{
  const opened=openPlatform(config);assert.ok(opened.ok);app=opened.app;
  const login=id=>{const r=app.login({employeeId:id,password:'fixture-'+id,deviceLabel:'knowledge'});assert.ok(r.ok);return r.accessToken;};
  const admin=login('admin'),a=login('employee-a'),b=login('employee-b'),c=login('employee-c');
  const call=(token,action,input={})=>app.knowledge(token,action,input);
  assert.equal(call(a,'save',{scope:'enterprise',name:'越权'}).ok,false);
  const enterprise=call(admin,'save',{scope:'enterprise',name:'企业制度',members:['employee-a']});assert.ok(enterprise.ok,enterprise.message);
  const personal=call(a,'save',{scope:'personal',name:'我的笔记'});assert.ok(personal.ok);
  assert.equal(call(admin,'read',{id:personal.id}).ok,false);
  assert.equal(call(b,'read',{id:personal.id}).ok,false);
  assert.equal(call(c,'read',{id:enterprise.id}).ok,false);
  assert.equal(call(b,'read',{id:enterprise.id}).ok,false);
  assert.equal(call(a,'document-save',{id:enterprise.id,title:'冒充管理员',body:'bad'}).ok,false);
  const doc=call(admin,'document-save',{id:enterprise.id,title:'验收标准',body:'验收标准必须包含 KNOWLEDGE-873 和原始证据。'});assert.ok(doc.ok);
  assert.ok(call(a,'document-save',{id:personal.id,title:'个人验收记录',body:'验收记录 PERSONAL-998。'}).ok);
  assert.equal(call(admin,'document-save',{id:enterprise.id,documentId:doc.id,revision:0,title:'旧版本',body:'bad'}).code,'CONFLICT');
  assert.ok(call(admin,'document-save',{id:enterprise.id,documentId:doc.id,revision:1,title:'验收标准',body:'验收标准 KNOWLEDGE-873，核对证据。'}).ok);
  upstream=documentModelFixture(({body})=>{const prompt=body.messages.at(-1).content;modelInputs.push(prompt);return {kind:'document',filename:'验收报告.md',content:'# 验收报告\n\n企业制度 / 验收标准:L1 KNOWLEDGE-873\n我的本地笔记 / 验收.md:L1 LOCAL-552'};});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  server=await listenPlatform(app,{port:0,dataDir:config.dataDir,aiMockMode:false,reportGateway:{mode:'real',baseUrl:`http://127.0.0.1:${upstream.address().port}`,apiKey:'fixture',timeoutMs:5000}});const base=`http://127.0.0.1:${server.port}`;
  assert.equal((await fetch(base+'/v1/knowledge',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  worker=createWorkspaceClient(join(dir,'desktop'),fileURLToPath(new URL('../../../apps/desktop',import.meta.url)));
  const request=(method,input={},actorId='employee-a')=>worker.request({method,input,actorId});
  assert.ok((await request('account.login',{platformUrl:base,employeeId:'employee-a',password:'fixture-employee-a'})).ok);
  const remote=await request('knowledge.remote',{action:'list'});assert.ok(remote.ok,remote.message);assert.equal(remote.libraries.length,2);
  const linked=await request('knowledge.link',{kind:'platform',scope:'enterprise',target:enterprise.id});assert.ok(linked.ok,linked.message);
  assert.equal((await request('knowledge.link',{kind:'platform',scope:'personal',target:enterprise.id})).ok,false);
  const local=join(dir,'notes');mkdirSync(local);writeFileSync(join(local,'验收.md'),'验收标准 LOCAL-552。');
  const localLink=await request('knowledge.link',{kind:'local',scope:'personal',target:local});assert.ok(localLink.ok,localLink.message);
  const chat=await request('chat.create');assert.ok(chat.ok);
  assert.ok((await request('knowledge.choose',{chatId:chat.chatId,ids:[linked.link.id,localLink.link.id]})).ok);
  const sent=await request('chat.send',{chatId:chat.chatId,text:'根据验收标准生成报告',requestId:'knowledge-send'});assert.ok(sent.ok,sent.message);assert.equal(sent.state,'done');assert.match(modelInputs[0],/KNOWLEDGE-873/);assert.match(modelInputs[0],/LOCAL-552/);assert.ok(sent.artifact);const artifact=await request('document.read',{id:sent.artifact.id});assert.match(artifact.artifact.body,/KNOWLEDGE-873/);
  const history=await request('chat.history',{chatId:chat.chatId});const citations=history.messages.at(-1).knowledgeSources;assert.equal(citations.length,2);assert.ok(citations.some(s=>s.excerpt.includes('KNOWLEDGE-873')));assert.ok(citations.some(s=>s.excerpt.includes('LOCAL-552')));
  assert.ok(call(admin,'save',{id:enterprise.id,name:'企业制度',members:[]}).ok);
  const denied=await request('chat.send',{chatId:chat.chatId,text:'再查验收',requestId:'knowledge-revoked'});assert.equal(denied.state,'error');
  assert.equal((await request('knowledge.read',{id:linked.link.id})).ok,false);
  assert.equal((await request('knowledge.list',{},'employee-b')).ok,false);
  assert.ok((await request('knowledge.unlink',{id:linked.link.id})).ok);
  assert.equal((await request('knowledge.list',{chatId:chat.chatId})).selected.length,1);
  worker.stop();worker=null;
  app.close();app=null;await server.close();server=null;
  const reopened=openPlatform(config);assert.ok(reopened.ok);app=reopened.app;
  const newA=app.login({employeeId:'employee-a',password:'fixture-employee-a',deviceLabel:'reopen'});assert.equal(app.knowledge(newA.accessToken,'read',{id:personal.id}).documents.length,1);
 }finally{worker?.stop();await server?.close();if(upstream)await new Promise(resolve=>upstream.close(resolve));app?.close();rmSync(dir,{recursive:true,force:true});}
});

test('本地目录：跳过隐藏及符号链接、更新原子性、解除保留原文与账号隔离',()=>{
 const dir=mkdtempSync('/tmp/cpclaw-kb-local-'),db=new DatabaseSync(':memory:');
 try{const folder=join(dir,'notes');mkdirSync(folder);writeFileSync(join(folder,'a.md'),'制度要求保留原文');writeFileSync(join(folder,'.secret.md'),'秘密');symlinkSync(join(folder,'a.md'),join(folder,'link.md'));
 const store=createKnowledgeStore(db),link=store.link('a',{kind:'local',scope:'personal',target:folder});assert.equal(store.localDocuments('a',link.id).length,1);assert.throws(()=>store.get('b',link.id));
 writeFileSync(join(folder,'a.md'),'制度更新');store.refresh('a',link.id);assert.match(store.localDocuments('a',link.id)[0].body,/更新/);
 writeFileSync(join(folder,'large.txt'),'x'.repeat(512001));assert.throws(()=>store.refresh('a',link.id),/512KB/);assert.throws(()=>store.localDocuments('a',link.id),/更新失败/);rmSync(join(folder,'large.txt'));store.refresh('a',link.id);assert.equal(store.localDocuments('a',link.id).length,1);
 assert.throws(()=>store.entry('a',link.id,'../outside'));store.unlink('a',link.id);assert.equal(store.list('a').length,0);assert.equal(readFileSync(join(folder,'a.md'),'utf8'), '制度更新');
 const found=knowledgeSnippets([{id:'a',title:'制度',body:'制度更新',libraryName:'资料'}],'制度');assert.equal(found.sources.length,1);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
