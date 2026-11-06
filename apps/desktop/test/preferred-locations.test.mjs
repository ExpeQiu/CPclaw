import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createConversationPermissions} from '../conversation-permissions.mjs';
import {createServiceRuntime} from '../service-runtime.mjs';
import {localService} from '../local-tools.mjs';
import {addPreferredLocation,listPreferredLocations,removePreferredLocation,PREFERRED_LOCATION_LIMIT} from '../preferred-locations.mjs';

const context={actorId:'employee-a',chatId:'c'};

test('preferred locations persist per account and refuse broad or extra folders',()=>{
  const root=mkdtempSync('/tmp/cpclaw-preferred-store-');
  const folder=join(root,'notes');mkdirSync(folder);
  try{
    assert.equal(addPreferredLocation(root,'',folder).ok,false);
    assert.equal(addPreferredLocation(root,'employee-a',homedir()).ok,false);
    assert.equal(addPreferredLocation(root,'employee-a','/').ok,false);
    const added=addPreferredLocation(root,'employee-a',folder);
    assert.equal(added.ok,true);assert.equal(added.locations.length,1);
    assert.equal(addPreferredLocation(root,'employee-a',folder).reused,true);
    assert.equal(listPreferredLocations(root,'employee-b').length,0);
    const made=[];
    for(let i=0;i<PREFERRED_LOCATION_LIMIT;i++){const path=join(root,`d${i}`);mkdirSync(path);made.push(path);addPreferredLocation(root,'employee-a',path);}
    const extra=join(root,'overflow');mkdirSync(extra);
    const rejected=addPreferredLocation(root,'employee-a',extra);
    assert.equal(rejected.ok,false);assert.equal(rejected.locations.length,PREFERRED_LOCATION_LIMIT);
    const stored=listPreferredLocations(root,'employee-a')[0].path;
    const removed=removePreferredLocation(root,'employee-a',stored);
    assert.equal(removed.locations.some(item=>item.path===stored),false);
    assert.equal(removed.locations.length,PREFERRED_LOCATION_LIMIT-1);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('auto mode remembers reads and writes inside a preferred folder and still asks outside it',async()=>{
  const root=mkdtempSync('/tmp/cpclaw-preferred-tools-'),project=join(root,'project'),folder=join(root,'saved'),outside=join(root,'outside');
  mkdirSync(project);mkdirSync(folder);mkdirSync(outside);
  writeFileSync(join(folder,'note.txt'),'saved note');writeFileSync(join(outside,'secret.txt'),'secret');
  symlinkSync(join(outside,'secret.txt'),join(folder,'link.txt'));
  const added=addPreferredLocation(root,'employee-a',folder);assert.equal(added.ok,true);
  const policy=createConversationPermissions();policy.set(context,'auto');const approvals=[];
  const runtime=createServiceRuntime({dataDir:root,isCurrent:()=>true,getPermission:c=>policy.get(c),approve:async request=>{approvals.push(request);return false;}});
  const execute=request=>runtime.execute({...context,taskId:'task-1',service:localService,workingDirectory:project,projectRoot:project},request,new AbortController().signal);
  try{
    assert.equal((await execute({action:'read_file',path:join(folder,'note.txt')})).content,'saved note');
    const saved=await execute({action:'write_file',path:join(folder,'out.txt'),content:'written'});
    assert.equal(saved.verified,true);assert.equal(readFileSync(join(folder,'out.txt'),'utf8'),'written');
    await assert.rejects(execute({action:'read_file',path:join(folder,'link.txt')}),error=>error.code==='DENIED');
    await assert.rejects(execute({action:'read_file',path:join(outside,'secret.txt')}),error=>error.code==='DENIED');
    await assert.rejects(execute({action:'write_file',path:join(project,'new.txt'),content:'blocked'}),error=>error.code==='DENIED');
    await assert.rejects(execute({action:'terminal',command:'pwd',cwd:folder}),error=>error.code==='DENIED');
    assert.equal(approvals.length,4);
    assert.equal(approvals.filter(item=>item.risk==='preferred').length,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});
