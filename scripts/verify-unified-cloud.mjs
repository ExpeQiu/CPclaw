// Installed/built runtime against deployed platform; synthetic inputs only, no user workspace.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const bundle=resolve(process.argv[2]||'/Applications/CPclaw.app');
const base=process.env.CPCLAW_PLATFORM_URL||'http://47.113.225.93:3928';
const employeeId=process.env.CPCLAW_VERIFY_EMPLOYEE||'employee-a';
const password=process.env.CPCLAW_VERIFY_PASSWORD||'fixture-employee-a';
process.env.CPCLAW_HARNESS_BUNDLE=join(bundle,'Contents/Resources/harness');
process.env.CPCLAW_NODE_BINARY=join(bundle,'Contents/Resources/runtime/bin/node');
const {createChatService}=await import(pathToFileURL(join(bundle,'Contents/Resources/app/chat-service.mjs')));
let passed=false;
const temp=mkdtempSync('/tmp/cpclaw-unified-cloud-'),events=[],service=createChatService(temp,e=>events.push(e));
try{
 const call=(method,input={})=>service.dispatch(method,employeeId,input);
 assert((await call('account.login',{platformUrl:base,employeeId,password})).ok,'verification account login failed');
 const c=(await call('chat.create')).chatId;
 const ordinary=await call('chat.send',{chatId:c,requestId:crypto.randomUUID(),text:'这是部署管道验收，只需回复“管道验收通过”，不要使用工具。'});
 assert.equal(ordinary.state,'done',ordinary.error);assert(ordinary.content.includes('管道验收通过'));
 const document=await call('chat.send',{chatId:c,requestId:crypto.randomUUID(),text:'这是同一会话的第二个验收输入。请使用 deliver_document 工具保存一份验收 Markdown 文件：documentKey 为 cloud-check，filename 为 cloud-check.md，part 为 0，content 为“# 云端管道验收\n合成验证材料，无用户业务数据。\n”，complete 为 true。工具成功后仅回复“文档验收通过”。无需调用其他工具。'});
 assert.equal(document.state,'done',document.error);assert.equal(document.artifacts.length,1,JSON.stringify({content:document.content,activities:document.activities}));assert.equal(readFileSync(document.artifact.path,'utf8').trimEnd(),'# 云端管道验收\n合成验证材料，无用户业务数据。');
 assert(events.some(e=>e.type==='delta'));assert.equal(new Set(events.filter(e=>e.type==='start').map(e=>e.chatId)).size,1);
 const out={passed:true,version:JSON.parse(readFileSync(join(bundle,'Contents/Resources/app/package.json'),'utf8')).version,platform:base,realProvider:true,packagedSdk:true,ordinaryChat:true,sameSessionDocument:true,nativeDocumentTool:true,streamedText:true,syntheticInputsOnly:true};
 if(process.env.CPCLAW_VERIFY_OUTPUT)writeFileSync(process.env.CPCLAW_VERIFY_OUTPUT,JSON.stringify(out,null,2)+'\n');
 passed=true;console.log(JSON.stringify(out));
}finally{await service.dispatch('account.logout',employeeId,{});service.stop();if(passed)rmSync(temp,{recursive:true,force:true});else console.error('Synthetic diagnostic directory: '+temp);}
