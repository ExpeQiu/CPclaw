import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
const source=readFileSync(new URL('../renderer/chat.js',import.meta.url),'utf8');const start=source.indexOf('async function sendChat('),end=source.indexOf('window.cpclaw.onChatEvent',start);const sendCode=source.slice(start,end);
async function run(text,retry=false){
 const note={value:text},calls=[],messages=[{id:'original-user',role:'user',content:'原任务'},{id:'original-reply',role:'assistant',state:'error',safeToRetry:true,request:'old'}];
 const context={chats:[{id:'chat-a',archived:false}],chatNeedsMigration:false,runningChatIds:new Set(),runningChatId:'',chatIsRunning(id=context.currentChatId){return Boolean(id&&context.runningChatIds.has(id));},markChatRunning(id,running){if(running)context.runningChatIds.add(id);else context.runningChatIds.delete(id);},chatAccount:'a',currentChatId:'chat-a',currentProjectId:'p',chatExecution:{mode:'chat',service:''},chatMessages:messages,chatDrafts:new Map(),nearBottom:false,attachedProjectFile:null,editingArtifact:null,crypto:{randomUUID:()=> 'new-attempt'},byId:()=>note,chatCall:async(method,input)=>{calls.push({method,input});return {ok:true};},renderChat(){},setStatus(){},loadChats:async()=>{},addArtifact(){},openPanel(){},selectChat:async()=>{}};
 vm.createContext(context);vm.runInContext(sendCode+';globalThis.runSend=sendChat',context);await context.runSend(retry);return {calls,messages,note};
}
test('continue is sent as a new original message instead of being rewritten to retry',async()=>{
 const r=await run('继续原任务');const call=r.calls.find(c=>c.method==='chat.send');assert.equal(call.input.retry,undefined);assert.equal(call.input.text,'继续原任务');assert.equal(r.messages.length,4);assert.equal(r.messages.filter(m=>m.role==='user').length,2);assert.equal(r.messages[0].id,'original-user');assert.equal(r.note.value,'');
});
test('a follow-up with new requirements remains a new message',async()=>{
 const r=await run('继续补充新的需求');const call=r.calls.find(c=>c.method==='chat.send');assert.equal(call.input.retry,undefined);assert.equal(call.input.text,'继续补充新的需求');assert.equal(r.messages.filter(m=>m.role==='user').length,2);
});
