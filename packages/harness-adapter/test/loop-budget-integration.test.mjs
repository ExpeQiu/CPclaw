import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runReportLoop } from '../dist/index.js';

for (const limit of [24,40]) test(`gateway applies configured limit ${limit} and preserves receipts`, async () => {
  const finalCall = limit - 1;
  const temp = mkdtempSync('/tmp/cpclaw-budget-test-');
  const sdk = join(temp,'node_modules/@deepseek-ai/dsh-sdk-client/lib');
  mkdirSync(sdk,{recursive:true});
  writeFileSync(join(sdk,'index.js'), `
    exports.DeepSeekHarness = class {
      constructor(options) { this.options=options; }
      async run() {
        const options=this.options;
        const base=options.env.CPCLAW_TOOL_URL;
        const headers={authorization:'Bearer '+options.env.CPCLAW_LOOP_KEY,'content-type':'application/json'};
        const messages=[{role:'user',content:'查询技能列表'}];
        for(let i=0;i<${finalCall};i++) {
          const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers,
            body:JSON.stringify({messages,tools:[{type:'function',function:{name:'service_action'}}],tool_choice:'auto'})});
          if(!response.ok)throw Error('gateway failed');
          const data=JSON.parse(await response.text());
          const receipt=await fetch(base+'/service',{method:'POST',headers,body:JSON.stringify({action:'terminal'})}).then(r=>r.json());
          if(i===${finalCall - 1} && receipt.code!=='ROUND_WRAP_UP')throw Error('late tool executed');
          messages.push({role:'assistant',content:JSON.stringify(receipt)});
          if(data.final)return {finalResponse:'已确认技能目录；其余未核实'};
        }
        throw Error('no final answer');
      }
      async close() {}
    };
  `);
  const requests=[];
  const platform=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(JSON.stringify({final:requests.length===finalCall}));
  });
  const previous=process.env.CPCLAW_HARNESS_BUNDLE;
  const previousLimit=process.env.CPCLAW_SERVICE_MODEL_CALL_LIMIT;
  let executions=0,charges=0;
  try {
    await new Promise((resolve,reject)=>{platform.once('error',reject);platform.listen(0,'127.0.0.1',resolve);});
    process.env.CPCLAW_HARNESS_BUNDLE=temp;
    if(limit===24)delete process.env.CPCLAW_SERVICE_MODEL_CALL_LIMIT;
    else process.env.CPCLAW_SERVICE_MODEL_CALL_LIMIT=String(limit);
    const result=await runReportLoop({homeParent:temp,platformBase:'http://127.0.0.1:'+platform.address().port,
      accessToken:'fixture',goal:'查询技能',materials:[],signal:new AbortController().signal,
      beforeCall(){charges++;},unknownUsage(){assert.fail('unexpected usage failure');},
      service:{context:'fixture',execute:async()=>{executions++;return JSON.stringify({ok:true,result:'已确认目录'});}}});
    assert.equal(result.modelCalls,finalCall);assert.equal(charges,finalCall);
    assert.equal(executions,limit-2);assert.equal(result.toolCalls,limit-2);
    assert.match(result.finalResponse,/已确认.*未核实/);
    assert.ok(requests[limit-5].tools);
    assert.match(requests[limit-4].messages.at(-1).content,/仅剩 4 次/);
    assert.ok(requests[limit-3].tools);
    assert.equal(requests[limit-2].tools,undefined);
    assert.match(requests[limit-2].messages.at(-1).content,/工具已关闭/);
    assert.ok(requests[limit-2].messages.some(m=>m.content.includes('已确认目录')));
  } finally {
    if(previousLimit===undefined)delete process.env.CPCLAW_SERVICE_MODEL_CALL_LIMIT;else process.env.CPCLAW_SERVICE_MODEL_CALL_LIMIT=previousLimit;
    if(previous===undefined)delete process.env.CPCLAW_HARNESS_BUNDLE;else process.env.CPCLAW_HARNESS_BUNDLE=previous;
    platform.closeAllConnections();await new Promise(resolve=>platform.close(resolve));
    rmSync(temp,{recursive:true,force:true});
  }
});

test('invalid configuration fails before model billing or service execution',async()=>{
  const previous=process.env.CPCLAW_SERVICE_MODEL_CALL_LIMIT;
  process.env.CPCLAW_SERVICE_MODEL_CALL_LIMIT='invalid';
  try {
    await assert.rejects(runReportLoop({homeParent:'/tmp',platformBase:'http://127.0.0.1',accessToken:'fixture',goal:'test',materials:[],signal:new AbortController().signal,
      beforeCall(){assert.fail('must not bill');},unknownUsage(){assert.fail('must not call model');},
      service:{context:'fixture',execute:async()=>assert.fail('must not execute')}}),/CPCLAW_SERVICE_MODEL_CALL_LIMIT/);
  } finally {
    if(previous===undefined)delete process.env.CPCLAW_SERVICE_MODEL_CALL_LIMIT;else process.env.CPCLAW_SERVICE_MODEL_CALL_LIMIT=previous;
  }
});
