// 使用真实 Chromium 布局与鼠标事件验证分栏；隔离账号与网络服务。
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const renderer = process.env.CPCLAW_TEST_DESKTOP_DIR ? resolve(process.env.CPCLAW_TEST_DESKTOP_DIR, 'renderer') : resolve(import.meta.dirname, '../apps/desktop/renderer');
const temporary = mkdtempSync('/tmp/cpclaw-pane-test-');
app.setPath('userData', join(temporary, 'profile'));
app.whenReady().then(async () => {
try {
  const html = readFileSync(join(renderer, 'index.html'), 'utf8')
    .replace('<head>', `<head><base href="${pathToFileURL(renderer + '/').href}">`)
    .replace(/<script src="\.\/(?!pane-resize\.js)[^"]+"><\/script>/g, '');
  const page = join(temporary, 'index.html');
  writeFileSync(page, html);
  const w = new BrowserWindow({ width: 1600, height: 900, show: true, webPreferences: { backgroundThrottling: false } });
  const js = code => w.webContents.executeJavaScript(code);
  const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const width = selector => js(`document.querySelector('${selector}').getBoundingClientRect().width`);
  const errors = [];
  w.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  await w.loadFile(page); await settle();
  async function drag(name, distance) {
    const point = await js(`(() => { const r=document.getElementById('pane-divider-${name}').getBoundingClientRect();return {x:Math.round(r.x+4),y:Math.round(r.y+50)}; })()`);
    w.webContents.sendInputEvent({type:'mouseMove',...point});
    await settle();
    w.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1,modifiers:['leftButtonDown']});
    await settle();
    w.webContents.sendInputEvent({type:'mouseMove',x:point.x+distance,y:point.y,modifiers:['leftButtonDown']});
    await settle();
    w.webContents.sendInputEvent({type:'mouseUp',x:point.x+distance,y:point.y,button:'left',clickCount:1});
    await settle();
  }
  await drag('sidebar', 60);
  assert.equal(await width('.sidebar'), 306);
  await js(`document.getElementById('inspector').hidden=false;`); await settle();
  assert.equal(await js(`document.getElementById('inspector').getBoundingClientRect().top`), 0);
  await drag('inspector', -80);
  assert.equal(await width('.inspector'), 400);
  await js(`document.getElementById('panel-settings').hidden=true;document.getElementById('panel-documents').hidden=false;`); await settle();
  assert.equal(await js(`document.getElementById('inspector').getBoundingClientRect().top`), 0);
  assert.ok(await js(`document.querySelector('header').getBoundingClientRect().right <= document.getElementById('inspector').getBoundingClientRect().left + 1`));
  const initial = await width('.inspector');
  await drag('inspector', 100);
  assert.ok(Math.abs(await width('.inspector') - (initial - 100)) < 2);
  await drag('structure', -50);
  assert.equal(await width('.document-structure'), 260);
  await w.reload(); await settle();
  assert.equal(await width('.sidebar'), 306);
  await js(`document.getElementById('inspector').hidden=false;document.getElementById('panel-settings').hidden=true;document.getElementById('panel-documents').hidden=false;`); await settle();
  assert.equal(await width('.document-structure'), 260);
  assert.ok(Math.abs(await width('.inspector') - (initial - 100)) < 2);
  await drag('sidebar', 2000);
  assert.equal(await width('.sidebar'), 420);
  await js(`document.getElementById('pane-divider-sidebar').dispatchEvent(new MouseEvent('dblclick'));`); await settle();
  assert.equal(await width('.sidebar'), 246);
  await js(`document.body.classList.add('document-expanded')`); await settle();
  assert.equal(await js(`document.getElementById('pane-divider-inspector').hidden`), true);
  await js(`document.body.classList.remove('document-expanded')`);
  w.setSize(900, 700); await settle();
  assert.ok(await width('.inspector') <= await width('.work-area'));
  assert.equal(await js(`document.getElementById('inspector').getBoundingClientRect().top`), 0);
  assert.equal(await js(`document.getElementById('pane-divider-inspector').getBoundingClientRect().top`), 0);
  await js(`document.getElementById('pane-divider-structure').dispatchEvent(new KeyboardEvent('keydown',{key:'Home'}))`); await settle();
  assert.equal(await width('.document-structure'), 190);
  assert.deepEqual(errors, []);
  console.log('PASS: 拖动三个分隔线、独立宽度记忆、重载恢复、边界限制、双击重置、展开和窄窗口。');
  w.destroy();
} finally { app.once('quit', () => rmSync(temporary, {recursive:true,force:true})); app.quit(); }

}).catch(error => { console.error(error); app.exit(1); });
