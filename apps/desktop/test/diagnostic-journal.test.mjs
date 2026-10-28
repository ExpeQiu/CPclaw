import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDiagnosticJournal} from '../diagnostic-journal.mjs';

test('diagnostic lessons distinguish observed problems from verified fixes and isolate accounts',()=>{
 const db=new DatabaseSync(':memory:'),journal=createDiagnosticJournal(db);
 try{
  const observed={findings:[{code:'MEDIA_DELIVERY',status:'error',detail:'private input'}],repairs:[],task:{status:'generated'}};
  const first=journal.record('account-a','chat','message',observed);
  assert.equal(first.repairState,'none');assert.equal(first.experience[0].state,'observed');assert.equal(first.experience[0].occurrences,1);
  journal.record('account-a','chat','message',observed);
  assert.equal(journal.lessons('account-a')[0].occurrences,1);
  journal.record('account-a','chat','second-message',observed);
  assert.equal(journal.lessons('account-a')[0].occurrences,2);
  const fixed=journal.record('account-a','chat','second-message',{findings:[],repairs:[{code:'MEDIA_DELIVERY',verified:true,detail:'private material'}],task:{status:'delivered'}});
  assert.equal(fixed.experience[0].state,'verified');assert.equal(fixed.experience[0].verified,1);
  assert.equal(journal.lessons('account-b').length,0);
  assert(!JSON.stringify(db.prepare('SELECT * FROM diagnostic_runs').all()).includes('private'));
  assert.match(fixed.experience[0].prevention,/不重新生成/);
 }finally{db.close();}
});
