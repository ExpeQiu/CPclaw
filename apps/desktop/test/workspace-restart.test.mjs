import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createWorkspaceClient} from '../workspace-client.mjs';

test('old worker exit cannot cancel requests sent immediately after restart', {timeout:12000},async()=>{
  const dataDir=mkdtempSync('/tmp/cpclaw-restart-');
  const client=createWorkspaceClient(dataDir,fileURLToPath(new URL('../',import.meta.url)));
  try{
    assert.equal((await client.request({method:'account.status',input:{}})).ok,true);
    for(let i=0;i<3;i++){
      client.stop();
      const result=await client.request({method:'account.status',input:{}});
      assert.equal(result.ok,true,result.message);assert.equal(result.employeeId,null);
    }
  }finally{client.stop();rmSync(dataDir,{recursive:true,force:true});}
});
