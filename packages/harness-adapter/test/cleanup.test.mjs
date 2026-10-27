import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runReportLoop } from '../dist/index.js';

test('report survives a child that exits shortly after SDK close resolves', async () => {
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
      async close() { if(this.child?.connected)this.child.send('close'); }
    };
  `);
  const previous = process.env.CPCLAW_HARNESS_BUNDLE;
  const previousDelay = process.env.CPCLAW_TEST_CHILD_DELAY;
  process.env.CPCLAW_HARNESS_BUNDLE = temp;
  try {
    const result = await runReportLoop({ homeParent:temp, platformBase:'http://127.0.0.1', accessToken:'fixture', goal:'检查连接', materials:[], signal:new AbortController().signal, beforeCall(){}, unknownUsage(){}, service:{context:'fixture',execute:async()=>''} });
    assert.equal(result.finalResponse,'已收到真实回执');
    assert.equal(result.childCommandSeenAfterClose,false);
    process.env.CPCLAW_TEST_CHILD_DELAY='2400';
    await assert.rejects(runReportLoop({ homeParent:temp, platformBase:'http://127.0.0.1', accessToken:'fixture', goal:'检查连接', materials:[], signal:new AbortController().signal, beforeCall(){}, unknownUsage(){}, service:{context:'fixture',execute:async()=>''} }), /Harness 子进程未回收/);
  } finally {
    if(previousDelay===undefined)delete process.env.CPCLAW_TEST_CHILD_DELAY;else process.env.CPCLAW_TEST_CHILD_DELAY=previousDelay;
    if(previous===undefined)delete process.env.CPCLAW_HARNESS_BUNDLE;else process.env.CPCLAW_HARNESS_BUNDLE=previous;
    rmSync(temp,{recursive:true,force:true});
  }
});
