(() => {
  if (!window.cpclaw.extensionAction) return;
  const el=id=>document.getElementById(id),action=input=>window.cpclaw.extensionAction(input);
  const panel=el('panel-extensions'),inspector=el('inspector'),slot=el('extension-native-slot'),picker=el('extension-picker'),approval=el('service-approval');
  let approvalRequest;
  let native=false,workspace=false,checking=false,frame;
  let selected={id:'dreamina',title:'即梦画布',type:'CLI',kind:'cli'},activeService=selected;
  let services=[selected], records=[],canvasUrl='',pageUrl='',resultsGeneration=0,selectionId='',activeKind='computer-use';
  const feedback=text=>{el('extension-feedback').textContent=text??'';el('extension-panel-feedback').textContent=text??'';};
  const DREAMINA_ORIGIN='https://jimeng.jianying.com';
  const KIND_BLURB={
    'computer-use':'直接控制网页页面；点击与输入走可访问树，登录与支付需请示。',
    'app-driver':'选定本地应用或项目文件夹，通过代码层读写与终端驱动，右侧可见交互。',
    cli:'绑定本机 CLI 后按自动化流程驱动，例如即梦画布。',
  };
  function serviceKind(service){
    if(service?.kind)return service.kind;
    if(service?.id==='browser-page'||service?.type==='WEB'||service?.type==='MCP')return 'computer-use';
    if(service?.id==='local-terminal'||service?.type==='APP')return 'app-driver';
    return 'cli';
  }
  function pageOrigins(service){
    if(!service)return [];
    if(service.id==='dreamina')return [DREAMINA_ORIGIN];
    const origins=[];
    const push=value=>{try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return;if(!origins.includes(u.origin))origins.push(u.origin);}catch{}};
    if(Array.isArray(service.pageOrigins))for(const o of service.pageOrigins)push(o);
    if(typeof service.pageUrl==='string')push(service.pageUrl);
    if(service.type==='WEB'&&typeof service.target==='string')push(service.target);
    return origins;
  }
  function canNative(service){return pageOrigins(service).length>0;}
  function kindSubtitle(service){
    const kind=serviceKind(service);
    if(service.id==='dreamina')return 'CLI 三方 · 图片、视频、音频与画布';
    if(service.id==='browser-page')return 'Computer Use · 结构化原生页';
    if(service.id==='local-terminal')return '驱动应用 · 本机文件与终端';
    if(kind==='computer-use')return service.type==='MCP'?'Computer Use · 网页 / SaaS（MCP）':'Computer Use · 网页';
    if(kind==='app-driver')return '驱动应用 · 本地文件夹';
    return 'CLI 三方 · 本机程序';
  }
  function kindSummary(service){
    const kind=serviceKind(service);
    if(service.id==='dreamina')return '可读取 CLI 状态，创作能力由实际版本提供。按当前对话权限执行。';
    if(kind==='computer-use')return '可在允许源内操作页面；登录、支付或密码输入会强制请求确认。';
    if(kind==='app-driver')return service.root?`工作目录：${service.root}\nAI 通过本机文件与终端在此目录驱动应用；请在左侧描述任务。`:'对本机文件与终端执行；可在此分类下添加应用文件夹。';
    return '执行前会发现真实 CLI 能力，按当前对话权限执行。';
  }
  function sync(){cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const visible=!checking&&!picker.open&&!approval.open&&native&&workspace&&!panel.hidden&&!inspector.hidden&&!document.querySelector('.market-overlay:not([hidden])');const r=slot.getBoundingClientRect();void action(visible?{action:'bounds',bounds:{x:r.x,y:r.y,width:r.width,height:r.height}}:{action:'hide'}).catch(()=>{});});}
  function configure(){
    const choosing=Boolean(selectionId);
    const inKind=Boolean(selected)&&(choosing||serviceKind(selected)===activeKind);
    if(!inKind){
      el('extension-detail-title').textContent=activeKind==='app-driver'?'驱动应用':activeKind==='computer-use'?'Computer Use':'CLI 三方应用';
      el('extension-detail-title').nextElementSibling.textContent=KIND_BLURB[activeKind]||'';
      el('extension-check').hidden=true;
      el('extension-remove-local').hidden=true;
      el('extension-start').disabled=true;
      el('extension-summary').textContent=activeKind==='cli'?'请从左侧选择一个 CLI 服务。':activeKind==='app-driver'?'请选择本地文件夹添加驱动应用，或选择左侧已有项。':'请添加网页，或选择左侧已有 Computer Use 服务。';
      document.querySelectorAll('.extension-service-item').forEach(b=>b.setAttribute('aria-pressed','false'));
      return;
    }
    el('extension-detail-title').textContent=selected.title;
    el('extension-detail-title').nextElementSibling.textContent=kindSubtitle(selected);
    el('extension-check').hidden=selected.id!=='dreamina';
    el('extension-remove-local').hidden=!selected.local;
    el('extension-start').disabled=false;
    el('extension-summary').textContent=kindSummary(selected);
    document.querySelectorAll('.extension-service-item').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.service===selected.id)));
  }
  function select(service){
    if(!service)return;
    if(!selectionId&&serviceKind(service)!==activeKind)return;
    selected=service;
    if(selectionId)activeKind=serviceKind(service);
    renderKindChrome();
    configure();
  }
  function renderKindChrome(){
    document.querySelectorAll('.extension-kind-tab').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.kind===activeKind)));
    el('extension-kind-blurb').textContent=KIND_BLURB[activeKind]||'';
    const actions=el('extension-kind-actions');actions.replaceChildren();
    if(activeKind==='computer-use'){
      const label=document.createElement('label');label.textContent='添加网页地址';
      const input=document.createElement('input');input.type='url';input.placeholder='https://example.com';input.id='extension-add-page-url';
      const row=document.createElement('div');row.className='button-row';
      const add=document.createElement('button');add.type='button';add.textContent='添加网页';add.onclick=()=>void addComputerUse(input.value);
      row.append(add);label.append(input);actions.append(label,row);
    }else if(activeKind==='app-driver'){
      const row=document.createElement('div');row.className='button-row';
      const add=document.createElement('button');add.type='button';add.className='primary';add.textContent='选择应用 / 项目文件夹';add.onclick=()=>void addAppDriver();
      row.append(add);actions.append(row);
    }else{
      const row=document.createElement('div');row.className='button-row';
      const market=document.createElement('button');market.type='button';market.textContent='配置 CLI 连接器';market.onclick=()=>{picker.close();el('rail-market').click();};
      row.append(market);actions.append(row);
    }
  }
  function renderServiceList(){
    const list=el('extension-other-services');list.replaceChildren();
    const choosing=Boolean(selectionId);
    const items=choosing?services:services.filter(s=>serviceKind(s)===activeKind);
    if(!items.length){
      const empty=document.createElement('p');empty.className='muted';empty.textContent=activeKind==='cli'?'尚未配置 CLI；内置即梦应出现在此列表，或去技能市场添加连接器。':activeKind==='app-driver'?'尚未添加驱动应用；请选择本地文件夹。':'可使用内置原生页，或添加网页地址。';
      list.append(empty);
      selected=null;
    }else{
      for(const service of items){
        const button=document.createElement('button');button.type='button';button.className='extension-service-item';button.dataset.service=service.id;
        const strong=document.createElement('strong');strong.textContent=service.title;
        const text=document.createElement('span');text.textContent=kindSubtitle(service);
        button.append(strong,text);button.onclick=()=>select(service);list.append(button);
      }
      selected=items.some(s=>s.id===selected?.id)?items.find(s=>s.id===selected.id):items[0];
    }
    configure();
  }
  async function refreshServices(){
    if(!window.cpclaw.workspace)return;
    const r=await window.cpclaw.workspace({method:'chat.services',input:{}});
    if(!r.ok)throw Error(r.message);
    services=r.services.map(s=>({...s,kind:serviceKind(s)}));
    renderKindChrome();renderServiceList();
  }
  async function addComputerUse(pageUrl){
    try{
      const r=await window.cpclaw.workspace({method:'extensions.add-computer-use',input:{pageUrl}});
      if(!r.ok)throw Error(r.message||'添加失败');
      await refreshServices();select(r.service);feedback('已添加网页 · '+r.service.title);
    }catch(e){feedback(e.message);}
  }
  async function addAppDriver(){
    try{
      const pick=await action({action:'pick-directory',title:'选择要驱动的应用或项目文件夹'});
      if(!pick.ok)throw Error(pick.message||'无法选择文件夹');
      if(pick.cancelled)return;
      const r=await window.cpclaw.workspace({method:'extensions.add-app-driver',input:{root:pick.path}});
      if(!r.ok)throw Error(r.message||'添加失败');
      activeKind='app-driver';await refreshServices();select(r.service);feedback('已添加驱动应用 · '+r.service.title);
    }catch(e){feedback(e.message);}
  }
  async function removeLocal(){
    if(!selected.local)return;
    try{
      const r=await window.cpclaw.workspace({method:'extensions.remove',input:{id:selected.id}});
      if(!r.ok)throw Error(r.message||'移除失败');
      await refreshServices();feedback('已移出本机列表');
    }catch(e){feedback(e.message);}
  }
  async function check(){
    if(checking)return;checking=true;el('extension-check').disabled=el('extension-recheck').disabled=true;
    el('extension-summary').textContent=el('extension-cli-status').textContent='等待本机执行授权…';sync();
    try{const r=await action({action:'inspect'});el('extension-summary').textContent=el('extension-cli-status').textContent=`${r.version?`v${r.version} · `:''}${r.message}`;el('extension-catalog').dataset.state=r.state;feedback(r.message);}
    catch{el('extension-cli-status').textContent='检查失败，请重试。';}
    finally{checking=false;el('extension-check').disabled=el('extension-recheck').disabled=false;sync();}
  }
  async function mode(value){
    const preferNative=value||serviceKind(activeService)==='computer-use';
    native=Boolean(preferNative&&canNative(activeService));slot.hidden=!native;
    el('extension-cli-panel').hidden=el('service-operation-results').hidden=native;
    const viewLabel=native?'原生页面':serviceKind(activeService)==='app-driver'?'驱动面板':'自动工作流';
    el('panel-title').textContent=`${activeService.title} · ${viewLabel}`;
    el('extension-native').setAttribute('aria-pressed',String(native));el('extension-cli').setAttribute('aria-pressed',String(!native));
    if(native){
      const origins=pageOrigins(activeService);
      const url=pageUrl||canvasUrl||(origins[0]?`${origins[0]}/`:undefined);
      try{const r=await action({action:'open',service:activeService,origins,...(url?{url}:{})});if(!r.ok)throw Error(r.message);}catch(e){feedback(e.message);}
    }
    if(!native&&activeService.root)el('extension-cli-status').textContent=`驱动目录：${activeService.root}`;
    sync();
  }
  window.showServiceWorkspace=service=>{
    activeService=services.find(s=>s.id===service.id)??{...service,kind:serviceKind(service)};
    workspace=true;pageUrl=typeof activeService.pageUrl==='string'?activeService.pageUrl:'';
    el('extension-workspace').hidden=false;el('extension-view-controls').hidden=false;
    el('service-panel-name').textContent=activeService.title;
    el('extension-native').hidden=!canNative(activeService);
    el('extension-recheck').hidden=activeService.id!=='dreamina';
    el('extension-cli').textContent=serviceKind(activeService)==='app-driver'?'驱动面板':'自动工作流';
    el('extension-cli-status').textContent=serviceKind(activeService)==='app-driver'
      ?`驱动目录：${activeService.root||'本机工作区'}。在左侧描述任务，将按对话权限执行。`
      :'在左侧描述任务，将按当前对话权限执行。登录与支付需确认。';
    openPanel('extensions');
    void mode(serviceKind(activeService)==='computer-use'&&canNative(activeService));
  };
  window.executionServiceName=id=>services.find(s=>s.id===id)?.title??(id==='dreamina'?'即梦画布':'');
  for(const tab of document.querySelectorAll('.extension-kind-tab'))tab.onclick=()=>{
    activeKind=tab.dataset.kind;
    renderKindChrome();
    renderServiceList();
  };
  el('extension-check').onclick=el('extension-recheck').onclick=check;
  el('extension-remove-local').onclick=()=>void removeLocal();
  el('extension-start').onclick=async()=>{
    if(!selected||serviceKind(selected)!==activeKind){feedback('请先选择当前分类下的服务');return;}
    el('extension-start').disabled=true;
    try{if(selectionId){const r=await action({action:'choose-service',selectionId,serviceId:selected.id});if(!r.ok)return;selectionId='';window.showServiceWorkspace(selected);}else if(window.chooseExecutionService){if(!await window.chooseExecutionService(selected))return;}else window.showServiceWorkspace(selected);picker.close();}
    finally{el('extension-start').disabled=!selected||serviceKind(selected)!==activeKind;sync();}
  };
  el('extension-manage-services').onclick=()=>{picker.close();el('rail-market').click();};
  window.openExtensionPicker=async()=>{
    if(picker.open)return;await action({action:'hide'}).catch(()=>{});picker.showModal();sync();
    try{await refreshServices();}catch(e){el('extension-summary').textContent=e.message||'服务目录读取失败，请检查平台连接。';renderKindChrome();}
  };
  el('extension-picker-close').onclick=()=>picker.close();picker.addEventListener('close',()=>{if(selectionId){void action({action:'cancel-selection',selectionId});selectionId='';}sync();});
  picker.addEventListener('click',e=>{if(e.target!==picker)return;const r=picker.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)picker.close();});
  el('extension-native').onclick=()=>void mode(true);el('extension-cli').onclick=()=>void mode(false);
  el('extension-refresh').onclick=()=>native?void mode(true):void renderResults();
  el('extension-revoke').onclick=async()=>{const r=await action({action:'revoke-permission'});feedback(r.message);};
  const permission=r=>{const grants=r.grants??[];const mode={ask:'请求批准 · 每次执行前询问',auto:'帮我批准 · 已知只读操作自动通过',full:'完全访问权限 · 当前对话的本机文件、终端与网络'}[r.mode]||'按当前对话权限执行';const grantText=grants.map(g=>`${g.service} · ${g.mode==='auto'?'本次对话已授权':'本次任务已授权'}${g.creditCeiling?` · 积分已预留 ${g.reservedCredits}/${g.creditCeiling}`:''}`).join('；');el('extension-permission').textContent=mode+(grantText?'；'+grantText:r.remembered?'；已允许即梦只读检查':'');el('extension-revoke').hidden=!r.remembered&&!grants.length&&(!r.mode||r.mode==='ask');};
  void action({action:'permission-status'}).then(permission).catch(()=>{});
  function approvalScope(){
    const mode=el('service-approval-mode').value;
    el('service-approval-scope').textContent=mode==='auto'?'自动执行本次对话中该服务的后续工具与终端指令，包含读取、写入、查询和下载。':mode==='task'?'覆盖当前这次 AI 任务中该服务的全部工具与终端指令，任务内不再逐条确认。':'只执行详情中列出的当前操作，后续操作再次询问。';
    const spent=mode==='once'?0:approvalRequest?.reservedCredits??0;
    el('service-approval-budget').min=String(spent+(approvalRequest?.requiredCredits??0));
  }
  async function resolveApproval(choice){
    if(!approvalRequest)return;
    const id=approvalRequest.approvalId;approvalRequest=undefined;
    approval.close();sync();await action({action:'resolve-approval',approvalId:id,choice});
  }
  el('service-approval-mode').onchange=approvalScope;
  el('service-approval-form').onsubmit=e=>{e.preventDefault();if(!e.target.reportValidity())return;void resolveApproval({mode:el('service-approval-mode').value,creditCeiling:Number(el('service-approval-budget').value)});};
  el('service-approval-deny').onclick=()=>void resolveApproval(false);
  approval.addEventListener('cancel',e=>{e.preventDefault();void resolveApproval(false);});
  function urls(value,result=[]){if(Array.isArray(value))for(const v of value)urls(v,result);else if(value&&typeof value==='object'){for(const [k,v]of Object.entries(value)){if(k==='webUrl'&&typeof v==='string')result.push(v);else urls(v,result);}}return result;}
  function imageNode(dataUrl,path){const card=document.createElement('div');card.className='service-result';const title=document.createElement('strong');title.textContent='生成图片 · 已下载到本地';const img=document.createElement('img');img.src=dataUrl;img.alt='服务实际生成并下载的图片';const location=document.createElement('p');location.textContent=path;card.append(title,img,location);return card;}
  async function renderResults(){
    const generation=++resultsGeneration,root=el('service-operation-results');root.replaceChildren();canvasUrl='';
    for(const record of records){
      const card=document.createElement('details');card.className='service-result';const title=document.createElement('summary');title.textContent=`${record.step}. ${record.service.title} · ${record.request.purpose||record.request.tool||record.request.args?.slice(0,3).join(' ')||'发现能力'} · ${record.result.ok===false?'未完成':'已返回'}`;
      const pre=document.createElement('pre');pre.textContent=JSON.stringify(record.result,null,2);card.append(title,pre);
      for(const url of urls(record.result)){try{const u=new URL(url);const allowed=pageOrigins(activeService);if((allowed.length? !allowed.includes(u.origin):u.origin!==DREAMINA_ORIGIN)||u.hash||[...u.searchParams.keys()].some(k=>/token|sign|auth|code|credential/i.test(k)))continue;canvasUrl=url;pageUrl=url;const button=document.createElement('button');button.textContent=u.origin===DREAMINA_ORIGIN?'打开此画布 ↗':'在原生页打开 ↗';button.onclick=e=>{e.preventDefault();canvasUrl=url;pageUrl=url;void mode(true);};card.append(button);}catch{}}
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
    if(event.state==='approval'){
      approvalRequest=event;
      const sensitive=/登录或支付|登录|支付/.test(`${event.title||''}${event.message||''}`);
      el('service-approval-title').textContent=event.budgetExceeded?'调整工具执行授权':event.title;
      el('service-approval-message').textContent=event.budgetExceeded?'当前累计积分额度不足。可提高上限后继续，或拒绝停止。':event.message+(sensitive&&!/不会代填/.test(event.message||'')?' 宿主不会代填密码或支付凭据。':'');
      el('service-approval-detail').textContent=event.detail;
      el('service-approval-mode').querySelector('[value="task"]').disabled=!event.canAuthorizeTask;
      el('service-approval-mode').querySelector('[value="auto"]').disabled=!event.canAuthorizeAuto;
      el('service-approval-mode').value=event.mode==='auto'&&event.canAuthorizeAuto?'auto':event.canAuthorizeTask?'task':event.canAuthorizeAuto?'auto':'once';
      el('service-approval-budget-label').hidden=!event.creditManaged;
      el('service-approval-budget').value=String(Math.max(event.creditCeiling??0,(event.reservedCredits??0)+(event.requiredCredits??0)));
      el('service-approval-budget-note').textContent=event.creditManaged?`本次报价上限 ${event.requiredCredits??0} 积分，已累计预留 ${event.reservedCredits??0} 积分。可一次设定完整任务的总额度；填 0 仅允许不消耗积分的操作。`:'此授权覆盖该服务的工具与终端指令；如服务另行收费，按服务自身规则计费。';
      approvalScope();if(!approval.open)approval.showModal();sync();return;
    }
    if(event.state==='approval-closed'){if(approvalRequest?.approvalId===event.approvalId){approvalRequest=undefined;approval.close();sync();}return;}
    if(event.state==='choose-service'){
      services=event.services.map(s=>({...s,kind:serviceKind(s)}));selectionId=event.selectionId;
      if(!picker.open)picker.showModal();
      activeKind=serviceKind(services[0]||selected);renderKindChrome();renderServiceList();
      el('extension-summary').textContent='请选择此次任务使用的服务，随后申请操作授权。';sync();return;
    }
    if(event.state==='service-list'){
      services=(event.services??[]).map(s=>({...s,kind:serviceKind(s)}));
      renderKindChrome();renderServiceList();sync();return;
    }
    if(event.state==='service-list'){
      services=(event.services??[]).map(s=>({...s,kind:serviceKind(s)}));
      renderKindChrome();renderServiceList();sync();return;
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
  renderKindChrome();
})();
