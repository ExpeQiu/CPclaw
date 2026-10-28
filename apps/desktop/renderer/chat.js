let chatExecution={mode:"chat",service:""};
let currentChatId = "";
let projects = [], currentProjectId = "", attachedProjectFile = null;
let chats = [], chatMessages = [];
let chatAccount = null;
let runningChatId = "";
let selectedChatGeneration = 0;
let nearBottom = true;
let kernelStatus = { name: "…", ready: false, source: "none", version: "" };
const chatDrafts = new Map();
const chatCall = (method, input = {}) => {
  if (!window.cpclaw?.workspace) {
    window.cpclaw?.log?.({ level: "error", event: "bridge_unavailable", message: "workspace bridge missing" });
    return Promise.reject(new Error("桌面桥接不可用，请重启应用。"));
  }
  return window.cpclaw.workspace({ method, input });
};
const byId = id => document.getElementById(id);

function renderKernelBadge(detail) {
  const el = byId("task-state");
  if (!el) return;
  const name = kernelStatus.name || "未配置";
  el.textContent = `当前：${name}`;
  el.classList.toggle("kernel-ok", Boolean(kernelStatus.ready));
  el.classList.toggle("kernel-fail", !kernelStatus.ready);
  const sourceLabel = kernelStatus.source === "bundle" ? "包内内核" : kernelStatus.source === "checkout" ? "本机检出" : "未启用 harness";
  el.title = [
    kernelStatus.ready ? "内核可用" : "内核不可用",
    name,
    kernelStatus.version ? `版本 ${kernelStatus.version}` : "",
    sourceLabel,
    detail || "",
  ].filter(Boolean).join(" · ");
}

async function refreshKernelStatus() {
  try {
    const status = await window.cpclaw.runtimeStatus();
    if (status?.ok) kernelStatus = status;
  } catch {
    kernelStatus = { name: "未配置", ready: false, source: "none", version: "" };
  }
  renderKernelBadge(runningChatId === currentChatId && runningChatId ? "正在回复" : "");
}
window.refreshKernelStatus = refreshKernelStatus;
window.renderKernelBadge = renderKernelBadge;
const conversation = byId("conversation");
conversation.addEventListener("scroll", () => { nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100; });

function renderComposer() {
  const chat = desktopView === "chat";
  window.renderSkillBinding?.();
  byId("conversation-permissions").hidden=!chat;
  byId("chat-diagnose").disabled = !chat || !chatAccount || !currentChatId || Boolean(runningChatId) || Boolean(byId("chat-diagnose").dataset.busy);
  byId('mode-service').hidden=!chat;byId('mode-service').disabled=Boolean(runningChatId);
  byId('mode-service').textContent=window.executionServiceName?.(chatExecution.service)||'应用服务';
  byId("knowledge-sources").hidden = !chat;
  const modelPicker=byId('composer-model'),modelLabel=byId('composer-model-label');
  if(modelPicker){modelPicker.hidden=!chat;modelPicker.style.pointerEvents=runningChatId?'none':'';if(modelLabel)modelLabel.style.opacity=runningChatId?'.5':'';}
  byId('current-project-label').textContent=projects.find(p=>p.id===currentProjectId)?.name??'工作台';
  byId('current-project-label').title=projects.find(p=>p.id===currentProjectId)?.folder??'';
  byId('project-material-context').hidden=!attachedProjectFile;
  byId('project-material-name').textContent=attachedProjectFile?.name??'';
  byId("chat-send").hidden = !chat || Boolean(runningChatId);
  byId("chat-send").disabled = !chatAccount;
  byId("chat-stop").hidden = !chat || !runningChatId;
  byId("enqueue").hidden = chat;
  const hint = chat ? "Enter 发送 · Shift + Enter 换行" : "补充内容会加入当前任务队列";
  byId("note").placeholder = chat ? (editingArtifact ? "描述文档需要怎样修改…" : "向 CPclaw 提问…") : "补充任务要求、背景或期望的结果…";
  byId("note").title = hint;
  byId("composer-hint").textContent = hint;
}
function growComposerNote() {
  const note = byId("note");
  note.style.height = "auto";
  note.style.height = `${Math.min(180, Math.max(56, note.scrollHeight))}px`;
}
byId("note").addEventListener("input", growComposerNote);
function renderChatList() {
  if(typeof renderProjectChats==='function')renderProjectChats();
}

function elapsedLabel(message,now=Date.now()){
  if(!Number.isFinite(message.startedAt))return '';
  const running=message.state==='streaming';
  if(!running&&!Number.isFinite(message.finishedAt))return message.state==='interrupted'?'已中断':'';
  const seconds=Math.max(0,Math.floor(((running?now:message.finishedAt)-message.startedAt)/1000));
  const duration=seconds<60?`${seconds} 秒`:`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
  return `${running?'处理中':message.state==='cancelled'?'已停止':message.state==='error'?'已结束':'耗时'} · ${duration}`;
}
function refreshElapsedLabels(){
  for(const node of document.querySelectorAll('.chat-elapsed')){const message=chatMessages.find(m=>m.role==='assistant'&&m.request===node.dataset.request);if(message){const label=elapsedLabel(message);if(node.textContent!==label)node.textContent=label;node.hidden=!label;}}
}
setInterval(refreshElapsedLabels,1000);
/** 折叠历史恢复文本中的逐步清单，与 chat-diagnostics.compactServiceChatText 同口径。 */
function compactServiceChatText(content=''){
  const text=String(content||'');
  if(!text.trim())return '';
  const match=text.match(/本轮回复未完成，已恢复 (\d+) 条应用执行记录（(\d+) 条明确返回失败）/);
  if(match&&/^- 步骤 \d+ ·/m.test(text)){
    return `本轮回复未完成，已恢复 ${match[1]} 条应用执行记录（${match[2]} 条明确返回失败）。\n\n过程与回执见右侧「自动工作流」。继续对话时先查询已有任务状态，避免重复提交。`;
  }
  return text.replace(/\n*- 步骤 \d+ ·[^\n]*/g,'').replace(/\n{3,}/g,'\n\n').trim();
}
function chatDisplayText(message){
  if(message.hasServiceSteps){
    const compact=compactServiceChatText(message.content);
    if(!compact&&message.state==='streaming')return '正在右侧「自动工作流」执行…';
    return compact;
  }
  const artifact=chatArtifacts.find(a=>a.message===message.id);
  if(artifact&&message.content.length>400)return `已完成《${artifact.name}》。完整内容见右侧文档预览。`;
  return message.content;
}
/** 与 apps/desktop/message-actions.mjs 同阈值：多轮且结果较充实才提供提炼 Skill。 */
function canOfferSkillDistill(messages,message){
  if(!message||message.role!=='assistant'||message.state!=='done')return false;
  if(messages.filter(m=>m.role==='user').length<2)return false;
  const text=String(message.content||'').trim();
  if(message.skillResult?.status==='passed')return true;
  if(message.hasServiceSteps)return text.length>0;
  return text.length>=800;
}
function messageIconButton(label,symbol,callback){
  const button=documentButton(symbol,callback);
  button.className='message-icon';
  button.title=label;
  button.setAttribute('aria-label',label);
  return button;
}
function updateProgress(container,message){
  // 应用执行过程只在右侧栏展示，左侧不重复列过程步骤。
  if(message.hasServiceSteps){container.replaceChildren();container.hidden=true;return;}
  container.hidden=!message.activities?.length;
  for(const step of message.activities??[]){let row=[...container.children].find(r=>r.dataset.step===step.step);if(!row){row=document.createElement('li');row.dataset.step=step.step;container.append(row);}row.dataset.state=step.state;row.textContent=step.label;}
}
function updateLiveMessage(message){
  if(!message)return false;
  const article=[...byId('chat-messages').children].find(node=>node.classList.contains('assistant')&&node.dataset.request===message.request);if(!article)return false;
  const body=article.querySelector('.message-body');const value=chatDisplayText(message)||(message.state==='streaming'?'正在处理…':'没有收到回复正文');
  renderChatMarkdown(body,value,message.state==='streaming');
  body.hidden=!chatDisplayText(message)&&message.state==='streaming'&&!message.hasServiceSteps&&Boolean(message.activities?.length);
  updateProgress(article.querySelector('.chat-progress'),message);refreshElapsedLabels();
  if(nearBottom)requestAnimationFrame(()=>{conversation.scrollTop=conversation.scrollHeight;});
  return true;
}
function renderChat() {
  renderChatList(); renderTasks(); renderComposer();
  if (desktopView !== "chat") return;
  byId("review-toggle").hidden = !(board?.changes ?? []).some(change => change.status === "pending");
  byId("task-detail").hidden = true;
  byId("welcome").hidden = chatMessages.length > 0;
  byId("chat-view").hidden = !chatMessages.length;
  byId("task-title").textContent = chats.find(item => item.id === currentChatId)?.title ?? "新聊天";
  renderKernelBadge(runningChatId === currentChatId && runningChatId ? "正在回复" : "");
  const list = byId("chat-messages"); list.replaceChildren();
  for (const message of chatMessages) {
    const article = document.createElement("article"); article.className = `chat-message ${message.role}`;article.dataset.request=message.request;
    const label = document.createElement("div"); label.className = "message-label"; label.textContent = message.role === "user" ? "你" : "CPclaw";
    const body = document.createElement("div"); body.className = "message-body";
    const visibleText=chatDisplayText(message)||(message.state==='streaming'?'正在连接模型…':'没有收到回复正文');
    if(message.role==='assistant')renderChatMarkdown(body,visibleText,message.state==='streaming');
    else body.textContent=visibleText;
    if(message.role==='assistant'){const elapsed=document.createElement('span');elapsed.className='chat-elapsed';elapsed.dataset.request=message.request;elapsed.textContent=elapsedLabel(message);elapsed.hidden=!elapsed.textContent;label.append(elapsed);}
    article.append(label);
    if(message.role==='assistant'){const activity=document.createElement('ol');activity.className='chat-progress';updateProgress(activity,message);article.append(activity);}
    body.hidden=!chatDisplayText(message)&&message.state==='streaming'&&!message.hasServiceSteps&&Boolean(message.activities?.length);
    article.append(body);
    if (message.role === "assistant") {
      const meta = document.createElement("div"); meta.className = "message-meta";
      meta.textContent = message.state === "streaming" ? "● 正在生成" : message.state === "done" ? "回复完成" : message.error || "回复未完成";
      article.append(meta);
      if(message.skillResult){const result=message.skillResult;const badge=document.createElement('p');badge.className='skill-result-check';badge.style.cssText='font-size:12px;color:#537363';badge.textContent=(result.mode==='mock'?'Mock · ':'')+({passed:'技能输出结构检查通过',failed:'技能输出检查未通过',unverified:'技能回复完成，未配置自动检查规则'}[result.status])+(result.missing?.length?'：'+result.missing.join('、'):'');article.append(badge);}

      if(message.sources?.length){const sources=document.createElement('details');sources.className='project-citations';const summary=document.createElement('summary');summary.textContent=`参考项目资料 · ${message.sources.length} 个文件`;sources.append(summary);for(const source of message.sources){const row=document.createElement('div');row.textContent=`${source.path} · L${source.lineStart}–${source.lineEnd}`;sources.append(row);}article.append(sources);}
      else if(message.retrievalStatus){const notice=document.createElement('small');notice.className='retrieval-notice';notice.textContent={unavailable:'项目资料暂不可用，本次未引用本地资料',limited:'已在检索范围内查找，未找到相关文本片段','no-match':'项目检索未找到相关文本片段'}[message.retrievalStatus]??'';if(notice.textContent)article.append(notice);}

      if(message.knowledgeSources?.length && typeof renderKnowledgeCitations === "function")article.append(renderKnowledgeCitations(message.knowledgeSources));
      for (const artifact of chatArtifacts.filter(a=>a.message===message.id)) article.append(renderDocumentCard(artifact));
      if(message.artifactError){const warning=document.createElement("p");warning.textContent=`文档未保存：${message.artifactError}`;article.append(warning);}
      if (message.content) {
        const actions=document.createElement('div');actions.className='message-actions';
        if(message.state==='done'&&canOfferSkillDistill(chatMessages,message)){
          const distill=messageIconButton('提炼成Skill','✦',async()=>{
            const actor=chatAccount,chatId=currentChatId;setStatus('正在提炼 Skill 草稿…');
            const result=await chatCall('chat.distill-skill',{chatId,messageId:message.id});
            if(actor!==chatAccount||chatId!==currentChatId)return;
            if(!result.ok)throw Error(result.message);
            await window.openSkillDraft(result.skillId);
            setStatus(result.mode==='mock'?'已生成 Mock Skill 草稿，请编辑后保存':'Skill 草稿已保存，审阅后可个人使用或提交审核。');
          });
          distill.classList.add('distill-skill');
          distill.disabled=Boolean(runningChatId);
          actions.append(distill);
        }
        if(message.state==='done'&&!chatArtifacts.some(a=>a.message===message.id)){
          const save=documentButton(message.hasServiceSteps?'保存创作过程.md':'保存为 .md',async()=>{
            const actor=chatAccount,chatId=currentChatId;
            const result=await chatCall('document.create',{chatId,messageId:message.id,...(message.hasServiceSteps?{kind:'process'}:{})});
            if(actor!==chatAccount||chatId!==currentChatId)return;
            if(!result.ok)throw Error(result.message);
            addArtifact(result.artifact);renderChat();await showDocument(result.artifact.id);
          });
          save.className='message-action';actions.append(save);
        }
        const copy=document.createElement('button');copy.type='button';copy.className='message-action';copy.textContent='复制';
        copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(chatDisplayText(message));copy.textContent='已复制';}catch{setStatus('复制失败，请手动选择文本。');}});
        actions.append(copy);
        if(message.state==='done'){
          const like=messageIconButton(message.liked?'取消点赞':'点赞有用','👍',async()=>{
            const actor=chatAccount,chatId=currentChatId,next=!message.liked;
            const result=await chatCall('chat.feedback',{chatId,messageId:message.id,liked:next});
            if(actor!==chatAccount||chatId!==currentChatId)return;
            if(!result.ok)throw Error(result.message||'评价失败');
            message.liked=result.liked;
            like.classList.toggle('is-liked',result.liked);
            like.title=result.liked?'取消点赞':'点赞有用';
            like.setAttribute('aria-label',like.title);
            setStatus(result.liked?'已记录点赞，感谢反馈':'已取消点赞');
          });
          like.classList.toggle('is-liked',Boolean(message.liked));
          actions.append(like);
        }
        article.append(actions);
      }
    }
    list.append(article);
  }
  const last = chatMessages.at(-1);
  byId("chat-retry").hidden = Boolean(last?.hasServiceSteps) || Boolean(runningChatId) || !last || !["error", "cancelled", "interrupted"].includes(last.state);
  if (nearBottom) requestAnimationFrame(() => { conversation.scrollTop = conversation.scrollHeight; });
}
async function loadChats() {
  if (!chatAccount) { chats = []; projects=[];currentProjectId=""; renderChatList(); return; }
  const result = await chatCall("chat.list");
  if (!result.ok) throw new Error(result.message);
  chats = result.chats; projects=result.projects??[]; renderChat();
}
async function selectChat(id) {
  window.updateSkillBinding?.(null);
  window.clearChatDiagnostics?.();
  window.clearConversationPermission?.();
  if (id !== currentChatId) void window.cpclaw.extensionAction?.({ action: 'clear-context' }).catch(() => {});
  if (desktopView === "chat") chatDrafts.set(currentChatId, byId("note").value);
  clearDocumentView();
  attachedProjectFile=null;
  if(id)currentProjectId=chats.find(chat=>chat.id===id)?.projectId??"";
  chatExecution={mode:"chat",service:""};window.restoreServicePanel?.([],chatExecution);
  desktopView = "chat"; currentChatId = id; chatMessages = []; nearBottom = true;
  byId("note").value = chatDrafts.get(id) ?? "";
  const generation = ++selectedChatGeneration;
  renderChat();
  if(documentStructureTab==='folders')void renderProjectFolder();
  if (!id) return;
  const result = await chatCall("chat.history", { chatId: id });
  if (generation !== selectedChatGeneration || desktopView !== "chat") return;
  if (!result.ok) { setStatus(result.message); return; }
  const newer = new Map(chatMessages.map(message => [message.request + message.role, message]));
  chatMessages = result.messages.map(message => {
    const recent = newer.get(message.request + message.role);
    return recent && (recent.content.length > message.content.length || recent.state !== "streaming") ? recent : message;
  });
  chatExecution=result.execution??{mode:"chat",service:""};
  window.updateSkillBinding?.(result.skillBinding??null);
  for(const record of result.skillResults??[]){const m=chatMessages.find(m=>m.id===record.message);if(m)m.skillResult=record.result;}
  window.restoreServicePanel?.(result.serviceSteps??[],chatExecution);
  chatArtifacts = result.artifacts ?? [];renderDocumentList();
  if (result.active) runningChatId = id;
  void window.refreshConversationPermission?.();
  renderChat();
}
async function sendChat(retry = false) {
  if (runningChatId) { setStatus("请等待当前回复，或先停止生成。"); return; }
  if (!chatAccount) { openPanel("settings"); setStatus("请先设置平台地址并登录。"); return; }
  const text = byId("note").value.trim();
  if (!retry && !text) return;
  if (text.length > 8000) { setStatus("单条消息最多 8000 个字符。"); return; }
  if (!currentChatId) {
    const created = await chatCall("chat.create",{projectId:currentProjectId}); if (!created.ok) throw new Error(created.message);
    currentChatId = created.chatId;
  }
  const configured=await chatCall('chat.configure',{chatId:currentChatId,...chatExecution});
  if(!configured.ok){setStatus(configured.message);return;}
  const id = currentChatId, requestId = crypto.randomUUID();
  runningChatId = id; nearBottom = true;
  if (retry) chatMessages.pop();
  else { chatMessages.push({ id: requestId + "-user", role: "user", content: text, state: "done", request: requestId }); byId("note").value = ""; chatDrafts.delete(id); }
  chatMessages.push({ id: requestId, role: "assistant", content: "", state: "streaming", startedAt:Date.now(),request: requestId });
  renderChat(); setStatus("正在连接平台…");
  try {
    const result = await chatCall("chat.send", { chatId: id, requestId, ...(retry ? { retry: true } : { text, ...(attachedProjectFile?{projectFile:attachedProjectFile.path}:{}), ...(editingArtifact ? {documentId:editingArtifact.id,expectedHash:editingArtifact.expectedHash}: {}) }) });
    if(result.ok)attachedProjectFile=null;
    if (result.ok && result.artifact && currentChatId === id) {addArtifact(result.artifact);}
    if (!result.ok) {
      setStatus(result.message);
      if (currentChatId === id) await selectChat(id);
      if (!retry) byId("note").value = text;
    }
  } catch (error) {
    setStatus(error.message || "连接中断，请刷新查看保存的消息。");
    if (currentChatId === id) {
      const message = chatMessages.find(item => item.request === requestId && item.role === "assistant");
      if (message) { message.state = "error"; message.error = "连接中断，可重试"; }
    }
  } finally {
    runningChatId = ""; renderChat(); await loadChats().catch(error => setStatus(error.message));
  }
}
window.cpclaw.onChatEvent(event => {
  if (event.actorId !== chatAccount || event.channel==='market') return;
  if (event.type === "start") runningChatId = event.chatId;
  if (event.type === "finish") runningChatId = "";
  if (currentChatId !== event.chatId) { renderChatList(); renderComposer(); return; }
  let message = chatMessages.find(item => item.role === "assistant" && item.request === event.requestId);
  if (!message && event.type !== "start") { message = { id: event.messageId, role: "assistant", content: "", state: "streaming", request: event.requestId }; chatMessages.push(message); }
  if (message) {
    message.id = event.messageId;
    if(event.startedAt)message.startedAt=event.startedAt;
    if(event.finishedAt)message.finishedAt=event.finishedAt;
    if(event.type==='progress'){message.activities??=[];const step=message.activities.find(s=>s.step===event.step);if(step)Object.assign(step,{label:event.label,state:event.stepState});else message.activities.push({step:event.step,label:event.label,state:event.stepState});}
    if(event.type==='service'&&event.record)message.hasServiceSteps=true;
    if(event.type==='knowledge'){message.knowledgeSources=event.sources;}
    if(event.type==='retrieval'){message.sources=event.sources;message.retrievalStatus=event.retrievalStatus;}
    if (event.type === "delta") message.content = event.content;
    if (event.type === "finish") { message.content = event.content; message.state = event.state; message.error = event.error; message.artifactError = event.artifactError; message.skillResult=event.skillValidation; }
  }
  if(event.type==='service')window.showServiceEvent?.(event);
  if (event.type === "activity") setStatus(event.message);
  if (event.type === "mode") setStatus(event.mode === "mock" ? "Mock 演示模式 · 未调用真实模型" : "MiniMax-M3 · 正在生成回复");
  if (event.type === "finish") setStatus(event.state === "done" ? (event.mode === "mock" ? "Mock 演示回复完成" : "回复完成") : event.error);
  if(event.type==='finish'&&event.artifact){
    addArtifact(event.artifact);editingArtifact=null;byId('document-edit-context').hidden=true;
    showDocument(event.artifact.id).catch(e=>setStatus(e.message));
  }
  if(event.type==='finish'&&event.artifactError)setStatus(`回复完成，但文档未保存：${event.artifactError}`);
  if(['delta','progress','activity','mode'].includes(event.type)&&updateLiveMessage(message))return;
  renderChat();
});
async function loadAccount() {
  window.clearChatDiagnostics?.();
  window.clearConversationPermission?.();
  const result = await chatCall("account.status");
  if (!result.ok) throw new Error(result.message);
  if(chatAccount!==result.employeeId)window.clearMarket?.();
  chatAccount = result.employeeId;
  if(typeof clearKnowledge === "function")clearKnowledge();
  if(typeof refreshQuickRail==="function")refreshQuickRail();
  byId("platform-url").value = result.platformUrl;
  byId("employee-id").value = chatAccount ?? "";
  byId("account-summary").textContent = chatAccount ? `当前员工：${chatAccount}` : "尚未登录，填写平台地址和账号开始。";
  byId("account-logout").disabled = !chatAccount;
  renderComposer(); await loadChats();
}
onAction("chat-send", () => sendChat());
onAction("chat-retry", () => sendChat(true));
onAction("chat-stop", async () => {
  const result = await chatCall("chat.cancel", { chatId: runningChatId });
  if (!result.ok) setStatus(result.message);
});
onAction("rail-chat", async () => { await selectChat(""); byId("note").focus(); setStatus(chatAccount ? "输入问题开始新的聊天。" : "请先在设置中连接平台并登录。"); });
onAction("account-login", async () => {
  byId("account-feedback").textContent = "正在登录…";
  try {
    const result = await chatCall("account.login", { platformUrl: byId("platform-url").value.trim(), employeeId: byId("employee-id").value, password: byId("account-password").value });
    if (!result.ok) throw new Error(result.message);
    clearDocumentView();chatExecution={mode:"chat",service:""};window.restoreServicePanel?.([],chatExecution);
    chats = []; projects=[];currentProjectId="";attachedProjectFile=null; chatMessages = []; currentChatId = ""; chatDrafts.clear(); byId("note").value = "";
    await loadAccount(); desktopView = "chat"; renderChat(); await refresh();
    byId("account-feedback").textContent = "登录成功"; setStatus("已连接平台，可以开始聊天。");
  } catch (error) { byId("account-feedback").textContent = error.message; }
  finally { byId("account-password").value = ""; }
});
onAction("account-logout", async () => {
  const result = await chatCall("account.logout");
  if (!result.ok) { setStatus(result.message); return; }
  clearDocumentView();chatExecution={mode:"chat",service:""};window.restoreServicePanel?.([],chatExecution);
  chatAccount = null; currentProjectId="";projects=[];attachedProjectFile=null;currentChatId = ""; chats = []; chatMessages = []; chatDrafts.clear(); board = null; desktopView = "chat";
  byId("note").value = ""; byId("change-count").textContent = "0"; byId("changes").textContent = "登录后查看变更";
  await loadAccount(); renderChat(); setStatus(result.remoteRevoked ? "已退出登录" : "已退出本机；平台会话未确认撤销，可由管理员撤销。");
});
byId("refresh").addEventListener("click", () => loadChats().catch(error => setStatus(error.message)));
byId("task-search").addEventListener("input", renderChatList);
byId("note").addEventListener("keydown", event => {
  if (desktopView === "chat" && event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.isComposing) { event.preventDefault(); byId("chat-send").click(); }
});
void refreshKernelStatus();
loadAccount().then(async () => { if (chats.length) await selectChat(chats[0].id); else renderChat(); }).catch(error => { setStatus(error.message); renderChat(); });

window.chooseExecutionService=async service=>{
  if(runningChatId){setStatus('请先停止当前执行，再更换应用服务。');return false;}
  if(currentChatId){const r=await chatCall('chat.configure',{chatId:currentChatId,mode:'chat',service:service.id});if(!r.ok){setStatus(r.message);return false;}}
  chatExecution={mode:'chat',service:service.id};renderComposer();window.showServiceWorkspace?.(service);return true;
};
byId('mode-service').onclick=()=>window.openExtensionPicker?.();
