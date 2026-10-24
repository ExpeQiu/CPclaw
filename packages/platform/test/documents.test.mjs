import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,realpathSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspaceClient} from '../../../apps/desktop/workspace-client.mjs';
import {openPlatform,listenPlatform,fixtureEmployees} from '../dist/index.js';
import {documentModelFixture} from '../../../scripts/document-model-fixture.mjs';
import {performDocumentAction} from '../../../apps/desktop/document-actions.mjs';

test('文档交付：自动落盘、历史恢复、版本修改、隔离、冲突、失败与另存为',async()=>{
 let documentMode=false,slow=false;
 const upstream=documentModelFixture(({context})=>documentMode?{kind:'document',slow,content:'# 资料整理\n\n## 步骤\n核对来源。\n\n## 验收标准\n'+(slow?'内容'.repeat(1500):context.active?'增加了验收标准。':'检查内容。')}:{kind:'answer'});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const dataDir=mkdtempSync('/tmp/cpclaw-doc-platform-'),localDir=mkdtempSync('/tmp/cpclaw-doc-desktop-');
 const opened=openPlatform({dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'documents-test-secret-0123456789abcdef',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:true,now:()=>Date.now()});assert.ok(opened.ok);
 const server=await listenPlatform(opened.app,{dataDir,port:0,aiMockMode:false,reportGateway:{mode:"real",baseUrl:`http://127.0.0.1:${upstream.address().port}`,apiKey:"test",timeoutMs:5000}});
 let worker=createWorkspaceClient(localDir,fileURLToPath(new URL('../../../apps/desktop',import.meta.url)));
 let actor='employee-a';const call=(method,input={})=>worker.request({method,input,actorId:actor});
 const login=id=>{actor=id;return call('account.login',{platformUrl:`http://127.0.0.1:${server.port}`,employeeId:id,password:`fixture-${id}`});};
 try{
  assert.ok((await login('employee-a')).ok);const {chatId}=await call('chat.create');
  const plain=await call('chat.send',{chatId,requestId:'plain',text:'你好'});assert.equal(plain.state,'done');assert.equal(plain.artifact,null);
  documentMode=true;
  const first=await call('chat.send',{chatId,requestId:'doc-1',text:'帮我准备一份明天会上可以直接用的资料整理提纲'});assert.equal(first.state,'done');assert.ok(first.artifact,first.artifactError);
  const a=first.artifact;assert.equal(a.name,'x.md');assert.equal(a.revision,1);assert.ok(existsSync(a.path));
  const read=await call('document.read',{id:a.id});assert.ok(read.ok);assert.equal(readFileSync(a.path,'utf8'),read.artifact.body);
  const replay=await call('document.create',{chatId,messageId:a.message});assert.equal(replay.artifact.id,a.id);
  assert.equal((await call('chat.history',{chatId})).artifacts.length,1);
  const edited=await call('chat.send',{chatId,requestId:'doc-2',text:'增加验收标准',documentId:a.id,expectedHash:read.artifact.currentHash});assert.ok(edited.artifact,edited.artifactError);assert.equal(edited.artifact.revision,2);assert.equal(edited.artifact.document_id,a.document_id);assert.equal(edited.artifact.name,'x.md');assert.notEqual(edited.artifact.path,a.path);assert.ok(existsSync(a.path));
  writeFileSync(a.path,'# 外部修改');const stale=await call('chat.send',{chatId,requestId:'doc-stale',text:'继续改',documentId:a.id,expectedHash:read.artifact.currentHash});assert.equal(stale.ok,false);assert.match(stale.message,/已变化/);
  assert.equal((await call('document.read',{id:a.id})).artifact.externalChange,true);
  const destination=join(localDir,'export.md');let openedPath='';let dialogCalls=0;
  const action=input=>performDocumentAction({input,actor,request:request=>worker.request(request),isCurrent:id=>id===actor,parent:null,dialog:{async showSaveDialog(_parent,options){dialogCalls++;assert.ok(options.properties.includes('showOverwriteConfirmation'));return {canceled:false,filePath:destination};}},shell:{async openPath(path){openedPath=path;return '';},showItemInFolder(path){openedPath=path;}}});
  assert.ok((await action({action:'saveAs',id:a.id})).ok);assert.equal(readFileSync(destination,'utf8'),'# 外部修改');assert.equal(dialogCalls,1);
  assert.ok((await action({action:'open',id:a.id})).ok);assert.equal(openedPath,realpathSync(a.path));
  rmSync(destination);symlinkSync(a.path,destination);assert.equal((await action({action:'saveAs',id:a.id})).ok,false);rmSync(destination);
  const changed=await performDocumentAction({input:{action:'saveAs',id:a.id},actor,request:r=>worker.request(r),isCurrent:id=>id===actor,parent:null,dialog:{async showSaveDialog(){actor='employee-b';return {canceled:false,filePath:destination};}},shell:{}});assert.equal(changed.ok,false);assert.equal(existsSync(destination),false);actor='employee-a';
  const cancelled=await call('chat.send',{chatId,requestId:'cancel-doc',text:'创建报告文档'});assert.ok(cancelled.artifact);
  const failedChat=await call('chat.create');let stopTimer;
  // 停止发生在流式回复完成前，不应创建文档。
  slow=true;
  const pending=call('chat.send',{chatId:failedChat.chatId,requestId:'stop-doc',text:'生成一份文档，'+ '内容'.repeat(1500)});
  stopTimer=setTimeout(()=>{void call('chat.cancel',{chatId:failedChat.chatId});},100);
  const stopped=await pending;clearTimeout(stopTimer);assert.equal(stopped.state,'cancelled');assert.equal((await call('document.list',{chatId:failedChat.chatId})).artifacts.length,0);
  worker.stop();worker=createWorkspaceClient(localDir,fileURLToPath(new URL('../../../apps/desktop',import.meta.url)));
  assert.ok((await call('chat.history',{chatId})).artifacts.some(item=>item.id===a.id));
  assert.ok((await login('employee-b')).ok);assert.equal((await call('document.read',{id:a.id})).ok,false);assert.equal((await call('document.list',{chatId})).ok,false);
 }finally{worker.stop();await server.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));rmSync(dataDir,{recursive:true,force:true});rmSync(localDir,{recursive:true,force:true});}
});
