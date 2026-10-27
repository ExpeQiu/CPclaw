(() => {
  const picker=document.getElementById('conversation-permissions'),label=document.getElementById('permission-mode-label');
  const labels={ask:'请求批准',auto:'帮我批准',full:'完全访问权限'};
  let generation=0,busy=false;
  function render(mode='ask') {
    label.textContent=labels[mode]||labels.ask;picker.dataset.mode=mode;
    label.title='对话权限：'+label.textContent+' · 仅当前对话，本次应用会话内有效';
    for(const button of picker.querySelectorAll('[data-permission-mode]'))button.setAttribute('aria-checked',String(button.dataset.permissionMode===mode));
  }
  window.clearConversationPermission=()=>{generation++;picker.open=false;render();};
  window.refreshConversationPermission=async()=>{
    const token=++generation,actor=chatAccount,id=currentChatId;
    if(!actor||!id){render();return;}
    const r=await window.cpclaw.extensionAction({action:'permission-status'});
    if(token===generation&&actor===chatAccount&&id===currentChatId&&r.chatId===id)render(r.mode);
  };
  picker.addEventListener('toggle',()=>{if(picker.open)void window.refreshConversationPermission();});
  document.addEventListener('pointerdown',event=>{if(!picker.contains(event.target))picker.open=false;});
  picker.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();picker.open=false;label.focus();}});
  for(const button of picker.querySelectorAll('[data-permission-mode]'))button.onclick=async()=>{
    if(busy)return;
    if(!chatAccount){picker.open=false;setStatus('请先登录，再选择对话权限。');return;}
    busy=true;const actor=chatAccount;
    try {
      if(!currentChatId){const created=await chatCall('chat.create',{projectId:currentProjectId});if(!created.ok)throw Error(created.message);if(actor!==chatAccount)return;currentChatId=created.chatId;await loadChats();}
      const id=currentChatId,r=await window.cpclaw.extensionAction({action:'set-permission-mode',chatId:id,mode:button.dataset.permissionMode});
      if(actor!==chatAccount||id!==currentChatId)return;
      if(!r.ok)throw Error(r.message);
      render(r.mode);picker.open=false;setStatus(`此对话已设为「${labels[r.mode]}」。`);
    }catch(error){setStatus(error.message||'权限模式未更改。');}
    finally{busy=false;}
  };
  window.cpclaw.onExtensionEvent(event=>{if(event.state==='permission'&&event.actorId===chatAccount&&event.chatId===currentChatId)render(event.mode);});
  render();
})();
