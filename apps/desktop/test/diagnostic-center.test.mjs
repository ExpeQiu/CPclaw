import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createDiagnosticCenter} from '../diagnostic-center.mjs';

test('bundle redacts raw logs before export, excludes conversation bodies and retries the same upload',async()=>{
 const dataDir=mkdtempSync('/tmp/cpclaw-diagnostic-center-');mkdirSync(join(dataDir,'logs'));
 writeFileSync(join(dataDir,'logs/desktop-worker.log'),JSON.stringify({timestamp:'2026-10-29T00:00:00Z',event:'test_error',message:'api_key=hidden-api refreshToken=hidden-refresh Bearer hidden-bearer /Users/private/document https://example.com/log?token=hidden-query',fields:{chatId:'chat-a'}})+'\n');
 let actor='a',attempts=0;const bodies=[];
 const center=createDiagnosticCenter({dataDir,appVersion:'test',actorNow:()=>actor,refresh:async()=>({ok:true,employeeId:actor,accessToken:'fixture'}),
  chat:{dispatch:async()=>({ok:true,messages:[{id:'m',role:'assistant',state:'error',error:'PATH missing',content:'private-conversation'}],serviceSteps:[{step:1,service:{id:'local'},request:{action:'terminal',command:'private-command'},result:{ok:false,exitCode:127,stdout:'private-stdout'}}]})},
  fetcher:async(_url,options)=>{const body=JSON.parse(options.body);bodies.push(body);if(++attempts===1)throw Error('response lost after cloud acceptance');return Response.json({ok:true,upload:{uploadId:'upl-fixture',status:'available',contentSha256:body.idempotencyKey.slice(5)}});}});
 writeFileSync(join(dataDir,'desktop-connection.json'),JSON.stringify({platformUrl:'https://fixture.invalid'}));
 try{
  const result=await center.dispatch('check','a',{chatId:'chat-a',host:{kernel:{ready:true}}});assert(result.ok);
  const content=readFileSync(join(dataDir,'diagnostics',result.fileName),'utf8');
  for(const secret of ['hidden-api','hidden-refresh','hidden-bearer','hidden-query','/Users/private','private-conversation','private-command','private-stdout'])assert(!content.includes(secret),secret);
  assert.equal(JSON.parse(content).recentChat.operations[0].exitCode,127);
  await assert.rejects(center.dispatch('upload','a'),/response lost/);
  assert.equal((await center.dispatch('upload','a')).ok,true);assert.equal(bodies[0].idempotencyKey,bodies[1].idempotencyKey);assert.equal(bodies[0].content,bodies[1].content);
  actor='b';await assert.rejects(center.dispatch('upload','a'),/账号已变化/);
 }finally{rmSync(dataDir,{recursive:true,force:true});}
});
