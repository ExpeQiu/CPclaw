import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectHarnessProcess} from '../dist/process-inspection.js';

test('inspection uses absolute ps path and distinguishes failure from a live process',()=>{
 const marker='/tmp/unique-harness-marker';
 let command;
 assert.equal(inspectHarnessProcess(marker,(cmd)=>{command=cmd;return 'node '+marker;}).state,'remaining');
 assert.equal(command,'/bin/ps');
 assert.equal(inspectHarnessProcess(marker,()=>'/bin/other').state,'exited');
 for(const code of ['ENOENT','EACCES','ETIMEDOUT']) {
  assert.equal(inspectHarnessProcess(marker,()=>{throw Object.assign(Error('fixture'),{code});}).state,'unknown');
 }
});
