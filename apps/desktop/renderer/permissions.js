(() => {
  const picker=document.getElementById('conversation-permissions'),label=document.getElementById('permission-mode-label');
  const labels={ask:'请求批准',auto:'帮我批准',full:'完全访问权限'};
  let generation=0,busy=false;
  function render(mode='auto') {
    label.textContent=labels[mode]||labels.auto;picker.dataset.mode=mode;
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
  const locationList=document.getElementById('preferred-locations');
  async function renderLocations(){
    locationList.replaceChildren();
    if(!chatAccount){const empty=document.createElement('li');empty.textContent='登录后可添加';locationList.append(empty);return;}
    const result=await window.cpclaw.extensionAction({action:'preferred-locations'});
    locationList.replaceChildren();
    if(!result?.ok){const empty=document.createElement('li');empty.textContent=result?.message||'暂时无法读取';locationList.append(empty);return;}
    if(!result.locations.length){const empty=document.createElement('li');empty.className='muted';empty.textContent='尚未添加';locationList.append(empty);return;}
    for(const item of result.locations){
      const row=document.createElement('li');const name=document.createElement('span');name.textContent=item.name;name.title=item.path;
      const remove=document.createElement('button');remove.type='button';remove.textContent='移除';remove.onclick=async()=>{const next=await window.cpclaw.extensionAction({action:'preferred-location-remove',path:item.path});if(!next?.ok)setStatus(next?.message||'未能移除');await renderLocations();};
      row.append(name,remove);locationList.append(row);
    }
  }
  picker.addEventListener('toggle',()=>{if(picker.open){void window.refreshConversationPermission();void renderLocations();}});
  document.getElementById('preferred-location-add').onclick=async()=>{
    if(!chatAccount){setStatus('请先登录，再添加优先访问位置。');return;}
    const result=await window.cpclaw.extensionAction({action:'preferred-location-add'});
    if(!result?.ok)setStatus(result?.message||'未能添加');
    else if(!result.cancelled)setStatus('已记住这个文件夹，后续读取和写入不再逐次询问。');
    await renderLocations();
  };
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
