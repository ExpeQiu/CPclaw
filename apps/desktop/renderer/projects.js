const projectOpen = new Map();
let movingChatId = '';
let deletingChatId = '';
const chatMenu = document.createElement('div');
chatMenu.className = 'chat-more-menu';
chatMenu.hidden = true;
chatMenu.setAttribute('role', 'menu');
document.body.append(chatMenu);
function closeChatMenu(){chatMenu.hidden = true; chatMenu.replaceChildren(); delete chatMenu.dataset.chat;}
function projectError(error){setStatus(error.message||'项目操作失败');}
function openMoveChat(chat){
  movingChatId=chat.id;const select=byId('move-chat-project');select.replaceChildren();
  for(const p of [{id:'',name:'未归类'},...projects]){const option=document.createElement('option');option.value=p.id;option.textContent=p.name;select.append(option);}
  select.value=chat.projectId??'';byId('move-chat-feedback').textContent='';byId('move-chat-dialog').showModal();
}
function openChatMenu(anchor, chat){
  closeChatMenu();
  chatMenu.dataset.chat = chat.id;
  const add = (label, action, danger=false) => {
    const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('role','menuitem');
    if(danger)button.className='danger';
    button.onclick=async()=>{closeChatMenu();try{await action();}catch(error){projectError(error);}};
    chatMenu.append(button);
  };
  add('移动到项目', () => openMoveChat(chat));
  add(chat.archived ? '恢复' : '归档', () => archiveChat(chat));
  add('删除', () => openDeleteChat(chat), true);
  const rect=anchor.getBoundingClientRect();
  chatMenu.style.visibility='hidden';
  chatMenu.hidden=false;
  const height=chatMenu.offsetHeight, width=chatMenu.offsetWidth;
  chatMenu.style.top=`${Math.min(rect.bottom+4, window.innerHeight-height-8)}px`;
  chatMenu.style.left=`${Math.max(8, Math.min(rect.right-width, window.innerWidth-width-8))}px`;
  chatMenu.style.visibility='';
}
async function archiveChat(chat){
  if(chat.id===runningChatId){setStatus('请等待回复完成再归档');return;}
  const actor=chatAccount, archived=!chat.archived;
  const result=await chatCall('chat.archive',{chatId:chat.id, archived});
  if(actor!==chatAccount)return;
  if(!result.ok)throw Error(result.message);
  await loadChats();
  setStatus(result.archived?'对话已归档。生成的文档和图片仍保留，可在「已归档」中打开。':'对话已恢复。');
}
function openDeleteChat(chat){
  if(chat.id===runningChatId){setStatus('请等待回复完成再删除');return;}
  deletingChatId=chat.id;
  byId('delete-chat-copy').textContent=`删除「${chat.title}」后，这条对话记录会被移除，其中生成的文档和图片也会删除。`;
  byId('delete-chat-feedback').textContent='';
  byId('delete-chat-dialog').showModal();
}
async function newProjectChat(id){currentProjectId=id;await selectChat('');document.getElementById('close-panel').click();byId('note').focus();}
function projectChatRow(chat) {
  const row=document.createElement('div');row.className='project-chat-row';
  const button=document.createElement('button');button.className=`task-row${desktopView==='chat'&&chat.id===currentChatId?' active':''}`;
  button.setAttribute('aria-current',String(desktopView==='chat'&&chat.id===currentChatId));
  const title=document.createElement('strong');title.textContent=chat.title;
  const meta=document.createElement('small');meta.textContent=chat.id===runningChatId?'正在回复…':chat.archived?'已归档 · 文档仍保留':'本地保存';
  button.append(title,meta);button.onclick=()=>{closeChatMenu();selectChat(chat.id).catch(projectError);};
  const more=document.createElement('button');more.type='button';more.className='chat-more';more.textContent='•••';more.title='更多';more.setAttribute('aria-label','更多：'+chat.title);more.setAttribute('aria-haspopup','menu');
  more.onclick=event=>{event.stopPropagation();if(!chatMenu.hidden&&chatMenu.dataset.chat===chat.id)closeChatMenu();else openChatMenu(more,chat);};
  row.append(button,more);return row;
}
function renderProjectChats(){
  const list=byId('chats');list.replaceChildren();const query=byId('task-search').value.trim().toLowerCase();
  const activeChats=chats.filter(chat=>!chat.archived);
  for(const project of [...projects,{id:'',name:'未归类',folder:''}]){
    const rows=activeChats.filter(c=>(c.projectId??'')===project.id&&(project.name.toLowerCase().includes(query)||c.title.toLowerCase().includes(query)));
    if(query&&!rows.length&&!project.name.toLowerCase().includes(query))continue;
    if(!project.id&&!rows.length&&projects.length)continue;
    const group=document.createElement('details');group.className='project-group';group.dataset.project=project.id;
    group.open=query?true:projectOpen.get(chatAccount+project.id)??true;
    group.ontoggle=()=>projectOpen.set(chatAccount+project.id,group.open);
    const summary=document.createElement('summary');const name=document.createElement('span');name.className='sidebar-text';name.textContent=project.name;name.title=project.folder||'尚未归入项目的聊天';summary.append(name);
    if(project.id){
      const compress=documentButton('',()=>openProjectWiki(project));compress.className='project-wiki-action';compress.title='信息压缩 · 整理项目知识';compress.setAttribute('aria-label','信息压缩：'+project.name);
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
      const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M4 3h10l4 4v5M14 3v5h4M7 11h6M7 15h3M3 7v14h11M13 16h8m-3-3 3 3-3 3');svg.append(path);compress.append(svg);compress.addEventListener('click',e=>e.stopPropagation());summary.append(compress);
      const folder=documentButton('↗',async()=>{const r=await window.cpclaw.projectAction({action:'reveal',id:project.id});if(!r.ok)throw Error(r.message);});folder.title='在文件夹中显示项目';folder.setAttribute('aria-label','显示项目文件夹：'+project.name);folder.addEventListener('click',e=>e.stopPropagation());summary.append(folder);
    }
    const add=documentButton('＋',()=>newProjectChat(project.id));add.title='在此项目新建聊天';add.setAttribute('aria-label','新建聊天：'+project.name);add.addEventListener('click',e=>e.stopPropagation());summary.append(add);group.append(summary);
    for(const chat of rows)group.append(projectChatRow(chat));
    if(!rows.length){const empty=document.createElement('p');empty.className='project-empty';empty.textContent=chatAccount?'点击 ＋ 开始聊天':'登录后开始聊天';group.append(empty);}
    list.append(group);
  }
  const archived=chats.filter(chat=>chat.archived&&(!query||chat.title.toLowerCase().includes(query)));
  if(archived.length){
    const group=document.createElement('details');group.className='project-group archived-chats';group.open=query?true:projectOpen.get(chatAccount+':archived')??false;
    group.ontoggle=()=>projectOpen.set(chatAccount+':archived',group.open);
    const summary=document.createElement('summary');const name=document.createElement('span');name.className='sidebar-text';name.textContent='已归档';name.title='对话已收起，生成的文档和图片仍可打开';summary.append(name);group.append(summary);
    for(const chat of archived)group.append(projectChatRow(chat));
    list.append(group);
  }
  if(!list.children.length)list.textContent='没有匹配的项目或聊天';
}
onAction('rail-project',async()=>{
  const actor=chatAccount;const r=await window.cpclaw.projectAction({action:'create'});if(actor!==chatAccount)return;if(!r.ok)throw Error(r.message);if(r.cancelled)return;
  await loadChats();await newProjectChat(r.project.id);setStatus('项目已关联：'+r.project.folder+'。新成果将自动保存到该文件夹。');
});
onAction('move-chat-confirm',async()=>{
  const actor=chatAccount,projectId=byId('move-chat-project').value,id=movingChatId;
  const r=await chatCall('project.assign',{chatId:id,projectId});if(actor!==chatAccount)return;
  if(!r.ok){byId('move-chat-feedback').textContent=r.message;return;}
  if(id===currentChatId){currentProjectId=projectId;attachedProjectFile=null;clearProjectFolder();if(documentStructureTab==='folders')void renderProjectFolder();}
  byId('move-chat-dialog').close();await loadChats();
});
onAction('attach-project-material',async()=>{
  if(!currentProjectId){setStatus('先在左侧选择项目，或点击文件夹＋关联本地文件夹。');return;}
  const actor=chatAccount,id=currentProjectId,chatId=currentChatId;
  const r=await window.cpclaw.projectAction({action:'file',id});
  if(actor!==chatAccount||id!==currentProjectId||chatId!==currentChatId)return;
  if(!r.ok)throw Error(r.message);if(r.cancelled)return;attachedProjectFile=r.file;renderComposer();byId('note').focus();
});
byId('remove-project-material').onclick=()=>{attachedProjectFile=null;renderComposer();};
byId('move-chat-dialog').addEventListener('close',()=>{movingChatId='';});
onAction('delete-chat-confirm',async()=>{
  const actor=chatAccount, id=deletingChatId;
  const result=await chatCall('chat.delete',{chatId:id});
  if(actor!==chatAccount)return;
  if(!result.ok){byId('delete-chat-feedback').textContent=result.message;return;}
  byId('delete-chat-dialog').close();
  if(id===currentChatId){const next=chats.find(chat=>chat.id!==id&&!chat.archived);await selectChat(next?.id??'');}
  await loadChats();
  setStatus('对话已删除，其中生成的文档和图片也已删除。');
});
byId('delete-chat-cancel').onclick=()=>byId('delete-chat-dialog').close();
byId('delete-chat-dialog').addEventListener('close',()=>{deletingChatId='';});
document.addEventListener('pointerdown',event=>{if(!chatMenu.hidden&&!chatMenu.contains(event.target)&&!event.target.closest('.chat-more'))closeChatMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeChatMenu();});
byId('chats').closest('.history-scroll')?.addEventListener('scroll',closeChatMenu);
renderChat();
