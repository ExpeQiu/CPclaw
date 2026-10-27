const projectOpen = new Map();
let movingChatId = '';
function projectError(error){setStatus(error.message||'项目操作失败');}
async function newProjectChat(id){currentProjectId=id;await selectChat('');document.getElementById('close-panel').click();byId('note').focus();}
function projectChatRow(chat) {
  const row=document.createElement('div');row.className='project-chat-row';
  const button=document.createElement('button');button.className=`task-row${desktopView==='chat'&&chat.id===currentChatId?' active':''}`;
  button.setAttribute('aria-current',String(desktopView==='chat'&&chat.id===currentChatId));
  const title=document.createElement('strong');title.textContent=chat.title;
  const meta=document.createElement('small');meta.textContent=chat.id===runningChatId?'正在回复…':'本地保存';
  button.append(title,meta);button.onclick=()=>selectChat(chat.id).catch(projectError);
  const move=document.createElement('button');move.className='chat-move';move.textContent='•••';move.title='移动到项目';move.setAttribute('aria-label','移动聊天：'+chat.title);
  move.onclick=()=>{
    movingChatId=chat.id;const select=byId('move-chat-project');select.replaceChildren();
    for(const p of [{id:'',name:'未归类'},...projects]){const option=document.createElement('option');option.value=p.id;option.textContent=p.name;select.append(option);}
    select.value=chat.projectId??'';byId('move-chat-feedback').textContent='';byId('move-chat-dialog').showModal();
  };
  row.append(button,move);return row;
}
function renderProjectChats(){
  const list=byId('chats');list.replaceChildren();const query=byId('task-search').value.trim().toLowerCase();
  for(const project of [...projects,{id:'',name:'未归类',folder:''}]){
    const rows=chats.filter(c=>(c.projectId??'')===project.id&&(project.name.toLowerCase().includes(query)||c.title.toLowerCase().includes(query)));
    if(query&&!rows.length&&!project.name.toLowerCase().includes(query))continue;
    if(!project.id&&!rows.length&&projects.length)continue;
    const group=document.createElement('details');group.className='project-group';group.dataset.project=project.id;
    group.open=query?true:projectOpen.get(chatAccount+project.id)??true;
    group.ontoggle=()=>projectOpen.set(chatAccount+project.id,group.open);
    const summary=document.createElement('summary');const name=document.createElement('span');name.className='sidebar-text';name.textContent=project.name;name.title=project.folder||'尚未归入项目的聊天';summary.append(name);
    if(project.id){const folder=documentButton('↗',async()=>{const r=await window.cpclaw.projectAction({action:'reveal',id:project.id});if(!r.ok)throw Error(r.message);});folder.title='在文件夹中显示项目';folder.setAttribute('aria-label','显示项目文件夹：'+project.name);folder.addEventListener('click',e=>e.stopPropagation());summary.append(folder);}
    const add=documentButton('＋',()=>newProjectChat(project.id));add.title='在此项目新建聊天';add.setAttribute('aria-label','新建聊天：'+project.name);add.addEventListener('click',e=>e.stopPropagation());summary.append(add);group.append(summary);
    for(const chat of rows)group.append(projectChatRow(chat));
    if(!rows.length){const empty=document.createElement('p');empty.className='project-empty';empty.textContent=chatAccount?'点击 ＋ 开始聊天':'登录后开始聊天';group.append(empty);}
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
renderChat();
