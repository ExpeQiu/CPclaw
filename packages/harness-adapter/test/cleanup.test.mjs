import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runReportLoop } from '../dist/index.js';

test('report survives a child that exits shortly after SDK close resolves', async t => {
  const temp = mkdtempSync('/tmp/cpclaw-cleanup-test-');
  const sdk = join(temp, 'node_modules/@deepseek-ai/dsh-sdk-client/lib');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, 'index.js'), `
    const {spawn} = require('node:child_process');
    exports.DeepSeekHarness = class {
      constructor(options) { this.options=options; }
      async run() {
        this.child=spawn(process.execPath,['-e',
          "process.on('message',()=>setTimeout(()=>process.exit(0)," + Number(process.env.CPCLAW_TEST_CHILD_DELAY || 200) + "));console.log('ready')",
          this.options.patches[0]],{stdio:['ignore','pipe','ignore','ipc']});
        await new Promise(resolve=>this.child.stdout.once('data',resolve));
        return {finalResponse:'已收到真实回执'};
      }
      async close() { if(this.child?.connected)this.child.send('close'); if(process.env.CPCLAW_TEST_CLOSE_FAIL)throw Error('fixture close failed'); }
    };
  `);
  const previous = process.env.CPCLAW_HARNESS_BUNDLE;
  const previousDelay = process.env.CPCLAW_TEST_CHILD_DELAY;
  const previousPath = process.env.PATH;
  const previousCloseFail = process.env.CPCLAW_TEST_CLOSE_FAIL;
  process.env.CPCLAW_HARNESS_BUNDLE = temp;
  try {
    const result = await runReportLoop({ homeParent:temp, platformBase:'http://127.0.0.1', accessToken:'fixture', goal:'检查连接', materials:[], signal:new AbortController().signal, beforeCall(){}, unknownUsage(){}, service:{context:'fixture',execute:async()=>''} });
    assert.equal(result.finalResponse,'已收到真实回执');
    assert.equal(result.childCommandSeenAfterClose,false);
    process.env.PATH='/nonexistent';
    const noPath = await runReportLoop({ homeParent:temp, platformBase:'http://127.0.0.1', accessToken:'fixture', goal:'检查连接', materials:[], signal:new AbortController().signal, beforeCall(){}, unknownUsage(){}, service:{context:'fixture',execute:async()=>''} });
    assert.equal(noPath.finalResponse,'已收到真实回执');
    assert.equal(noPath.childCommandSeenAfterClose,false);
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
    process.env.CPCLAW_TEST_CHILD_DELAY='2400';
    const delayed=await runReportLoop({ homeParent:temp, platformBase:'http://127.0.0.1', accessToken:'fixture', goal:'检查连接', materials:[], signal:new AbortController().signal, beforeCall(){}, unknownUsage(){}, service:{context:'fixture',execute:async()=>''} });
    assert.equal(delayed.finalResponse,'已收到真实回执');
    assert.equal(delayed.childCommandSeenAfterClose,true);
    assert.equal(delayed.cleanupWarning.code,'HARNESS_CLEANUP');
    process.env.CPCLAW_TEST_CHILD_DELAY='100';
    const original=childProcess.execFileSync;
    const mock=t.mock.method(childProcess,'execFileSync',(command,...args)=>{if(command==='/bin/ps')throw Object.assign(Error('fixture permission denied'),{code:'EACCES'});return original(command,...args);});
    syncBuiltinESMExports();
    try {
      const unknown=await runReportLoop({ homeParent:temp, platformBase:'http://127.0.0.1', accessToken:'fixture', goal:'检查连接', materials:[], signal:new AbortController().signal, beforeCall(){}, unknownUsage(){}, service:{context:'fixture',execute:async()=>''} });
      assert.equal(unknown.finalResponse,'已收到真实回执');assert.equal(unknown.childCommandSeenAfterClose,null);
      assert.equal(unknown.cleanupWarning.code,'HARNESS_CLEANUP_UNKNOWN');
    }finally{mock.mock.restore();syncBuiltinESMExports();}
    process.env.CPCLAW_TEST_CLOSE_FAIL='1';
    const closeFailed=await runReportLoop({ homeParent:temp, platformBase:'http://127.0.0.1', accessToken:'fixture', goal:'检查连接', materials:[], signal:new AbortController().signal, beforeCall(){}, unknownUsage(){}, service:{context:'fixture',execute:async()=>''} });
    assert.equal(closeFailed.finalResponse,'已收到真实回执');assert.equal(closeFailed.cleanupWarning.code,'HARNESS_CLOSE_FAILED');

  } finally {
    if(previousCloseFail===undefined)delete process.env.CPCLAW_TEST_CLOSE_FAIL;else process.env.CPCLAW_TEST_CLOSE_FAIL=previousCloseFail;
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;
    if(previousDelay===undefined)delete process.env.CPCLAW_TEST_CHILD_DELAY;else process.env.CPCLAW_TEST_CHILD_DELAY=previousDelay;
    if(previous===undefined)delete process.env.CPCLAW_HARNESS_BUNDLE;else process.env.CPCLAW_HARNESS_BUNDLE=previous;
    rmSync(temp,{recursive:true,force:true});
  }
});
