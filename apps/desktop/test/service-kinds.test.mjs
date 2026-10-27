import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {SERVICE_KINDS,serviceKind,annotateService} from '../service-kinds.mjs';
import {addAppDriver,addComputerUseSite,listLocalExtensions,removeLocalExtension} from '../local-extensions.mjs';
import {publicServices} from '../service-runtime.mjs';

test('service kinds classify builtins and connectors',()=>{
  assert.equal(serviceKind({id:'browser-page',type:'WEB'}),'computer-use');
  assert.equal(serviceKind({id:'local-terminal',type:'CLI'}),'app-driver');
  assert.equal(serviceKind({id:'dreamina',type:'CLI'}),'cli');
  assert.equal(serviceKind({type:'MCP'}),'computer-use');
  assert.equal(annotateService({id:'x',type:'CLI'}).kindLabel,'CLI 三方应用');
});

test('local computer-use and app-driver persist and merge into publicServices',()=>{
  const root=mkdtempSync('/tmp/cpclaw-ext-kinds-');
  const app=join(root,'MyApp');mkdirSync(app);
  const web=addComputerUseSite(root,{pageUrl:'https://docs.example/'});
  const driver=addAppDriver(root,{root:app});
  assert.equal(web.kind,SERVICE_KINDS.computerUse);
  assert.equal(driver.kind,SERVICE_KINDS.appDriver);
  assert.equal(listLocalExtensions(root).length,2);
  const ids=publicServices([],listLocalExtensions(root)).map(s=>s.id);
  assert(ids.includes(web.id));assert(ids.includes(driver.id));
  assert(ids.includes('dreamina'));assert(ids.includes('browser-page'));assert(ids.includes('local-terminal'));
  removeLocalExtension(root,web.id);
  assert.equal(listLocalExtensions(root).length,1);
});

test('invalid computer-use url and relative app path are rejected',()=>{
  const root=mkdtempSync('/tmp/cpclaw-ext-bad-');
  assert.throws(()=>addComputerUseSite(root,{pageUrl:'file:///etc/passwd'}));
  assert.throws(()=>addAppDriver(root,{root:'relative/path'}));
});
