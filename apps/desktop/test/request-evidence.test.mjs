import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';import {join} from 'node:path';
import {createRequestEvidence,evidenceFinding} from '../request-evidence.mjs';import {readRecentLogs} from '../desktop-log.mjs';

test('interrupted requests survive restart without claiming tools did not execute',()=>{
 const db=new DatabaseSync(':memory:');const store=createRequestEvidence(db);store.save({requestId:'request-a',chatId:'chat-a',messageId:'message-a',state:'running',route:'harness',toolAttempts:[{action:'call',state:'running'}]});
 const resumed=createRequestEvidence(db).read('request-a');assert.equal(resumed.code,'DESKTOP_PROCESS_INTERRUPTED');assert.equal(resumed.state,'interrupted');assert.match(evidenceFinding(resumed,false).detail,/不能证明外部操作未发生/);db.close();
});
test('chat log filtering includes rotated evidence and excludes other chats',()=>{
 const root=mkdtempSync('/tmp/cpclaw-log-evidence-');mkdirSync(join(root,'logs'));
 const row=(chatId,event)=>JSON.stringify({timestamp:'2026-11-05T06:00:00Z',level:'error',service:'cpclaw-desktop-worker',event,message:'failure',fields:{chatId,traceId:'trace-a',code:'MODEL_OUTPUT_LIMIT',stage:'model_stream'}})+'\n';
 try{writeFileSync(join(root,'logs/desktop-worker.log.1'),row('chat-a','chat_request_finished'));writeFileSync(join(root,'logs/desktop-worker.log'),row('chat-b','chat_diagnosed').repeat(50));const logs=readRecentLogs(root,{chatId:'chat-a',limit:10});assert.equal(logs.length,1);assert.equal(logs[0].traceId,'trace-a');assert.equal(logs[0].code,'MODEL_OUTPUT_LIMIT');}finally{rmSync(root,{recursive:true,force:true});}
});

test('reasoning-only cutoff exposes count evidence without private reasoning',()=>{const finding=evidenceFinding({code:'MODEL_OUTPUT_LIMIT',state:'error',requestId:'reasoning-cutoff',stage:'model_stream',diagnostic:{finishReason:'length',textChars:0,reasoningChars:4096}},false);assert.match(finding.detail,/正文 0 字符；推理 4096 字符/);});
