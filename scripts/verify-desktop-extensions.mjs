import { app, BrowserWindow } from 'electron';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const temp=mkdtempSync('/tmp/cpclaw-extensions-ui-');
app.setPath('userData',join(temp,'profile'));
app.whenReady().then(async () => {
setTimeout(()=>{console.error('UI verification timed out');app.exit(1);},30000).unref();
try {
 const renderer=resolve(import.meta.dirname,'../apps/desktop/renderer');
 let html=readFileSync(join(renderer,'index.html'),'utf8').replace(/<script src="[^\"]+"><\/script>/g,'');
 const fixture=`<script>
window.calls=[];window.cpclaw={extensionAction:async input=>{calls.push(input);return input.action==='inspect'?{ok:true,state:'scope',version:'1.0.1',message:'授权权限不足，请更新 CLI 与 Skill 后重新授权。'}:{ok:true};},onExtensionEvent:cb=>window.extensionEvent=cb,workspace:async()=>({ok:true,services:[
 {id:'dreamina',title:'即梦画布',type:'CLI',kind:'cli'},
 {id:'browser-page',title:'原生页面 · Computer Use',type:'WEB',kind:'computer-use'},
 {id:'local-terminal',title:'本机文件与终端',type:'CLI',kind:'app-driver'}
]})};
window.chatAccount=null;window.setStatus=()=>{};
window.marketOverlay=document.createElement('section');marketOverlay.className='market-overlay';marketOverlay.hidden=true;document.body.append(marketOverlay);
window.marketClose=document.createElement('button');marketClose.onclick=()=>marketOverlay.hidden=true;
window.openPanel=name=>{document.getElementById('panel-title').textContent=name==='extensions'?'拓展应用':name;document.getElementById('inspector').hidden=false;for(const p of ['extensions','documents','sources','settings','review']){const node=document.getElementById('panel-'+p);if(node)node.hidden=p!==name;}};
document.getElementById('close-panel').onclick=()=>document.getElementById('inspector').hidden=true;
</script><script src="${pathToFileURL(join(renderer,'extensions.js'))}"></script><script src="${pathToFileURL(join(renderer,'quick-rail.js'))}"></script>`;
 html=html.replace('<head>','<head><base href="'+pathToFileURL(renderer+'/')+'">').replace('</body>',fixture+'</body>');
 const page=join(temp,'index.html');writeFileSync(page,html);
 const w=new BrowserWindow({width:1500,height:900,show:true});const errors=[];
 w.webContents.on('console-message',(_e,level,message)=>{if(level===3)errors.push(message);});
 await w.loadFile(page);const js=s=>w.webContents.executeJavaScript(s);
 const settle=()=>js('new Promise(r=>setTimeout(r,120))');
 const evidence=resolve(import.meta.dirname,'../docs/verification/extensions');mkdirSync(evidence,{recursive:true});
 await js("document.getElementById('rail-extensions').click()");await settle();
 assert.equal(await js("document.getElementById('extension-picker').open"),true);
 assert.equal(await js("document.getElementById('inspector').hidden"),true);
 assert.equal(await js("document.querySelector('.extension-service-list-heading #extension-manage-services')!==null"),true);
 assert.equal(await js("document.querySelectorAll('.extension-kind-tab').length"),3);
 const beforeSelect=await js('calls.length');

 // Computer Use 分类下不得出现即梦 CLI
 const computerUseTitles=await js("Array.from(document.querySelectorAll('#extension-other-services .extension-service-item strong')).map(n=>n.textContent)");
 assert(!computerUseTitles.includes('即梦画布'),'Computer Use 分类不应显示即梦');
 assert(computerUseTitles.includes('原生页面 · Computer Use'));
 assert.equal(await js("document.getElementById('extension-detail-title').textContent"),'原生页面 · Computer Use');

 // 驱动应用分类下不得出现即梦 CLI
 await js("document.querySelector('.extension-kind-tab[data-kind=\"app-driver\"]').click()");await settle();
 const driverTitles=await js("Array.from(document.querySelectorAll('#extension-other-services .extension-service-item strong')).map(n=>n.textContent)");
 assert(!driverTitles.includes('即梦画布'),'驱动应用分类不应显示即梦');
 assert(driverTitles.includes('本机文件与终端'));
 assert.equal(await js("document.getElementById('extension-detail-title').textContent"),'本机文件与终端');

 // CLI 三方分类才显示即梦
 await js("document.querySelector('.extension-kind-tab[data-kind=\"cli\"]').click()");await settle();
 const cliTitles=await js("Array.from(document.querySelectorAll('#extension-other-services .extension-service-item strong')).map(n=>n.textContent)");
 assert(cliTitles.includes('即梦画布'),'CLI 三方分类应显示即梦');
 assert.equal(await js("document.getElementById('extension-detail-title').textContent"),'即梦画布');
 await js("document.querySelector('#extension-other-services .extension-service-item[data-service=\"dreamina\"]').click()");await settle();
 assert.equal(await js("document.getElementById('extension-service-dreamina' )===null"),true);
 assert.equal(await js("document.getElementById('extension-check').closest('#extension-service-details')!==null"),true);
 assert.equal(await js("document.querySelector('.extension-service-list').getBoundingClientRect().right<=document.getElementById('extension-service-details').getBoundingClientRect().left"),true);

 await js("document.getElementById('extension-check').click()");await settle();
 assert.match(await js("document.getElementById('extension-summary').textContent"),/权限不足/);
 writeFileSync(join(evidence,'extensions-picker.png'),(await w.webContents.capturePage()).toPNG());
 w.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});w.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await settle();
 assert.equal(await js("document.getElementById('extension-picker').open"),false);
 assert.equal(await js("document.getElementById('inspector').hidden"),true);
 await js("document.getElementById('rail-extensions').click()");await settle();
 await js("document.querySelector('.extension-kind-tab[data-kind=\"cli\"]').click()");await settle();
 await js("document.getElementById('extension-start').click()");await settle();
 assert.equal(await js("document.getElementById('extension-picker').open"),false);
 assert.equal(await js("document.getElementById('panel-extensions').hidden"),false);
 assert.equal(await js("document.getElementById('extension-cli-panel').hidden"),false);
 assert.equal(await js("document.getElementById('rail-extensions').getAttribute('aria-current')"),'true');
 assert.match(await js("document.getElementById('extension-cli-status').textContent"),/左侧描述任务/);
 await js("document.getElementById('extension-native').click()");await settle();
 assert.equal(await js("calls.some(c=>c.action==='open')"),true);
 assert.equal(await js("calls.some(c=>c.action==='bounds'&&c.bounds.width>100)"),true);
 await js("document.getElementById('rail-extensions').click()");await settle();
 assert.equal(await js("document.getElementById('extension-picker').open"),true);
 assert.equal(await js("calls.at(-1).action"),'hide');
 await js("document.getElementById('extension-picker-close').click()");await settle();
 assert.equal(await js("calls.at(-1).action"),'bounds');
 await js("extensionEvent({state:'failed',message:'页面加载失败'})");await settle();
 assert.equal(await js("document.getElementById('extension-cli-panel').hidden"),false);
 assert.equal(await js("calls.at(-1).action"),'hide');
 assert.equal(await js("Boolean(document.querySelector('.extension-toolbar,#extension-list,#extension-expand,#extension-back'))"),false);
 await js("document.getElementById('close-panel').click()");await settle();
 assert.equal(await js("document.getElementById('inspector').hidden"),true);
 await js("document.getElementById('rail-extensions').click()");await settle();
 w.setSize(800,720);await settle();
 assert.equal(await js("document.getElementById('extension-picker').getBoundingClientRect().width<=innerWidth"),true);
 writeFileSync(join(evidence,'extensions-picker-narrow.png'),(await w.webContents.capturePage()).toPNG());
 await js("document.querySelector('.extension-kind-tab[data-kind=\"cli\"]').click()");await settle();
 await js("document.getElementById('extension-start').click()");await settle();
 assert.equal(await js("document.documentElement.scrollWidth<=innerWidth"),true);
 writeFileSync(join(evidence,'extensions-narrow.png'),(await w.webContents.capturePage()).toPNG());
 w.setSize(1500,900);await settle();writeFileSync(join(evidence,'extensions-wide.png'),(await w.webContents.capturePage()).toPNG());
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['picker-first','picker-escape','three-kind-tabs','kind-scoped-services','no-dreamina-outside-cli','selection-opens-panel','native-hidden-under-picker','scope-status','rail-selection','native-bounds','failure-fallback','toolbar-removed','close','narrow-layout'],screenshots:evidence}));app.exit(0);
} catch(e){console.error(e);app.exit(1);}

});

