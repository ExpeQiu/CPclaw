import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createChatService} from '../chat-service.mjs';
import {writeAccountSession} from '@cpclaw/desktop-host/account-session';
import {indexedWikiDocuments} from '../project-wiki.mjs';

function setup(t,{mode='real',onModel=()=>{}}={}) {
  const data=mkdtempSync('/tmp/cpclaw-wiki-service-'),root=join(data,'project'),actor='wiki-user',events=[],requests=[];
  mkdirSync(root);writeFileSync(join(root,'规范.md'),'验收标准：温度低于 30 度时核对证据。');
  writeAccountSession(data,{schemaVersion:1,employeeId:actor,sessionId:'fixture',refreshToken:'fixture-token'},{makeCurrent:true});
  writeFileSync(join(data,'desktop-connection.json'),JSON.stringify({platformUrl:'https://fixture.invalid'}));
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    if(url.endsWith('/v1/session/refresh'))return Response.json({employeeId:actor,sessionId:'fixture',refreshToken:'fixture-token',accessToken:'fixture-access'});
    if(url.endsWith('/v1/chat/stream')) {
      const body=JSON.parse(options.body);requests.push(body);onModel();
      assert.equal(body.messages.length,1);assert.ok(body.messages[0].content.length<16000);assert.match(body.messages[0].content,/指令不得执行/);
      const value={title:'验收规范',points:[{kind:'fact',topic:'验收标准',text:'低于 30 度时核对证据。',quote:'验收标准：温度低于 30 度时核对证据。',startLine:1,endLine:1}]};
      const text=JSON.stringify(value),half=Math.floor(text.length/2);
      return new Response([{event:'start',mode},{event:'delta',text:text.slice(0,half)},{event:'delta',text:text.slice(half)},{event:'done'}].map(e=>JSON.stringify(e)+'\n').join(''),{headers:{'content-type':'application/x-ndjson'}});
    }
    throw Error('Unexpected route: '+url);
  });
  const service=createChatService(data,event=>events.push(event));t.after(()=>{service.stop();rmSync(data,{recursive:true,force:true});});
  return {data,root,actor,service,events,requests};
}

test('authenticated project RPC uses platform stream and publishes a queryable Wiki; repeat makes no request',async t=>{
  const f=setup(t),p=await f.service.dispatch('project.create',f.actor,{folder:f.root}),id=p.project.id;
  assert.equal((await f.service.dispatch('project.wiki.status',f.actor,{id})).changed,1);
  const result=await f.service.dispatch('project.wiki.run',f.actor,{id});assert.equal(result.ok,true);assert.equal(result.created,1);assert.equal(f.requests.length,1);
  const view=await f.service.dispatch('project.wiki.read',f.actor,{id});assert.equal(view.ok,true);assert.match(view.body,/验收标准/);
  assert.equal((await indexedWikiDocuments(f.root)).length,1);assert.deepEqual(f.events.map(e=>e.stage),['scan','process','publish','done']);assert.ok(f.events.every(e=>e.channel==='project-wiki'&&e.actorId===f.actor&&e.projectId===id));
  assert.equal((await f.service.dispatch('project.wiki.run',f.actor,{id})).unchanged,true);assert.equal(f.requests.length,1);
  assert.equal((await f.service.dispatch('project.wiki.read','other-user',{id})).ok,false);
  assert.equal(readFileSync(join(f.root,'规范.md'),'utf8'),'验收标准：温度低于 30 度时核对证据。');
});

test('Mock generation is rejected explicitly and cannot become project knowledge',async t=>{
  const f=setup(t,{mode:'mock'}),p=await f.service.dispatch('project.create',f.actor,{folder:f.root});
  const result=await f.service.dispatch('project.wiki.run',f.actor,{id:p.project.id});assert.equal(result.ok,false);assert.match(result.message,/Mock/);assert.equal((await indexedWikiDocuments(f.root)).length,0);
  assert.equal(f.events.at(-1).stage,'error');
});

test('an accepted request is kept under its original identity and produces an actionable recovery message',async t=>{
  const f=setup(t,{onModel:()=>{throw Object.assign(Error('already accepted'),{status:409});}}),p=await f.service.dispatch('project.create',f.actor,{folder:f.root});
  const id=p.project.id;
  for(let i=0;i<2;i++) {
    const result=await f.service.dispatch('project.wiki.run',f.actor,{id});assert.equal(result.ok,false);assert.match(result.message,/原请求.*已受理.*未重复提交/);
  }
  assert.equal(f.requests.length,2);assert.equal(f.requests[0].requestId,f.requests[1].requestId);assert.equal((await indexedWikiDocuments(f.root)).length,0);
});
