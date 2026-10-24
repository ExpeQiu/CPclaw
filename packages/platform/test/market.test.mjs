import test from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { openPlatform, listenPlatform, fixtureEmployees } from '../dist/index.js';
import { createWorkspaceClient } from '../../../apps/desktop/workspace-client.mjs';
import { readSkillZip } from '../../../apps/desktop/chat-service.mjs';
import { fileURLToPath } from 'node:url';

test('市场：空目录、组织隔离、审核、撤回、持久化与真实桌面工作进程链路', async()=>{
 const dataDir=mkdtempSync('/tmp/cpclaw-market-'), desktopDir=mkdtempSync('/tmp/cpclaw-market-desktop-');
 const config={dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'market-test-secret-0123456789abcdef',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:()=>Date.now()};
 let opened=openPlatform(config);assert.ok(opened.ok);let app=opened.app;
 const login=id=>{const r=app.login({employeeId:id,password:'fixture-'+id,deviceLabel:'market-test'});assert.ok(r.ok);return r.accessToken;};
 let a=login('employee-a'),b=login('employee-b'),c=login('employee-c'),admin=login('admin');
 const call=(t,action,input={})=>app.market(t,action,input);
 assert.deepEqual(call(a,'list').items,[]);
 const draft={title:'测试技能',kind:'skill',description:'用于验证',body:'# 方法\n先核对来源，再输出结论。',source:'manual',version:'1.0.0',members:[]};
 const saved=call(a,'save',draft);assert.ok(saved.ok);const id=saved.item.id;
 assert.equal(call(b,'list').items.length,0);assert.equal(call(b,'save',{...draft,id}).ok,false);
 assert.equal(call(a,'install',{id}).ok,false);assert.ok(call(a,'personal',{id}).ok);assert.ok(call(a,'install',{id}).ok);
 assert.ok(call(a,'submit',{id}).ok);assert.equal(call(a,'review',{id,decision:'approve'}).ok,false);
 assert.equal(call(admin,'review',{id,decision:'reject'}).ok,false);
 assert.ok(call(admin,'review',{id,decision:'reject',note:'补充来源'}).ok);assert.equal(call(a,'list').items[0].note,'补充来源');
 assert.ok(call(a,'save',{...draft,id}).ok);assert.ok(call(a,'submit',{id}).ok);assert.ok(call(admin,'review',{id,decision:'approve'}).ok);
 assert.equal(call(a,'save',{...draft,id}).ok,false);assert.equal(call(c,'list').items.length,0);assert.equal(call(b,'list').items.length,1);
 assert.ok(call(b,'install',{id}).ok);assert.ok(call(b,'toggle',{id,enabled:false}).ok);assert.equal(call(b,'list').installs[0].enabled,0);
 const expert=call(admin,'save',{...draft,kind:'expert',members:[id]});assert.ok(expert.ok);assert.ok(call(admin,'submit',{id:expert.item.id}).ok);assert.ok(call(admin,'review',{id:expert.item.id,decision:'approve'}).ok);
 assert.equal(call(a,'connector-save',{title:'MCP',type:'MCP',target:'https://user:secret@example.com'}).ok,false);
 assert.ok(call(a,'connector-save',{title:'MCP',type:'MCP',target:'https://example.com/mcp'}).ok);assert.equal(call(b,'list').connectors.length,0);
 app.close();opened=openPlatform(config);assert.ok(opened.ok);app=opened.app;a=login('employee-a');admin=login('admin');assert.equal(call(a,'list').connectors.length,1);assert.equal(call(a,'list').installs.length,1);
 const server=await listenPlatform(app,{port:0,dataDir,aiMockMode:true});const base=`http://127.0.0.1:${server.port}`;
 const worker=createWorkspaceClient(desktopDir,fileURLToPath(new URL('../../../apps/desktop', import.meta.url)));
 const request=(method,input={},actorId='employee-a')=>worker.request({method,input,actorId});
 try {
  assert.equal((await fetch(base+'/v1/market',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.ok((await request('account.login',{platformUrl:base,employeeId:'employee-a',password:'fixture-employee-a'})).ok);
  const page=await request('market.page');assert.ok(page.ok);assert.match(page.html,/技能创作/);
  assert.ok((await request('market.call',{action:'list'})).ok);
  const generated=await request('market.generate',{title:'信息检查',description:'检查来源'});assert.ok(generated.ok,generated.message);assert.equal(generated.mode,'mock');
  const cli=await request('market.call',{action:'connector-save',input:{title:'Node',type:'CLI',target:process.execPath}});assert.ok(cli.ok);
  const probe=await request('market.probe',{id:cli.connector.id});assert.equal(probe.ok,false);assert.equal(probe.code,'LOCAL_EXECUTION_REQUIRED');assert.equal(probe.localExecution.target,process.execPath);
  const mcp=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',serverInfo:{name:'test-mcp',version:'1'},capabilities:{}}}));});
  await new Promise(resolve=>mcp.listen(0,'127.0.0.1',resolve));
  try { const connector=await request('market.call',{action:'connector-save',input:{title:'测试 MCP',type:'MCP',target:`http://127.0.0.1:${mcp.address().port}/mcp`}});assert.ok(connector.ok);assert.match((await request('market.probe',{id:connector.connector.id})).message,/握手通过/); } finally {await new Promise(resolve=>mcp.close(resolve));}
  const used=await request('market.use',{id});assert.ok(used.ok,used.message);
  const sent=await request('chat.send',{chatId:used.chatId,text:'请检查材料',requestId:'market-send'});assert.ok(sent.ok,sent.message);
  assert.ok(call(admin,'withdraw',{id}).ok);assert.equal(call(a,'install',{id:expert.item.id}).ok,false);
  const denied=await request('chat.send',{chatId:used.chatId,text:'继续',requestId:'market-denied'});assert.equal(denied.state,'error');
  assert.equal((await request('market.call',{action:'list'},'employee-b')).ok,false);
 } finally {worker.stop();await server.close();rmSync(dataDir,{recursive:true,force:true});rmSync(desktopDir,{recursive:true,force:true});}
});

test('压缩包读取拒绝非 ZIP 和超限内容',()=>{assert.throws(()=>readSkillZip(Buffer.from('bad').toString('base64')),/SKILL/);assert.throws(()=>readSkillZip('a'.repeat(400001)),/300KB/);});

test("ZIP 正常解压及 CRC 损坏检查",()=>{const encoded="UEsDBBQAAAAIAOp2V11ZXlx/FQAAABMAAAANAAAAZGVtby9TS0lMTC5tZFNWcEnNzecKLU5VKM4vLUpOLdYDAFBLAQIUAxQAAAAIAOp2V11ZXlx/FQAAABMAAAANAAAAAAAAAAAAAACAAQAAAABkZW1vL1NLSUxMLm1kUEsFBgAAAAABAAEAOwAAAEAAAAAAAA==";const files=readSkillZip(encoded);assert.equal(files[0].path,"demo/SKILL.md");assert.match(files[0].body,/# Demo/);const bad=Buffer.from(encoded,"base64");bad[14]^=1;assert.throws(()=>readSkillZip(bad.toString("base64")),/校验/);});
