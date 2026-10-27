import { app, BrowserWindow, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { registerExtensionHost } from '../apps/desktop/extension-host.mjs';
import { createServiceRuntime, browserPageService } from '../apps/desktop/service-runtime.mjs';
import { compressAxTree, isSensitiveUrl, pageOriginsForService, validatePageUrl } from '../apps/desktop/computer-use.mjs';

const temp = mkdtempSync('/tmp/cpclaw-extension-host-');
app.setPath('userData', join(temp, 'profile'));
let win;
registerExtensionHost({ ipcMain, getWindow: () => win, dataDir: temp });

const fixtureHtml = `<!doctype html><title>CU Fixture</title><body><button id="go">继续</button><button id="pay">支付</button><input aria-label="密码" type="password"></body>`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fixtureHtml);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
const home = `${origin}/`;

app.whenReady().then(async () => {
  const timer = setTimeout(() => { console.error('host verification timeout'); server.close(); app.exit(1); }, 45000);
  try {
    const preload = join(temp, 'preload.cjs');
    writeFileSync(preload, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('probe',{action:i=>ipcRenderer.invoke('extension.action',i)});");
    const html = join(temp, 'index.html');
    writeFileSync(html, '<!doctype html><title>Isolated extension host test</title>');
    win = new BrowserWindow({ show: false, width: 1100, height: 720, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadFile(html);
    const js = s => win.webContents.executeJavaScript(s);

    assert.equal((await js("probe.action({action:'execute',command:'echo unsafe'})")).ok, false);

    // Dreamina allowlist still rejects file URLs by falling back to default origin home when opening without service.
    assert.deepEqual(pageOriginsForService({ id: 'dreamina', builtin: true }), ['https://jimeng.jianying.com']);
    assert.equal(validatePageUrl('file:///etc/passwd', ['https://jimeng.jianying.com']).ok, false);

    const service = { id: 'fixture-web', title: 'Fixture', type: 'MCP', target: `${origin}/mcp` };
    const loaded = new Promise((resolve, reject) => {
      const check = setInterval(() => {
        const child = win.contentView.children[0];
        const url = child?.webContents.getURL() || '';
        if (url.startsWith(origin) && !child.webContents.isLoading()) { clearInterval(check); resolve(url); }
      }, 100);
      setTimeout(() => { clearInterval(check); reject(Error('page load timeout')); }, 15000).unref();
    });
    assert.equal((await js(`probe.action(${JSON.stringify({ action: 'open', service, url: home, origins: [origin] })})`)).ok, true);
    // Malicious file URL must not leave allowlisted origin.
    assert.equal((await js(`probe.action(${JSON.stringify({ action: 'open', service, url: 'file:///etc/passwd', origins: [origin] })})`)).ok, true);
    await js("probe.action({action:'bounds',bounds:{x:550,y:50,width:550,height:650}})");
    const loadedUrl = await loaded;
    const view = win.contentView.children[0];
    assert.match(loadedUrl || view.webContents.getURL(), new RegExp('^' + origin.replace(/\./g, '\\.')));
    assert.equal(await view.webContents.executeJavaScript('typeof window.cpclaw'), 'undefined');
    assert.equal(await view.webContents.executeJavaScript('typeof require'), 'undefined');

    assert.equal(isSensitiveUrl('https://example.com/login'), true);
    const tree = compressAxTree([{ nodeId: 1, properties: [{ name: 'role', value: { value: 'button' } }, { name: 'name', value: { value: '生成' } }] }]);
    assert.equal(tree.nodes[0].ref, 'e1');

    const approvals = [];
    let clicked = false;
    const runtime = createServiceRuntime({
      dataDir: temp,
      isCurrent: () => true,
      getPermission: () => ({ mode: 'full', revision: 1 }),
      approve: async details => { approvals.push(details); if (details.forceApproval) return false; return { mode: 'once', creditCeiling: 0 }; },
      computerUsePage: {
        getOrigins: () => [origin],
        getUrl: () => view.webContents.getURL(),
        allowOrigin() {},
        defaultUrl: () => home,
        resolveRef: ref => ref === 'pay' ? { ref: 'pay', role: 'button', name: '支付', sensitive: true } : ref === 'ok' ? { ref: 'ok', role: 'button', name: '继续' } : undefined,
        open: async url => ({ ok: true, url }),
        reload: async () => ({ ok: true }),
        snapshot: async () => ({ ok: true, nodes: [{ ref: 'e1', role: 'button', name: '继续' }] }),
        click: async ref => { clicked = true; return { ok: true, ref }; },
        type: async () => ({ ok: true }),
        scroll: async () => ({ ok: true }),
        press: async () => ({ ok: true }),
        wait: async ms => ({ ok: true, ms }),
      },
    });
    const ctx = { actorId: 'verify', chatId: 'chat', taskId: 'task', service: browserPageService };
    const snap = await runtime.execute(ctx, { action: 'snapshot' }, AbortSignal.timeout(5000));
    assert.equal(snap.ok, true);
    assert(Array.isArray(snap.nodes) && snap.nodes.some(n => n.ref));
    await runtime.execute(ctx, { action: 'click', ref: 'ok', purpose: '继续' }, AbortSignal.timeout(5000));
    assert.equal(clicked, true);
    await assert.rejects(() => runtime.execute(ctx, { action: 'click', ref: 'pay', purpose: '支付' }, AbortSignal.timeout(5000)), e => e.code === 'DENIED');
    assert(approvals.some(a => a.forceApproval));

    assert.equal((await js("probe.action({action:'hide'})")).ok, true);
    clearTimeout(timer);
    server.close();
    console.log(JSON.stringify({ ok: true, checks: ['fixed-url', 'unknown-action-rejected', 'isolated-native-page', 'no-node-or-host-bridge', 'snapshot-refs', 'sensitive-force-approval', 'hide'] }));
    app.exit(0);
  } catch (e) {
    clearTimeout(timer);
    console.error(e);
    server.close();
    app.exit(1);
  }
});
