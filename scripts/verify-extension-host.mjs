import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { registerExtensionHost } from '../apps/desktop/extension-host.mjs';
const temp=mkdtempSync('/tmp/cpclaw-extension-host-');app.setPath('userData',join(temp,'profile'));
let win;
registerExtensionHost({ipcMain,getWindow:()=>win});
app.whenReady().then(async()=>{
 const timer=setTimeout(()=>{console.error('host verification timeout');app.exit(1);},35000);
 try {
  const preload=join(temp,'preload.cjs');writeFileSync(preload,"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('probe',{action:i=>ipcRenderer.invoke('extension.action',i)});");
  const html=join(temp,'index.html');writeFileSync(html,'<!doctype html><title>Isolated extension host test</title>');
  win=new BrowserWindow({show:false,width:1100,height:720,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await win.loadFile(html);const js=s=>win.webContents.executeJavaScript(s);
  assert.equal((await js("probe.action({action:'execute',command:'echo unsafe'})")).ok,false);
  const loaded=new Promise((resolve,reject)=>{const check=setInterval(()=>{const child=win.contentView.children[0];if(child?.webContents.getURL()==='https://jimeng.jianying.com/'&&!child.webContents.isLoading()){clearInterval(check);resolve();}},150);setTimeout(()=>{clearInterval(check);reject(Error('page load timeout'));},25000).unref();});
  assert.equal((await js("probe.action({action:'open',url:'file:///etc/passwd'})")).ok,true);
  await js("probe.action({action:'bounds',bounds:{x:550,y:50,width:550,height:650}})");
  await loaded;
  const view=win.contentView.children[0];assert.equal(view.webContents.getURL(),'https://jimeng.jianying.com/');
  assert.equal(await view.webContents.executeJavaScript('typeof window.cpclaw'),'undefined');
  assert.equal(await view.webContents.executeJavaScript('typeof require'),'undefined');
  assert.equal((await js("probe.action({action:'hide'})")).ok,true);
  clearTimeout(timer);console.log(JSON.stringify({ok:true,checks:['fixed-url','unknown-action-rejected','isolated-native-page','no-node-or-host-bridge','hide']}));app.exit(0);
 }catch(e){clearTimeout(timer);console.error(e);app.exit(1);}
});
