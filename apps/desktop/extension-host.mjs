import { createServiceRuntime, serviceImageData } from './service-runtime.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, extname } from 'node:path';
import { createCommandAuthorization } from './local-command-authorization.mjs';
import { WebContentsView, dialog, shell } from 'electron';
import { createExtensionService } from './extension-service.mjs';
const home = 'https://jimeng.jianying.com/';
export function registerExtensionHost({ dataDir, ipcMain, getWindow, getActor = () => null, approvalDialog = dialog.showMessageBox, service = createExtensionService() }) {
  let context = { actorId: null, chatId: '' };
  const effectiveContext = () => ({ actorId: getActor(), chatId: context.actorId === getActor() ? context.chatId : '' });
  let view, connectorAuthorization, executionPending = false, serviceController, selectionPending, approvalPending;
  const permissionStatus = () => ({...authorization.status(), ...runtime.status(effectiveContext())});
  async function approveService({signal,...options}) {
    hide();
    const win = getWindow();
    if (!win || win.isDestroyed()) return false;
    return new Promise(resolve => {
      const id = createHash('sha256').update(String(Date.now())+Math.random()).digest('hex');
      const settle = value => {
        signal.removeEventListener('abort', abort);win.removeListener('closed', abort);
        approvalPending = undefined;send({state:'approval-closed',approvalId:id});resolve(value);
      };
      const abort = () => settle(false);
      approvalPending = {id,settle};
      signal.addEventListener('abort',abort,{once:true});win.once('closed',abort);
      if (signal.aborted) { abort();return; }
      send({state:'approval',approvalId:id,...options});
    });
  }
  const runtime=createServiceRuntime({dataDir,isCurrent:c=>c.actorId===effectiveContext().actorId&&c.chatId===effectiveContext().chatId,
    approve:approveService,
    notify:value=>{if(value.type==='permission'){send({state:'permission',...permissionStatus()});return;}if(value.type==='authorization'){try{const u=new URL(value.url);if(u.protocol==='https:'&&!u.username&&!u.password&&(/(^|\.)jianying\.com$/.test(u.hostname)||/(^|\.)bytedance\.com$/.test(u.hostname)))void shell.openExternal(u.href).catch(()=>{});}catch{}}send({state:'result',...value});}});
  async function executeService(request,signal){
    if(request.actorId!==effectiveContext().actorId||!request.chatId||request.chatId!==effectiveContext().chatId)return {ok:false,code:'CONTEXT_CHANGED',message:'请返回发起操作的对话后继续。'};
    if(executionPending)return {ok:false,code:'BUSY',message:'已有服务操作正在执行。'};
    executionPending=true;serviceController=new AbortController();
    try {
      const combined=AbortSignal.any([signal,serviceController.signal]);
      if(request.request?.action==='select'){
        const id=createHash('sha256').update(String(Date.now())+Math.random()).digest('hex');
        return await new Promise(resolve=>{
          const settle=result=>{combined.removeEventListener('abort',abort);selectionPending=undefined;resolve(result);};
          const abort=()=>settle({ok:false,code:'CANCELLED',message:'服务选择已取消'});
          combined.addEventListener('abort',abort,{once:true});
          selectionPending={id,ids:(request.services??[]).map(s=>s.id),settle};
          send({state:'choose-service',selectionId:id,services:(request.services??[]).map(({id,title,type})=>({id,title,type}))});
        });
      }
      return await runtime.execute(request,request.request,combined);
    }
    catch(e){return {ok:false,code:e.code??'SERVICE_FAILED',message:e.message,...(e.recovery?{recovery:e.recovery}:{})};}
    finally{executionPending=false;serviceController=undefined;}
  }
  const trusted = event => { const win = getWindow(); return win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame; };
  function send(value) { const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send('extension.event', value); }
  function hide() { const win = getWindow(); if (win && view) view.setVisible(false); }
  const requestApproval = async (plan, { canRemember, signal }) => {
      hide();
      send({ state: 'authorization', message: '等待你授权在本机执行命令…' });
      const details = ['用途：' + plan.purpose, '执行位置：当前电脑', '工作目录：' + plan.cwd, '', '最多依次执行：', ...plan.commands.map(args => args.map(value => /[\s"']/u.test(value) ? JSON.stringify(value) : value).join(' ')), '', plan.readOnly === false ? '将运行此本机程序，实际行为由该程序决定；本次不提供自动授权。' : '这些操作只读取状态，不修改画布或提交生成任务。', '关闭窗口或按 Escape 视为拒绝。', canRemember ? '授权方式：默认仅本次执行；勾选下方选项可允许本次对话的相同只读检查。' : '授权方式：仅允许本次执行。', ...(canRemember ? [] : ['本次操作不提供对话级授权；关闭窗口或按 Escape 视为拒绝。'])].join('\n');
      const result = await approvalDialog(getWindow(), {
        type: 'question', title: '本机命令执行授权', message: '允许在本机执行 ' + plan.app + ' 检查吗？', detail: details,
        buttons: ['拒绝', '授权并执行'], defaultId: 0, cancelId: 0, noLink: true, signal,
        ...(canRemember ? { checkboxLabel: '仅本次对话内，允许以上即梦只读检查', checkboxChecked: false } : {}),
      });
      return result.response === 1 ? (canRemember && result.checkboxChecked ? 'conversation' : 'once') : 'deny';
  };
  const authorization = createCommandAuthorization({
    getContext: effectiveContext, getPlan: () => service.describeInspection(), execute: options => service.inspect(options),
    requestApproval,
  });
  function setContext(actorId, chatId = '') {
    const next = { actorId, chatId };
    if (JSON.stringify(context) !== JSON.stringify(next)) { context = next; serviceController?.abort(); runtime.clear(); authorization.revoke(); connectorAuthorization?.revoke(); send({ state: 'permission', ...permissionStatus() }); }
  }
  ipcMain.handle('extension.action', async (event, input) => {
    if (!trusted(event)) return { ok: false, message: '无效的应用请求。' };
    if (input?.action === 'resolve-approval') {
      if (!approvalPending || input.approvalId !== approvalPending.id) return {ok:false};
      const choice=input.choice;
      if (choice !== false && (!choice || !['once','task','auto'].includes(choice.mode) || !Number.isSafeInteger(choice.creditCeiling) || choice.creditCeiling < 0)) return {ok:false};
      approvalPending.settle(choice === false ? false : {mode:choice.mode,creditCeiling:choice.creditCeiling});return {ok:true};
    }
    if(input?.action==='choose-service'){
      const pending=selectionPending;
      if(!pending||input.selectionId!==pending.id||!pending.ids.includes(input.serviceId))return {ok:false};
      pending.settle({ok:true,serviceId:input.serviceId});return {ok:true};
    }
    if(input?.action==='cancel-selection'){
      if(selectionPending?.id===input.selectionId)selectionPending.settle({ok:false,code:'DENIED',message:'未选择服务，未执行任何操作。'});return {ok:true};
    }
    if (input?.action === 'inspect') {
      if (executionPending) return { ok: false, state: 'busy', message: '已有本机执行请求正在等待授权或执行。' };
      executionPending = true;
      try { const result = await authorization.run(); send({ state: 'permission', ...permissionStatus() }); return result; }
      finally { executionPending = false; }
    }
    if (input?.action === 'clear-context') { setContext(getActor(), ''); return { ok: true }; }
    if (input?.action === 'permission-status') return { ok: true, ...permissionStatus() };
    if (input?.action === 'revoke-permission') { serviceController?.abort(); runtime.revoke(); authorization.revoke(); connectorAuthorization?.revoke(); send({ state: 'permission', ...permissionStatus() }); return { ok: true, message: '已撤销本次对话的工具与终端执行授权，后续操作会重新申请。' }; }
    if(input?.action==='result-image'){
      try{
        const c=effectiveContext();if(!c.actorId||!c.chatId||typeof input.path!=='string')return {ok:false};
        const root=resolve(dataDir,'service-artifacts',createHash('sha256').update(c.actorId).digest('hex').slice(0,16),c.chatId);
        const path=realpathSync(input.path);if(!path.startsWith(root+'/'))return {ok:false};
        return {ok:true,dataUrl:serviceImageData(path)};
      }catch{return {ok:false};}
    }
    if (input?.action === 'hide') { hide(); return { ok: true }; }
    const win = getWindow();
    if (input?.action === 'bounds') {
      if (!view) return { ok: true };
      const r = input.bounds, size = win.getContentSize();
      if (!r || !['x','y','width','height'].every(k => Number.isFinite(r[k]))) return { ok: false };
      const x = Math.max(0, Math.min(size[0], Math.round(r.x))), y = Math.max(0, Math.min(size[1], Math.round(r.y)));
      const width = Math.max(0, Math.min(size[0] - x, Math.round(r.width))), height = Math.max(0, Math.min(size[1] - y, Math.round(r.height)));
      view.setBounds({ x, y, width, height }); view.setVisible(width > 0 && height > 0); return { ok: true };
    }
    if (input?.action !== 'open' && input?.action !== 'reload') return { ok: false, message: '暂不支持此应用操作。' };
    if (!view || view.webContents.isDestroyed()) {
      view = new WebContentsView({ webPreferences: { partition: 'persist:cpclaw-jimeng', sandbox: true, nodeIntegration: false, contextIsolation: true } });
      win.contentView.addChildView(view); view.setVisible(false);
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const allowed = url => { try { return new URL(url).origin === new URL(home).origin; } catch { return false; } };
      view.webContents.on('will-navigate', (e, url) => { if (!allowed(url)) { e.preventDefault(); send({ state: 'blocked', message: '此页面需跳转到外部地址，当前验证版未开放该登录跳转。' }); } });
      view.webContents.on('will-redirect', (e, url) => { if (!allowed(url)) { e.preventDefault(); send({ state: 'blocked', message: '已阻止外部页面跳转，请返回操作面板。' }); } });
      view.webContents.on('did-finish-load', () => send({ state: 'loaded', message: '即梦页面已加载；页面账号与 CLI 登录状态需分别检查。' }));
      view.webContents.on('did-fail-load', (_e, code, _description, _url, main) => { if (main && code !== -3) send({ state: 'failed', message: '页面加载失败，可刷新或切换操作面板。' }); });
      win.once('closed', () => { if (view && !view.webContents.isDestroyed()) view.webContents.close(); view = undefined; });
    }
    let target=home;
    if(input.url){try{const u=new URL(input.url);if(u.origin!==new URL(home).origin||u.username||u.password||u.hash||[...u.searchParams.keys()].some(k=>/token|sign|auth|code|credential/i.test(k)))return {ok:false,message:'画布地址无效'};target=u.href;}catch{return {ok:false};}}
    send({ state: 'loading', message: '正在加载即梦页面…' });
    void view.webContents.loadURL(target).catch(() => send({ state: 'failed', message: '页面加载失败，可刷新或切换操作面板。' }));
    return { ok: true };
  });
  async function probeConnector(connector, actorId) {
    if (actorId !== getActor()) return { ok: false, message: '当前账号已变化，请重新检测。' };
    if (executionPending) return { ok: false, message: '请先完成当前本机执行授权。' };
    if (typeof connector?.target !== 'string' || !isAbsolute(connector.target)) return { ok: false, message: '本机 CLI 检测需要程序的完整绝对路径。' };
    executionPending = true;
    try {
      const getPlan = () => {
        const executable = realpathSync(connector.target), cwd = homedir();
        const description = { app: connector.title || 'CLI 连接器', purpose: '检测本机连接器程序版本', cwd, commands: [[executable, '--version']], readOnly: false };
        return { ...description, fingerprint: createHash('sha256').update(JSON.stringify(description)).update(readFileSync(executable)).digest('hex') };
      };
      connectorAuthorization = createCommandAuthorization({
        getContext: () => ({ actorId: getActor(), chatId: '' }), getPlan, requestApproval,
        execute: async ({ beforeExecute, signal }) => {
          beforeExecute();
          const plan = getPlan();
          const { stdout } = await promisify(execFile)(plan.commands[0][0], ['--version'], { shell: false, cwd: plan.cwd, signal, timeout: 5000, maxBuffer: 4096, windowsHide: true });
          return { ok: true, message: '程序版本检测通过：' + stdout.trim().slice(0, 200) + '（未验证业务操作）' };
        },
      });
      return await connectorAuthorization.run();
    } catch { return { ok: false, message: '连接器程序检查失败，请检查路径与安装。' }; }
    finally { connectorAuthorization = undefined; executionPending = false; }
  }
  return { setContext, probeConnector, executeService, clearContext: () => { context = { actorId: null, chatId: '' }; serviceController?.abort(); runtime.clear(); authorization.revoke(); connectorAuthorization?.revoke(); } };
}
