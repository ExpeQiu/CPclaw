(() => {
  if (!window.cpclaw.extensionAction) return;
  const el=id=>document.getElementById(id),action=input=>window.cpclaw.extensionAction(input);
  const panel=el('panel-extensions'),inspector=el('inspector'),slot=el('extension-native-slot'),picker=el('extension-picker');
  let native=false,workspace=false,checking=false,frame,selected={id:'dreamina',title:'即梦画布',type:'CLI'},activeService=selected;
  let services=[selected], records=[],canvasUrl='',resultsGeneration=0,selectionId='';
  const feedback=text=>{el('extension-feedback').textContent=text??'';el('extension-panel-feedback').textContent=text??'';};
  function sync(){cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const visible=!checking&&!picker.open&&native&&workspace&&!panel.hidden&&!inspector.hidden&&!document.querySelector('.market-overlay:not([hidden])');const r=slot.getBoundingClientRect();void action(visible?{action:'bounds',bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}:{action:'hide'}).catch(()=>{});});}
  function configure(){
    el('extension-detail-title').textContent=selected.title;
    el('extension-detail-title').nextElementSibling.textContent=selected.id==='dreamina'?'图片、视频、音频与画布 · dreamina-canvas CLI':`${selected.type} · 按服务实际工具执行`;
    el('extension-check').hidden=selected.id!=='dreamina';
    el('extension-summary').textContent=selected.id==='dreamina'?'可读取 CLI 状态，创作能力由实际版本提供。':'执行任务前会发现真实命令或 MCP 工具；每次调用均需授权。';
    document.querySelectorAll('.extension-service-item').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.service===selected.id)));
  }
  function select(service){selected=service;configure();}
  async function refreshServices(){
    if(!window.cpclaw.workspace)return;
    const r=await window.cpclaw.workspace({method:'chat.services',input:{}});
    if(!r.ok)throw Error(r.message);
    services=r.services;el('extension-other-services').replaceChildren();
    for(const service of services.filter(s=>s.id!=='dreamina')){const button=document.createElement('button');button.type='button';button.className='extension-service-item';button.dataset.service=service.id;const strong=document.createElement('strong');strong.textContent=service.title;const text=document.createElement('span');text.textContent=service.type==='MCP'?'网页 / SaaS · MCP':'本机 CLI';button.append(strong,text);button.onclick=()=>select(service);el('extension-other-services').append(button);}
    selected=services.find(s=>s.id===selected.id)??services[0];configure();
  }
  async function check(){
    if(checking)return;checking=true;el('extension-check').disabled=el('extension-recheck').disabled=true;
    el('extension-summary').textContent=el('extension-cli-status').textContent='等待本机执行授权…';sync();
    try{const r=await action({action:'inspect'});el('extension-summary').textContent=el('extension-cli-status').textContent=`${r.version?`v${r.version} · `:''}${r.message}`;el('extension-catalog').dataset.state=r.state;feedback(r.message);}
    catch{el('extension-cli-status').textContent='检查失败，请重试。';}
    finally{checking=false;el('extension-check').disabled=el('extension-recheck').disabled=false;sync();}
  }
  async function mode(value){
    native=value&&activeService.id==='dreamina';slot.hidden=!native;
    el('extension-cli-panel').hidden=el('service-operation-results').hidden=native;
    el('panel-title').textContent=`${activeService.title} · ${native?'原生页面':'操作面板'}`;
    el('extension-native').setAttribute('aria-pressed',String(native));el('extension-cli').setAttribute('aria-pressed',String(!native));
    if(native){try{const r=await action({action:'open',...(canvasUrl?{url:canvasUrl}:{})});if(!r.ok)throw Error(r.message);}catch(e){feedback(e.message);}}
    sync();
  }
  window.showServiceWorkspace=service=>{
    activeService=services.find(s=>s.id===service.id)??service;workspace=true;
    el('extension-workspace').hidden=false;el('extension-view-controls').hidden=false;
    el('service-panel-name').textContent=activeService.title;el('extension-native').hidden=activeService.id!=='dreamina';el('extension-recheck').hidden=activeService.id!=='dreamina';
    el('extension-cli-status').textContent='在左侧描述任务，执行前会显示授权弹窗。';
    openPanel('extensions');void mode(false);
  };
  window.executionServiceName=id=>services.find(s=>s.id===id)?.title??(id==='dreamina'?'即梦画布':'');
  el('extension-service-dreamina').dataset.service='dreamina';
  el('extension-service-dreamina').onclick=()=>select(services.find(s=>s.id==='dreamina')??services[0]);
  el('extension-check').onclick=el('extension-recheck').onclick=check;
  el('extension-start').onclick=async()=>{
    el('extension-start').disabled=true;
    try{if(selectionId){const r=await action({action:'choose-service',selectionId,serviceId:selected.id});if(!r.ok)return;selectionId='';window.showServiceWorkspace(selected);}else if(window.chooseExecutionService){if(!await window.chooseExecutionService(selected))return;}else window.showServiceWorkspace(selected);picker.close();}
    finally{el('extension-start').disabled=false;sync();}
  };
  el('extension-manage-services').onclick=()=>{picker.close();el('rail-market').click();};
  window.openExtensionPicker=async()=>{
    if(picker.open)return;await action({action:'hide'}).catch(()=>{});picker.showModal();sync();
    try{await refreshServices();}catch(e){el('extension-summary').textContent=e.message||'服务目录读取失败，请检查平台连接。';}
  };
  el('extension-picker-close').onclick=()=>picker.close();picker.addEventListener('close',()=>{if(selectionId){void action({action:'cancel-selection',selectionId});selectionId='';}sync();});
  picker.addEventListener('click',e=>{if(e.target!==picker)return;const r=picker.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)picker.close();});
  el('extension-native').onclick=()=>void mode(true);el('extension-cli').onclick=()=>void mode(false);
  el('extension-refresh').onclick=()=>native?void mode(true):void renderResults();
  el('extension-revoke').onclick=async()=>{const r=await action({action:'revoke-permission'});feedback(r.message);};
  const permission=r=>{el('extension-permission').textContent=r.remembered?'本次对话已允许即梦只读检查':'命令与服务调用均需执行授权';el('extension-revoke').hidden=!r.remembered;};
  void action({action:'permission-status'}).then(permission).catch(()=>{});
  function urls(value,result=[]){if(Array.isArray(value))for(const v of value)urls(v,result);else if(value&&typeof value==='object'){for(const [k,v]of Object.entries(value)){if(k==='webUrl'&&typeof v==='string')result.push(v);else urls(v,result);}}return result;}
  function imageNode(dataUrl,path){const card=document.createElement('div');card.className='service-result';const title=document.createElement('strong');title.textContent='生成图片 · 已下载到本地';const img=document.createElement('img');img.src=dataUrl;img.alt='服务实际生成并下载的图片';const location=document.createElement('p');location.textContent=path;card.append(title,img,location);return card;}
  async function renderResults(){
    const generation=++resultsGeneration,root=el('service-operation-results');root.replaceChildren();canvasUrl='';
    for(const record of records){
      const card=document.createElement('details');card.className='service-result';const title=document.createElement('summary');title.textContent=`${record.step}. ${record.service.title} · ${record.request.purpose||record.request.tool||record.request.args?.slice(0,3).join(' ')||'发现能力'} · ${record.result.ok===false?'未完成':'已返回'}`;
      const pre=document.createElement('pre');pre.textContent=JSON.stringify(record.result,null,2);card.append(title,pre);
      for(const url of urls(record.result)){try{const u=new URL(url);if(u.origin!=='https://jimeng.jianying.com'||u.hash||[...u.searchParams.keys()].some(k=>/token|sign|auth|code|credential/i.test(k)))continue;canvasUrl=url;const button=document.createElement('button');button.textContent='打开此画布 ↗';button.onclick=e=>{e.preventDefault();canvasUrl=url;void mode(true);};card.append(button);}catch{}}
      root.append(card);
      const path=record.result.data?.path;
      if(record.request.args?.[0]==='resource'&&record.request.args?.[1]==='download'&&typeof path==='string'){
        const r=await action({action:'result-image',path}).catch(()=>({}));
        if(generation!==resultsGeneration)return;
        if(r.ok&&r.dataUrl)root.append(imageNode(r.dataUrl,path));
      }
    }
    root.scrollTop=root.scrollHeight;sync();
  }
  window.restoreServicePanel=(steps,execution)=>{records=steps;canvasUrl='';void renderResults();if(execution.service){window.showServiceWorkspace(services.find(s=>s.id===execution.service)??{id:execution.service,title:'所选服务'});void refreshServices().then(()=>{if(typeof renderComposer==='function')renderComposer();if(chatExecution.service===execution.service)window.showServiceWorkspace(services.find(s=>s.id===execution.service)??{id:execution.service,title:'所选服务'});}).catch(()=>{});}else{workspace=false;native=false;sync();}};
  window.showServiceEvent=event=>{chatExecution={mode:'chat',service:event.service.id};renderComposer();if(event.record)records.push(event.record);window.showServiceWorkspace(event.service);void renderResults();};
  el('close-panel').addEventListener('click',sync);
  window.cpclaw.onExtensionEvent(event=>{
    if(event.state==='choose-service'){
      services=event.services;selectionId=event.selectionId;
      if(!picker.open)picker.showModal();
      selected=services[0];configure();el('extension-other-services').replaceChildren();
      for(const service of services.filter(s=>s.id!=='dreamina')){const b=document.createElement('button');b.type='button';b.className='extension-service-item';b.dataset.service=service.id;b.textContent=service.title+' · '+service.type;b.onclick=()=>select(service);el('extension-other-services').append(b);}
      el('extension-summary').textContent='请选择此次任务使用的服务，随后申请操作授权。';sync();return;
    }
    if(event.state==='permission'){permission(event);return;}
    if(event.state==='result'&&event.type==='authorization'){if(event.chatId!==currentChatId||event.actorId!==chatAccount)return;el('extension-cli-status').textContent='请在已打开的官方页面完成授权，然后在左侧继续。'+(event.userCode?' 验证码：'+event.userCode:'');return;}
    if(event.state==='result'&&event.type==='image'){if(event.chatId!==currentChatId||event.actorId!==chatAccount)return;el('service-operation-results').append(imageNode(event.dataUrl,event.path));return;}
    feedback(event.message);if(['failed','blocked'].includes(event.state))void mode(false);sync();
  });
  new ResizeObserver(sync).observe(slot);
  new MutationObserver(sync).observe(inspector,{attributes:true,subtree:true,attributeFilter:['hidden']});
  const overlay=document.querySelector('.market-overlay');if(overlay)new MutationObserver(sync).observe(overlay,{attributes:true,attributeFilter:['hidden']});
  window.addEventListener('resize',sync);
})();
