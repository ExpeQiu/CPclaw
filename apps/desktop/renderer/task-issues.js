(() => {
  const dialog=document.createElement('dialog');dialog.id='task-issue-dialog';dialog.className='service-approval task-issue-dialog';dialog.setAttribute('aria-labelledby','task-issue-title');
  const el=(tag,id,text)=>{const node=document.createElement(tag);if(id)node.id=id;if(text)node.textContent=text;return node;};
  const badge=el('p','task-issue-badge'),title=el('h2','task-issue-title'),summary=el('p','task-issue-summary'),impact=el('p','task-issue-impact'),preserved=el('p','task-issue-preserved');
  const quotaBox=el('section','task-issue-quota'),balance=el('p','task-issue-balance'),label=el('label',null,'申请新增模型额度（tokens）');
  const amount=el('input','quota-request-amount');amount.type='number';amount.min='1';amount.max='1000000';amount.step='1';amount.value='1000000';label.append(amount);
  const policy=el('p','quota-request-policy');quotaBox.append(balance,label,policy);
  const details=el('details','task-issue-details');details.append(el('summary',null,'查看技术详情'));const raw=el('pre','task-issue-raw');details.append(raw);
  const feedback=el('p','quota-request-feedback');feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
  const buttons=el('div');buttons.className='button-row';const close=el('button','task-issue-close','稍后处理'),primary=el('button','task-issue-primary');primary.className='primary';buttons.append(close,primary);
  dialog.append(badge,title,summary,impact,preserved,quotaBox,details,feedback,buttons);document.body.append(dialog);
  const seen=new Set();let context=null,pending=null,busy=false;
  const current=c=>c&&c.actor===chatAccount&&c.chatId===currentChatId;
  const pendingKey=c=>'cpclaw-quota-pending:'+c.actor+':'+c.chatId;
  function rememberPending(c,value){try{if(value)localStorage.setItem(pendingKey(c),JSON.stringify(value));else localStorage.removeItem(pendingKey(c));}catch{}}
  function readPending(c){try{const p=JSON.parse(localStorage.getItem(pendingKey(c)));return p?.actor===c.actor&&p.chatId===c.chatId&&Number.isSafeInteger(p.amount)&&p.amount>0&&p.amount<=1000000&&typeof p.requestId==='string'&&/^[\w-]{1,64}$/.test(p.requestId)?p:null;}catch{return null;}}
  const format=n=>Number(n).toLocaleString('zh-CN');
  const quotaReady=q=>q&&q.availableTokens>=Math.max(1,q.minimumRequestTokens||1);
  close.onclick=()=>dialog.close();
  dialog.addEventListener('cancel',event=>{if(busy){event.preventDefault();feedback.textContent='正在核实额度申请结果，请稍候。';}});
  async function loadQuota(){try{return await chatCall('account.quota');}catch{return {ok:false,message:'连接暂不可用，请检查网络后重试。'};}}
  function render(c){
    badge.textContent=c.issue.severity==='resolved'?'已恢复':c.issue.severity==='temporary'?'暂时受阻，可恢复':'需要处理';title.textContent=c.issue.title;summary.textContent=c.issue.summary;impact.textContent=c.issue.impact;preserved.textContent=c.issue.preserved||'';raw.textContent=c.issue.details||'';
    quotaBox.hidden=c.issue.action!=='quota';feedback.textContent='';amount.disabled=busy||Boolean(pending?.actor===c.actor&&pending?.chatId===c.chatId);close.disabled=busy;
    if(!quotaBox.hidden){
      const q=c.quota;balance.textContent=q?`可用 ${format(q.availableTokens)} tokens · 当前上限 ${format(q.limitTokens)} tokens${q.minimumRequestTokens?' · 下次请求至少预留 '+format(q.minimumRequestTokens):''}`:'暂时无法读取模型额度';
      if(c.phase==='request'&&q?.availableTokens>0&&!quotaReady(q))summary.textContent='当前可用额度不足以发起下一次模型请求，任务已暂停。';
      const supported=c.fresh&&q?.requestPolicy?.approvalMode==='auto';label.hidden=c.phase==='ready'||c.phase==='approved';
      policy.textContent=supported?'额度申请采用自动审批：提交后立即处理，每次可申请新增最多100万tokens。':!c.fresh?'最新额度暂未核实，请先恢复连接后重新检查。':'平台暂未提供可用的自动审批入口，请重新检查或更新平台服务。';
      if(c.phase==='ready'||c.phase==='approved'){
        title.textContent=c.phase==='approved'?'新额度已到账':'模型额度已恢复';summary.textContent=`当前可用 ${format(q.availableTokens)} tokens，可以继续处理原任务。`;impact.textContent=c.issue.safeToRetry?'此前仅有只读准备，可继续原请求。':'已有执行记录保留，将先检查原任务状态，避免重复生成。';
        primary.textContent=c.issue.safeToRetry?'继续原任务':'检查并恢复原任务';
      }else primary.textContent=supported?'申请新额度':'重新检查额度';
    }else primary.textContent=c.issue.actionLabel||'运行自诊断';
    primary.disabled=busy;
    if(c.loadError)feedback.textContent=c.loadError;
    if(c.accessIssue?.action==='login'){quotaBox.hidden=true;title.textContent='登录已失效，额度暂无法核实';summary.textContent='请重新登录平台，再核实当前额度与申请结果。';impact.textContent='原任务与待核实的申请编号已保留。';primary.textContent='重新登录';}
    if(c.phase==='ready'||c.phase==='approved'){badge.textContent=c.phase==='approved'?'已自动批准':'额度已可用';close.textContent='暂不继续';impact.textContent=c.issue.safeToRetry?(c.issue.hasServiceSteps?'此前仅有只读准备，可继续原请求。':'原请求已保留，点击后继续执行。'):'已有执行记录保留，将先检查原任务状态，避免重复生成。';}
    else close.textContent='稍后处理';
  }
  window.clearTaskIssues=()=>{context=null;dialog.close();};
  window.showTaskIssue=async(issue,options={})=>{
    if(!issue)return;
    const c={actor:chatAccount,chatId:currentChatId,messageId:options.messageId||'',issue:{...issue},quota:issue.modelQuota,fresh:false,phase:'request'};
    const key=[c.actor,c.chatId,c.messageId,issue.code].join(':');
    if(options.automatic&&seen.has(key))return;
    if(['MODEL_QUOTA_EXHAUSTED','MODEL_REQUEST_LIMITED'].includes(issue.code)){
      const result=await loadQuota();if(!current(c))return;
      if(result.ok){c.quota=result.quota;c.fresh=true;}else{c.loadError=result.message;c.accessIssue=result.issue;}
      if(result.ok&&!quotaReady(result.quota))c.issue={...c.issue,code:'MODEL_QUOTA_EXHAUSTED',popup:true,action:'quota',title:'模型额度不足，任务已暂停',summary:result.quota.availableTokens===0?'平台模型可用额度已用完，暂时无法继续思考和执行。':'当前可用额度不足以发起下一次模型请求，任务已暂停。',impact:'申请新额度后可继续当前任务。即梦积分与模型tokens额度分别计算。'};
      else if(result.ok&&issue.code==='MODEL_QUOTA_EXHAUSTED')c.phase='ready';
    }
    if(options.automatic&&!c.issue.popup)return;
    if(!current(c))return;
    seen.add(key);context=c;
    if(c.issue.action==='quota'){
      pending=readPending(c);
      if(c.phase==='ready'){rememberPending(c,null);pending=null;}
      if(pending)amount.value=String(pending.amount);
    }
    if(byId('diagnostics-dialog')?.open)byId('diagnostics-dialog').close();
    render(c);if(!dialog.open)dialog.showModal();primary.focus();
  };
  primary.onclick=async()=>{
    const c=context;if(busy||!current(c))return;
    if(c.accessIssue?.action==='login'){dialog.close();openPanel('settings');byId('employee-id').focus();return;}
    if(c.issue.action==='quota'&&['ready','approved'].includes(c.phase)){
      dialog.close();
      if(c.issue.safeToRetry)await sendChat(true);else byId('chat-diagnose').click();
      return;
    }
    if(c.issue.action==='quota'){
      if(!c.fresh||c.quota?.requestPolicy?.approvalMode!=='auto'){
        const result=await loadQuota();if(!current(c))return;
        if(!result.ok){c.accessIssue=result.issue;feedback.textContent=result.message;if(result.issue?.action==='login')primary.textContent='重新登录';return;}
        c.loadError='';c.accessIssue=null;c.quota=result.quota;c.fresh=true;if(quotaReady(c.quota))c.phase='ready';render(c);
        if(!c.quota.requestPolicy)feedback.textContent='平台尚未启用额度申请，请更新平台服务后使用。';
        return;
      }
      if(!amount.reportValidity())return;
      const requested=Number(amount.value);
      if(!Number.isSafeInteger(requested)||requested<1||requested>1000000){feedback.textContent='请填写1至1000000之间的整数。';return;}
      if(!pending||pending.actor!==c.actor||pending.chatId!==c.chatId||pending.amount!==requested)pending={actor:c.actor,chatId:c.chatId,amount:requested,requestId:crypto.randomUUID()};
      rememberPending(c,pending);
      busy=true;amount.disabled=true;primary.disabled=true;close.disabled=true;feedback.textContent='正在自动审批并核实到账结果…';
      try{
        const result=await chatCall('account.quotaRequest',{requestId:pending.requestId,additionalTokens:pending.amount});
        if(!current(c))return;
        if(!result.ok){
          feedback.textContent=result.message||'申请未完成，请重试核实结果。';
          c.accessIssue=result.issue;
          if(['SCHEMA_INVALID','CONFIG_INVALID','QUOTA_REQUEST_UNAVAILABLE','CONFLICT'].includes(result.code)){pending=null;rememberPending(c,null);}
          else primary.textContent='核实原申请结果';
          if(result.issue?.action==='login')primary.textContent='重新登录';
          return;
        }
        if(result.status!=='approved'||!result.quota)throw Error('暂未确认审批结果，请重试核实。');
        pending=null;rememberPending(c,null);c.quota={...result.quota,requestPolicy:{approvalMode:'auto',maxAdditionalTokens:1000000}};c.phase=quotaReady(result.quota)?'approved':'request';
        busy=false;render(c);feedback.textContent=quotaReady(result.quota)?`已自动批准新增 ${format(result.additionalTokens)} tokens。`:'申请已批准，但当前可用额度仍不足；请继续申请所需额度。';
      }catch{if(current(c)){feedback.textContent='申请结果暂未确认。点击同一按钮核实原申请，不会重复增加额度。';primary.textContent='核实原申请结果';}}
      finally{busy=false;if(current(c)){primary.disabled=false;close.disabled=false;amount.disabled=Boolean(pending);}}
      return;
    }
    dialog.close();
    if(c.issue.action==='login'){openPanel('settings');byId('employee-id').focus();}
    else if(c.issue.action==='retry'&&c.issue.safeToRetry)await sendChat(true);
    else byId('chat-diagnose').click();
  };
})();
