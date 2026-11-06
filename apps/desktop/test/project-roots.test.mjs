import {test} from 'node:test';
import {fixture} from './fixtures/unified.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createProjectStore} from '../project-service.mjs';
import {createConversationPermissions} from '../conversation-permissions.mjs';
import {createServiceRuntime} from '../service-runtime.mjs';
import {localService} from '../local-tools.mjs';

test('a project keeps its chosen folders and refuses paths outside that list',()=>{
  const root=mkdtempSync('/tmp/cpclaw-project-roots-'),primary=join(root,'main'),extra=join(root,'notes'),outside=join(root,'private');
  mkdirSync(primary);mkdirSync(extra);mkdirSync(outside);
  const db=new DatabaseSync(join(root,'chat.sqlite'));
  db.exec('CREATE TABLE chats(id TEXT PRIMARY KEY)');
  const store=createProjectStore(db);
  try{
    const project=store.create('employee-a',primary);
    assert.equal(project.roots.length,1);assert.equal(project.roots[0].primary,true);
    const saved=store.saveRoots('employee-a',project.id,{name:'资料项目',folders:[...project.roots,{path:extra,primary:false}]});
    assert.equal(saved.name,'资料项目');assert.equal(saved.roots.length,2);
    assert.throws(()=>store.saveRoots('employee-a',project.id,{name:'资料项目',folders:[{path:homedir(),primary:false},{path:primary,primary:true}]}),/具体文件夹/);
    assert.throws(()=>store.saveRoots('employee-a',project.id,{name:'资料项目',folders:[{path:extra,primary:true},{path:primary,primary:true}]}),/一个主要文件夹/);
    store.remove('employee-a',project.id);
    assert.throws(()=>store.get('employee-a',project.id),/不存在/);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});

test('file tools can use listed folders without another prompt and cannot use anything else',async()=>{
  const root=mkdtempSync('/tmp/cpclaw-project-scope-'),primary=join(root,'main'),extra=join(root,'notes'),outside=join(root,'private');
  mkdirSync(primary);mkdirSync(extra);mkdirSync(outside);
  writeFileSync(join(extra,'note.txt'),'listed');writeFileSync(join(outside,'secret.txt'),'secret');
  symlinkSync(join(outside,'secret.txt'),join(extra,'link.txt'));
  const context={actorId:'employee-a',chatId:'c'};
  const policy=createConversationPermissions();policy.set(context,'auto');const approvals=[];
  const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>true,getPermission:c=>policy.get(c),approve:async request=>{approvals.push(request);return false;}});
  const execute=request=>runtime.execute({...context,taskId:'task-1',service:localService,workingDirectory:primary,projectRoot:primary,projectRoots:[primary,extra]},request,new AbortController().signal);
  try{
    assert.equal((await execute({action:'read_file',path:join(extra,'note.txt')})).content,'listed');
    assert.equal((await execute({action:'write_file',path:join(extra,'out.txt'),content:'written'})).verified,true);
    assert.equal(readFileSync(join(extra,'out.txt'),'utf8'),'written');
    await assert.rejects(execute({action:'read_file',path:join(extra,'link.txt')}),error=>error.code==='OUT_OF_SCOPE');
    await assert.rejects(execute({action:'read_file',path:join(outside,'secret.txt')}),error=>error.code==='OUT_OF_SCOPE');
    await assert.rejects(execute({action:'terminal',command:'pwd',cwd:outside}),error=>error.code==='OUT_OF_SCOPE');
    assert.equal(approvals.length,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('question answering searches folders, then knowledge, then the web',async t=>{
  let context='';
  const f=fixture(t,async input=>{context=input.pipeline.context;input.onAccepted('accepted');return {finalResponse:'已回答'};});
  try{
    const chatId=await f.create();
    assert.equal((await f.send(chatId,'这个问题的依据是什么')).state,'done');
    const folder=context.indexOf('可访问文件夹'),knowledge=context.indexOf('知识库'),web=context.indexOf('互联网');
    assert.ok(folder>=0&&folder<knowledge&&knowledge<web);
  }finally{f.stop();}
});
