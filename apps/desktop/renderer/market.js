const marketOverlay=document.createElement('section');marketOverlay.hidden=true;marketOverlay.className='market-overlay';marketOverlay.setAttribute('aria-label','技能市场');
marketOverlay.style.cssText='position:fixed;inset:12px 12px 12px 56px;z-index:30;background:#f6f8f7;border:1px solid #dfe7e2;border-radius:16px;box-shadow:0 12px 50px #17233a24;display:flex;flex-direction:column;overflow:hidden';
const marketClose=document.createElement('button');marketClose.textContent='关闭技能市场 ×';marketClose.style.cssText='align-self:flex-end;margin:8px 18px;border:0;background:none;color:#4d6a5d;padding:8px;cursor:pointer';
let marketReturnFocus,marketActor=null,marketLoaded=false,marketBinding=null;
marketClose.onclick=()=>{marketOverlay.hidden=true;marketReturnFocus?.focus();};
const marketFrame=document.createElement('iframe');marketFrame.title='技能市场';marketFrame.style.cssText='border:0;flex:1;width:100%';marketOverlay.append(marketClose,marketFrame);document.body.append(marketOverlay);
function marketContext(){marketFrame.contentWindow?.postMessage({type:'market-context',chatId:chats.some(c=>c.id===currentChatId)?currentChatId:'',projectId:projects.some(p=>p.id===currentProjectId)?currentProjectId:''},'*');}
window.openSkillDraft=async skillId=>{
  window.closeKnowledgeOverlay?.();
  marketReturnFocus=document.activeElement;
  if(!marketLoaded||marketActor!==chatAccount){const r=await window.cpclaw.workspace({method:'market.page',input:{}});if(!r.ok)throw Error(r.message);marketActor=chatAccount;marketLoaded=true;await new Promise(resolve=>{marketFrame.addEventListener('load',resolve,{once:true});marketFrame.srcdoc=r.html;});}
  marketOverlay.hidden=false;marketContext();
  if(skillId)marketFrame.contentWindow.postMessage({type:'cpclaw-open-skill',skillId},'*');
};
document.getElementById('rail-market').onclick=()=>window.openSkillDraft().catch(e=>setStatus(e.message));
window.addEventListener('message',async e=>{if(e.source!==marketFrame.contentWindow)return;
  if(e.data?.type==='market-pick-material'){
    const actor=chatAccount,projectId=currentProjectId;
    if(!projectId){marketFrame.contentWindow.postMessage({type:'market-material',error:'请先在工作台选择项目，再打开技能准备材料。'},'*');return;}
    try{const result=await window.cpclaw.projectAction({action:'file',id:projectId});if(actor!==chatAccount||projectId!==currentProjectId)return;if(!result.ok)throw Error(result.message);if(!result.cancelled)marketFrame.contentWindow.postMessage({type:'market-material',file:result.file,projectId},'*');}catch(error){marketFrame.contentWindow.postMessage({type:'market-material',error:error.message},'*');}
  }
  if(e.data?.type==='market-use'){marketOverlay.hidden=true;await loadChats();await selectChat(e.data.chatId);if(e.data.material){attachedProjectFile=e.data.material;renderComposer();}if(e.data.prompt&&!document.getElementById('note').value.trim())document.getElementById('note').value=e.data.prompt;document.getElementById('note').focus();}
  if(e.data?.type==='market-escape')marketClose.click();
});
window.cpclaw.onChatEvent(event=>{if(event.channel==='market'&&event.actorId===chatAccount)marketFrame.contentWindow?.postMessage({type:'market-installation',message:event.message,state:event.state,releaseId:event.releaseId},'*');});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!marketOverlay.hidden)marketClose.click();});
const selectSkillButton=document.createElement('button');selectSkillButton.type='button';selectSkillButton.id='select-chat-skill';selectSkillButton.className='composer-chip';selectSkillButton.textContent='技能';selectSkillButton.title='选择当前对话使用的工作方法';selectSkillButton.onclick=()=>window.openSkillDraft().catch(e=>setStatus(e.message));document.getElementById('mode-service').before(selectSkillButton);
const skillChip=document.createElement('div');skillChip.id='chat-skill-context';skillChip.hidden=true;skillChip.style.cssText='display:flex;align-items:center;gap:10px;padding:8px 12px;background:#edf5f0;border-radius:8px;margin:6px 0;font-size:12px;color:#346450';const chipLabel=document.createElement('span'),chipRemove=document.createElement('button');chipRemove.textContent='解除技能';chipRemove.style.cssText='margin-left:auto;font-size:12px';skillChip.append(chipLabel,chipRemove);document.getElementById('note').after(skillChip);
chipRemove.onclick=async()=>{try{const r=await window.cpclaw.workspace({method:'market.unbind',input:{chatId:currentChatId}});if(!r.ok)throw Error(r.message);window.updateSkillBinding(null);setStatus('已解除技能，历史记录和成果保留。');}catch(e){setStatus(e.message);}};
window.updateSkillBinding=value=>{marketBinding=value;window.renderSkillBinding();};
window.renderSkillBinding=()=>{const show=desktopView==='chat';selectSkillButton.hidden=!show;selectSkillButton.disabled=Boolean(runningChatId);skillChip.hidden=!show||!marketBinding;chipLabel.textContent=marketBinding?marketBinding.title+' · '+marketBinding.version+(marketBinding.trial?' · 草稿试用':''):'';chipRemove.disabled=Boolean(runningChatId);};

window.clearMarket=()=>{marketLoaded=false;marketActor=null;marketFrame.srcdoc='';marketOverlay.hidden=true;window.updateSkillBinding(null);};
