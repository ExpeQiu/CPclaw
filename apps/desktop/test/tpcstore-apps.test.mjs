import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {packagePath,discoverTpcstore,runStoreJson,rememberSource,sourceRoot} from '../tpcstore-apps.mjs';
function fixture(t){const root=mkdtempSync('/tmp/tpcstore 包路径-');t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'bin'));return realpathSync(root);}
test('package resolver rejects traversal, absolute paths and symlink escape',t=>{
 const root=fixture(t);writeFileSync(join(root,'bin','entry.mjs'),'');
 assert.equal(packagePath(root,'bin/entry.mjs'),join(root,'bin','entry.mjs'));
 symlinkSync('/etc/hosts',join(root,'bin','escape'));
 for(const relative of ['../x','/etc/hosts','bin/../entry.mjs','bin\\entry.mjs','bin/escape'])assert.throws(()=>packagePath(root,relative));
});
test('store subprocess uses literal argv with spaces and shell metacharacters',async t=>{
 const root=fixture(t);writeFileSync(join(root,'bin','entry.mjs'),`console.log(JSON.stringify({ok:true,data:process.argv.slice(2)}));`);
 const args=['with spaces','$(echo should-not-run)',';echo not-a-command'];
 assert.deepEqual((await runStoreJson(root,'bin/entry.mjs',args)).data,args);
});
test('discovery rejects incompatible, duplicate, or escaping returned app descriptors',async t=>{
 const root=fixture(t);writeFileSync(join(root,'bin','entry.mjs'),'');
 for(const apps of [[{app_id:'x',protocol_version:'2.0.0'}],[{app_id:'x',protocol_version:'1.0.0',runtime:{entry:'../escape'}}],[...Array(2)].map(()=>({app_id:'x',protocol_version:'1.0.0',runtime:{entry:'bin/entry.mjs'}}))]){
  writeFileSync(join(root,'bin','tpcstore-cli.mjs'),`console.log(${JSON.stringify(JSON.stringify({ok:true,data:{apps}}))});`);
  await assert.rejects(()=>discoverTpcstore(root));
 }
});
test('source location is remembered without per-app directory or URL',t=>{
 const root=fixture(t),data=join(root,'settings');assert.equal(sourceRoot(data),null);rememberSource(data,root);assert.equal(sourceRoot(data),root);
});
