import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.argv.includes('--platform-child')){
 const {openPlatform,listenPlatform,fixtureEmployees}=await import('../packages/platform/dist/index.js');
 const dataDir=mkdtempSync('/tmp/cpclaw-admin-ui-');
 const o=openPlatform({dataDir,port:0,listenHost:'127.0.0.1',sessionSecret:'{{SECRET_afobyoqr}}',accessTtlSec:3600,refreshTtlSec:7200,seed:{kind:'fixture',employees:fixtureEmployees},keyPresent:false,now:Date.now});assert(o.ok);
 const admin=o.app.login({employeeId:'admin',password:'fixture-admin',deviceLabel:'ui-seed'});assert(admin.ok);
 o.app.market(admin.accessToken,'connector-save',{title:'组织服务样例',type:'MCP',target:'https://example.com/mcp',enabled:true});
 o.app.setLearningEnabled(admin.accessToken,true);
 o.app.submitLearningCandidate(admin.accessToken,{kind:'experience',title:'界面审核样例',body:'共享的执行经验'});
 o.app.logout(admin.accessToken);
 const s=await listenPlatform(o.app,{dataDir,port:0,aiMockMode:true});console.log(JSON.stringify({port:s.port}));
 process.on('SIGTERM',()=>{void s.close().then(()=>{o.app.close();rmSync(dataDir,{recursive:true,force:true});process.exit(0);});});
}else{
 const {app,BrowserWindow}=await import('electron');let child,w;const errors=[];
 app.whenReady().then(async()=>{
 console.log("Electron ready");
 try{
 child=spawn(process.env.CPCLAW_NODE_BINARY||'node',[fileURLToPath(import.meta.url),'--platform-child'],{cwd:root,stdio:['ignore','pipe','pipe']});
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('平台启动超时')),10000);createInterface({input:child.stdout}).on('line',line=>{try{const v=JSON.parse(line);if(v.port){clearTimeout(timer);resolve(v.port);}}catch{}});child.on('error',reject);});
 w=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});
 w.webContents.on('console-message',(_e,level,message)=>{if(level===3){errors.push(message);console.error('renderer:',message);}});
 let step=0;const js=async s=>{step++;try{return await w.webContents.executeJavaScript(s,true);}catch(e){console.error('failed step',step,s.slice(0,65));throw e;}},sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async s=>{for(let i=0;i<120;i++){if(await js(s))return;await sleep(50);}throw Error('等待超时: '+s);};
 await w.loadURL('http://127.0.0.1:'+port+'/admin');
 await js(`$('employee-id').value='admin';$('password').value='fixture-admin';$('login-form').requestSubmit()`);
 await until(`!busy&&!$('shell').hidden&&content.textContent.includes('服务正常')`);
 assert.equal(await js(`$('identity').textContent.includes('org-demo')`),true);
 writeFileSync(root+'docs/verification/cloud-admin/overview.png',(await w.webContents.capturePage()).toPNG());
 const nav=async tab=>{await js(`document.querySelector('nav button[data-tab="${tab}"]').click()`);await until(`!busy&&!content.textContent.includes('正在读取')`);assert.equal(await js(`$('notice').classList.contains('error')`),false);};
 for(const tab of Object.keys(await js('tabs')).filter(id=>id!=='overview'))await nav(tab);
 await nav('employees');await js(`[...content.querySelectorAll('button')].find(b=>b.textContent==='新增员工').click()`);await until(`!busy&&$('dialog').open`);
 await js(`$('edit-id').value='ui-person';$('edit-name').value='<script>姓名</script>';$('edit-password').value='isolated-ui-pass';document.querySelector('#dialog-body form').requestSubmit()`);
 await until(`!busy&&!$('dialog').open&&content.textContent.includes('ui-person')`);
 assert.equal(await js(`content.querySelectorAll('script').length`),0);
 await nav('quota');await js(`[...content.querySelectorAll('tr')].find(r=>r.textContent.includes('<script>姓名</script>')).querySelector('button').click()`);await until(`!busy&&$('dialog').open`);
 await js(`$('limit').value=5432;$('concurrent').value=2;document.querySelector('#dialog-body form').requestSubmit()`);await until(`!busy&&!$('dialog').open&&content.textContent.includes('5,432')`);
 // Force an invalid access token and ensure the browser refreshes the session.
 await js(`token='invalid-ui-token';$('refresh').click()`);await until(`!busy&&$('notice').textContent==='数据已刷新'`);
 await nav('backups');await js(`[...content.querySelectorAll('button')].find(b=>b.textContent==='创建备份').click()`);await until(`!busy&&content.textContent.includes('.sqlite')`);
 await nav('knowledge');await js(`[...content.querySelectorAll('button')].find(b=>b.textContent==='新增企业知识库').click()`);await until(`!busy&&$('dialog').open`);
 await js(`document.querySelectorAll('#dialog-body input')[0].value='管理台企业库';document.querySelectorAll('#dialog-body input')[1].value='employee-a';document.querySelector('#dialog-body form').requestSubmit()`);await until(`!busy&&!$('dialog').open&&content.textContent.includes('管理台企业库')`);
 await js(`[...content.querySelectorAll('button')].find(b=>b.textContent==='管理文档').click()`);await until(`!busy&&$('dialog').open`);await js(`[...$('dialog-body').querySelectorAll('button')].find(b=>b.textContent==='新增文档').click()`);await until(`!busy&&!!document.querySelector('#dialog-body textarea')`);
 await js(`document.querySelector('#dialog-body input').value='测试制度';document.querySelector('#dialog-body textarea').value='已经发布的企业正文';document.querySelector('#dialog-body form').requestSubmit()`);await until(`!busy&&$('dialog-body').textContent.includes('测试制度')`);await js(`$('close-dialog').click()`);
 await nav('connectors');await js(`window.confirm=()=>true;[...content.querySelectorAll('button')].find(b=>b.textContent==='组织禁用').click()`);await until(`!busy&&content.textContent.includes('已禁用')`);assert.equal(await js(`market('list').then(r=>r.connectors.find(c=>c.title==='组织服务样例').enabled)`),false);
 await js(`[...content.querySelectorAll('button')].find(b=>b.textContent==='解除组织禁用').click()`);await until(`!busy&&content.textContent.includes('组织禁用')`);assert.equal(await js(`market('list').then(r=>r.connectors.find(c=>c.title==='组织服务样例').enabled)`),true);
 await nav('learning');await js(`[...content.querySelectorAll('button')].find(b=>b.textContent==='审阅').click()`);await until(`!busy&&$('dialog').open`);await js(`[...$('dialog-body').querySelectorAll('button')].find(b=>b.textContent==='通过发布').click()`);await until(`!busy&&!$('dialog').open&&content.textContent.includes('已发布')`);
 await nav('audit');await js(`content.querySelector('form input').value='nothing-matches-filter';content.querySelector('form').requestSubmit()`);await until(`!busy&&content.textContent.includes('共 0 条')`);
 await nav('catalog');assert.equal(await js(`content.textContent.includes('本机 / 个人')&&content.textContent.includes('预留')`),true);writeFileSync(root+'docs/verification/cloud-admin/enterprise-catalog.png',(await w.webContents.capturePage()).toPNG());
 await nav('employees');writeFileSync(root+'docs/verification/cloud-admin/employees.png',(await w.webContents.capturePage()).toPNG());
 w.setSize(390,844);await nav('overview');assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth`),true);writeFileSync(root+'docs/verification/cloud-admin/mobile.png',(await w.webContents.capturePage()).toPNG());
 await js(`$('logout').click()`);await until(`!busy&&$('shell').hidden`);assert.equal(await js(`token===''&&refreshToken===''&&content.children.length===0`),true);
 await js(`$('employee-id').value='employee-a';$('password').value='fixture-employee-a';$('login-form').requestSubmit()`);await until(`!busy&&$('login-error').textContent.includes('没有管理员权限')`);
 assert.equal(await js(`$('shell').hidden&&token===''`),true);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,checks:['all management sections','enterprise knowledge create and document edit','organization connector policy affects desktop catalog','learning review','audit filtering','desktop coverage catalog','employee creation and text escaping','quota update','session refresh','backup','390px responsive layout','logout cleanup','employee access denied'],screenshots:'docs/verification/cloud-admin'}));
 }catch(e){console.error(e);process.exitCode=1;}finally{w?.destroy();child?.kill('SIGTERM');app.quit();}
 });
}

