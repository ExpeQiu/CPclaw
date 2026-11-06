// Real SDK subprocesses and durable sessions; only the external model gateway is mocked.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {register} from 'node:module';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const harnessRoot=process.env.CPCLAW_HARNESS_ROOT||resolve(root,'../../13 Github/deepseek-harness');
const packagedApp=process.argv[2]?resolve(process.argv[2]):null;
const tsconfig=join(harnessRoot,'tsconfig.base.json');
if(!packagedApp&&process.env.TSX_TSCONFIG_PATH!==tsconfig){
 const result=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url)],{cwd:root,env:{...process.env,TSX_TSCONFIG_PATH:tsconfig,CPCLAW_HARNESS_ROOT:harnessRoot},stdio:'inherit'});
 process.exit(result.status??1);
}
if(packagedApp)process.env.CPCLAW_HARNESS_BUNDLE=join(packagedApp,'Contents/Resources/harness');
else register(pathToFileURL(join(root,'scripts/harness-hooks.mjs')).href,{parentURL:import.meta.url,data:{harnessRoot}});
const adapter=packagedApp?pathToFileURL(join(packagedApp,'Contents/Resources/app/node_modules/@cpclaw/harness-adapter/dist/index.js')).href:'@cpclaw/harness-adapter';
const {runReportLoop}=await import(adapter);
const home=mkdtempSync('/tmp/cpclaw-native-sessions-'),requests=[];let accepted=0;
const platform=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 requests.push(JSON.parse(raw));
 const chunk=choice=>JSON.stringify({id:'chatcmpl-session-test',object:'chat.completion.chunk',model:'MiniMax-M3',choices:[choice]});
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.end(`data: ${chunk({index:0,delta:{role:'assistant',content:'session verified'},finish_reason:null})}\n\ndata: ${chunk({index:0,delta:{},finish_reason:'stop'})}\n\ndata: [DONE]\n\n`);
});
try{
 await new Promise((ok,no)=>{platform.once('error',no);platform.listen(0,'127.0.0.1',ok);});
 for(const [sessionId,goal] of [['chat-a','private-A-7264'],['chat-a','continue'],['chat-b','new task']]){
  const result=await runReportLoop({homeParent:home,sessionId,onAccepted:id=>{assert.equal(typeof id,'string');accepted++;},platformBase:'http://127.0.0.1:'+platform.address().port,accessToken:'fixture',goal,materials:[],signal:new AbortController().signal,beforeCall(){},unknownUsage(){},service:{context:'Answer briefly. Do not use tools.',execute:async()=>assert.fail('unexpected tool')}});
  assert.equal(result.finalResponse,'session verified');
  assert.equal(result.childCommandSeenAfterClose,false);
 }
 assert.equal(requests.length,3);assert.equal(accepted,3);
 assert(JSON.stringify(requests[1].messages).includes('private-A-7264'));
 assert(!JSON.stringify(requests[2].messages).includes('private-A-7264'));
 process.stdout.write(JSON.stringify({passed:true,mode:packagedApp?'mock-model-packaged-sdk':'mock-model-real-sdk',checks:['durable inbox receipt','native session restart recovery','cross-chat context isolation','child process cleanup'],modelCalls:requests.length})+'\n');
}finally{
 platform.closeAllConnections();await new Promise(ok=>platform.close(ok));
 rmSync(home,{recursive:true,force:true});
}
