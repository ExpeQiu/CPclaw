import {test} from 'node:test';import assert from 'node:assert/strict';
import {resolveHarnessBodyLimit,DEFAULT_HARNESS_BODY_BYTES} from '../dist/index.js';
test('Harness transport budget is shared, bounded and rejects invalid configuration',()=>{assert.equal(resolveHarnessBodyLimit(undefined),8388608);assert.equal(DEFAULT_HARNESS_BODY_BYTES,8388608);assert.equal(resolveHarnessBodyLimit('1048576'),1048576);for(const v of ['bad','1.5','',0,33554433,Infinity])assert.throws(()=>resolveHarnessBodyLimit(v),/CPCLAW_HARNESS_MAX_BODY_BYTES/);});
