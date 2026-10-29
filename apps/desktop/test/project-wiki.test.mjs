import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,symlink,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createProjectWiki,indexedWikiDocuments,validateWikiExtraction,wikiChunks,WIKI_DIR} from '../project-wiki.mjs';
import {searchProject} from '../project-search.mjs';

async function fixture(t) {
  const root=await mkdtemp('/tmp/cpclaw-wiki-test-');t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
function extraction({file,chunk}) {
  return {title:file.path,points:[{kind:'fact',topic:'验收标准',text:'验收标准必须保留原始证据和适用条件。',startLine:chunk.startLine,endLine:chunk.startLine,quote:file.body.split(/\r?\n/)[chunk.startLine-1]}]};
}
const context={id:'p',actor:'a',platform:'fixture'};

test('real files become cited Wiki; no-op does not call model or duplicate output; raw files remain in place',async t=>{
  const root=await fixture(t);await writeFile(join(root,'规范.md'),'验收标准：保留证据；温度低于 30 度。');await writeFile(join(root,'截图.png'),'image');
  let calls=0;const wiki=createProjectWiki({summarize:async input=>{calls++;return extraction(input);}});
  const first=await wiki.run(root,context);assert.equal(first.created,1);assert.equal(first.skipped.length,1);assert.equal(first.indexStatus,'ready');
  assert.equal(await readFile(join(root,'规范.md'),'utf8'),'验收标准：保留证据；温度低于 30 度。');
  const docs=await indexedWikiDocuments(root);assert.equal(docs.length,1);assert.match(docs[0].body,/L1-L1/);assert.match(docs[0].body,/30 度/);
  const versions=await readdir(join(root,WIKI_DIR,'历史'));
  const again=await wiki.run(root,context);assert.equal(again.unchanged,true);assert.equal(calls,1);assert.deepEqual(await readdir(join(root,WIKI_DIR,'历史')),versions);
  const results=await searchProject(root,'验收标准');assert.equal(results.sources[0].path,docs[0].path);
  const view=await wiki.view(root);assert.match(view.body,/主题导航/);assert.equal(view.pages.length,1);
  await assert.rejects(wiki.view(root,'规范.md'),/未发布/);
});

test('source updates invalidate retrieval immediately, update affected pages only, and retain historical versions',async t=>{
  const root=await fixture(t);await writeFile(join(root,'a.md'),'验收标准 A');await writeFile(join(root,'b.md'),'验收标准 B');let calls=0;
  const wiki=createProjectWiki({summarize:async input=>{calls++;return extraction(input);}});await wiki.run(root,context);
  const before=await indexedWikiDocuments(root);await writeFile(join(root,'a.md'),'验收标准已修订 C');
  assert.equal((await indexedWikiDocuments(root)).length,1);
  const updated=await wiki.run(root,context);assert.equal(updated.changed,1);assert.equal(calls,3);
  const after=await indexedWikiDocuments(root);assert.equal(after.length,2);assert.notEqual(after.find(d=>d.source==='a.md').path,before.find(d=>d.source==='a.md').path);
  assert.equal(after.find(d=>d.source==='b.md').path,before.find(d=>d.source==='b.md').path);
  assert.ok(await readFile(join(root,before.find(d=>d.source==='a.md').path),'utf8'));
  await rm(join(root,'a.md'));assert.equal((await indexedWikiDocuments(root)).length,1);assert.equal((await wiki.run(root,context)).removed,1);
  const hits=await searchProject(root,'验收标准');assert.ok(!hits.sources.some(s=>s.path===before.find(d=>d.source==='a.md').path));
});

test('manual page edits and homepage edits are preserved and never silently indexed as validated knowledge',async t=>{
  const root=await fixture(t);await writeFile(join(root,'a.md'),'验收标准 A');let calls=0;
  const wiki=createProjectWiki({summarize:async input=>{calls++;return extraction(input);}});await wiki.run(root,context);
  const [doc]=await indexedWikiDocuments(root);await writeFile(join(root,doc.path),doc.body+'\n人工新增内容');await writeFile(join(root,'a.md'),'验收标准 B');
  const updated=await wiki.run(root,context);assert.equal(updated.pending.length,1);assert.equal(calls,1);assert.match(await readFile(join(root,doc.path),'utf8'),/人工新增/);assert.equal((await indexedWikiDocuments(root)).length,0);
  const home=join(root,WIKI_DIR,'README.md');await writeFile(home,'人工首页');await assert.rejects(wiki.run(root,context),/首页已被人工修改/);assert.equal(await readFile(home,'utf8'),'人工首页');assert.equal(calls,1);
});

test('outside symlinks and generated Wiki are not ingested; output symlinks are rejected',async t=>{
  const root=await fixture(t),outside=await fixture(t);await writeFile(join(outside,'private.md'),'秘密信息');await symlink(outside,join(root,'shortcut'));await symlink(join(outside,'private.md'),join(root,'alias.md'));
  let calls=0;const wiki=createProjectWiki({summarize:async input=>{calls++;return extraction(input);}});const empty=await wiki.run(root,context);assert.equal(calls,0);assert.equal(empty.skipped.length,2);
  const other=await fixture(t);await symlink(outside,join(other,WIKI_DIR));await assert.rejects(wiki.run(other,context),/符号链接/);assert.deepEqual(await readdir(outside),['private.md']);
  assert.equal((await wiki.status(root)).total,0);
});

test('invalid model citations are rejected, visible as pending, and never published for retrieval',async t=>{
  const root=await fixture(t);await writeFile(join(root,'a.md'),'验收标准 A');
  const wiki=createProjectWiki({summarize:async input=>{const value=extraction(input);value.points[0].quote='不存在的原文';return value;}});
  const result=await wiki.run(root,context);assert.equal(result.pending.length,1);assert.equal(result.created,0);assert.equal((await indexedWikiDocuments(root)).length,0);
  const file={body:'原文'},chunk=wikiChunks(file.body)[0];assert.throws(()=>validateWikiExtraction({title:'x',points:[{kind:'fact',topic:'t',text:'x',quote:'原文',startLine:0,endLine:1}]},file,chunk),/引用/);
});

test('cancel resumes completed chunk cache, preserves request identity, and does not publish partial pages',async t=>{
  const root=await fixture(t);await writeFile(join(root,'a.md'),Array.from({length:100},(_,i)=>'验收标准 '+i+' '+ '资料'.repeat(50)).join('\n'));
  let calls=0,paused,release;const waiting=new Promise(resolve=>paused=resolve),requests=[];
  let shouldPause=true;
  const wiki=createProjectWiki({summarize:async input=>{
    calls++;requests.push(input.requestId);
    if(shouldPause && calls===2){paused();await new Promise((resolve,reject)=>{release=resolve;input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});});}
    return extraction(input);
  }});
  const first=wiki.run(root,context);await waiting;
  await assert.rejects(wiki.run(root,context),/正在整理/);wiki.cancel('p');await assert.rejects(first,/停止/);assert.equal((await indexedWikiDocuments(root)).length,0);
  shouldPause=false;release();const resumed=await wiki.run(root,context);assert.equal(resumed.created,1);assert.equal(calls,3);assert.equal(requests[1],requests[2]);
  assert.equal((await indexedWikiDocuments(root)).length,1);
});

test('source mutation during processing is reported and excluded',async t=>{
  const root=await fixture(t);await writeFile(join(root,'a.md'),'验收标准 A');
  const wiki=createProjectWiki({summarize:async input=>{await writeFile(join(root,'a.md'),'验收标准 B');return extraction(input);}});
  const result=await wiki.run(root,context);assert.equal(result.pending.length,1);assert.match(result.pending[0].reason,/已变化/);assert.equal((await indexedWikiDocuments(root)).length,0);
});

test('deleting the generated homepage is repaired from cache without calling the model',async t=>{
  const root=await fixture(t);await writeFile(join(root,'a.md'),'验收标准 A');let calls=0;
  const wiki=createProjectWiki({summarize:async input=>{calls++;return extraction(input);}});await wiki.run(root,context);
  await rm(join(root,WIKI_DIR,'README.md'));await wiki.run(root,context);
  assert.match(await readFile(join(root,WIKI_DIR,'README.md'),'utf8'),/主题导航/);assert.equal(calls,1);
});

test('manual edits made while another file is processing remain current and are reported',async t=>{
  const root=await fixture(t);await writeFile(join(root,'a.md'),'验收标准 A');await writeFile(join(root,'b.md'),'验收标准 B');
  let editPage='';const wiki=createProjectWiki({summarize:async input=>{
    if(editPage && input.file.path==='b.md')await writeFile(join(root,editPage),'人工修改的当前知识');return extraction(input);
  }});await wiki.run(root,context);
  editPage=(await indexedWikiDocuments(root)).find(p=>p.source==='a.md').path;
  await writeFile(join(root,'b.md'),'验收标准 B2');const result=await wiki.run(root,context);
  assert.ok(result.pending.some(p=>p.path==='a.md'));assert.equal((await indexedWikiDocuments(root)).length,1);
  assert.equal((await wiki.view(root)).pages.find(p=>p.path===editPage)?.path,editPage);
  assert.equal(await readFile(join(root,editPage),'utf8'),'人工修改的当前知识');
});
