import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {inspectAppFolder} from '../app-folder.mjs';
function fixture(t){const root=realpathSync(mkdtempSync('/tmp/cpclaw-folder-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function store(root){for(const p of ['bin','contracts','apps','cutpot'])mkdirSync(join(root,p));writeFileSync(join(root,'bin/tpcstore-cli.mjs'),'throw Error("recognition must not execute")');writeFileSync(join(root,'contracts/products.json'),'{}');writeFileSync(join(root,'apps/cutpot.json'),JSON.stringify({app_id:'tpcstore.cutpot',protocol_version:'1.0.0',stage:'local_preview',integration:{root:'cutpot'},description:'test'}));}
test('recognizes store and child app without executing selected code',t=>{const root=fixture(t);store(root);assert.equal(inspectAppFolder(root).kind,'store');const app=inspectAppFolder(join(root,'cutpot'));assert.equal(app.kind,'app');assert.equal(app.storeRoot,root);assert.equal(app.appId,'tpcstore.cutpot');assert(app.connectable);});
test('ordinary projects stay projects and standalone manifests are not silently downgraded',t=>{const root=fixture(t);assert.equal(inspectAppFolder(root).kind,'project');writeFileSync(join(root,'app-manifest.json'),'{broken');assert.throws(()=>inspectAppFolder(root),/无法解析/);writeFileSync(join(root,'app-manifest.json'),'{}');assert.equal(inspectAppFolder(root).kind,'unsupported');});
test('rejects ambiguous, incompatible and escaping app registrations',t=>{const root=fixture(t);store(root);const entry=join(root,'apps/cutpot.json');const app=JSON.parse(String(requireRead(entry)));writeFileSync(join(root,'apps/other.json'),JSON.stringify(app));assert.throws(()=>inspectAppFolder(join(root,'cutpot')),/多个/);rmSync(join(root,'apps/other.json'));app.protocol_version='2.0.0';writeFileSync(entry,JSON.stringify(app));assert.throws(()=>inspectAppFolder(join(root,'cutpot')),/版本/);app.protocol_version='1.0.0';app.integration.root='../escape';writeFileSync(entry,JSON.stringify(app));assert.throws(()=>inspectAppFolder(join(root,'cutpot')));});
import {readFileSync as requireRead} from 'node:fs';
test('rejects files and relative paths; canonicalizes aliases',t=>{const root=fixture(t);writeFileSync(join(root,'file'),'');assert.throws(()=>inspectAppFolder(join(root,'file')),/不是文件夹/);assert.throws(()=>inspectAppFolder('relative'));symlinkSync(root,root+'-alias');t.after(()=>rmSync(root+'-alias'));assert.equal(inspectAppFolder(root+'-alias').root,root);});


test('registered products without integration are never silently added as ordinary projects',t=>{
 const root=fixture(t);store(root);mkdirSync(join(root,'v04'));
 writeFileSync(join(root,'contracts/products.json'),JSON.stringify({products:[{id:'V04',name:'技术卡',code_path:'v04'}]}));
 assert.equal(inspectAppFolder(join(root,'v04')).kind,'unsupported');
});
