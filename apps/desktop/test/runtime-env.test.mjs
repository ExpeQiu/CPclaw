import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executeLocalTool} from '../local-tools.mjs';

test('local terminal finds system commands even when the desktop PATH is incomplete',async()=>{
 const previous=process.env.PATH;
 try {
  process.env.PATH='/nonexistent';
  const result=await executeLocalTool({context:{workingDirectory:'/tmp'},request:{action:'terminal',command:'ls -d /bin; command -v grep; command -v head; command -v find'},signal:new AbortController().signal,authorize:async()=>{}});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.match(result.stdout,/\/bin/);assert.match(result.stdout,/\/usr\/bin\/grep/);
 }finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;}
});

test('runtime environment retains explicit paths and includes bundled node and system tools',async()=>{
 const {runtimeEnv}=await import('../runtime-env.mjs');
 const env={PATH:'/custom/bin:/bin',CPCLAW_NODE_BINARY:'/Applications/CPclaw.app/Contents/Resources/runtime/bin/node',OTHER:'preserved'};
 const prepared=runtimeEnv(env),paths=prepared.PATH.split(':');
 assert.equal(paths[0],'/custom/bin');assert.equal(paths.filter(p=>p==='/bin').length,1);
 assert(paths.includes('/usr/bin'));assert(paths.includes('/Applications/CPclaw.app/Contents/Resources/runtime/bin'));
 assert.equal(prepared.OTHER,'preserved');assert.equal(env.PATH,'/custom/bin:/bin');
 assert(runtimeEnv({}).PATH.includes('/usr/bin'));
});
