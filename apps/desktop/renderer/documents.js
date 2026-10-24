function dismissDocumentWorkspace(){documentGeneration++;document.body.classList.remove('document-expanded');documentElement('document-expand').textContent='展开 ↗';}
let chatArtifacts = [], activeArtifact = null, editingArtifact = null, documentGeneration = 0;
const documentElement = id => document.getElementById(id);
function clearDocumentView() {
  clearProjectFolder();
  chatArtifacts=[];activeArtifact=null;editingArtifact=null;documentGeneration++;
  documentElement('document-view').hidden=true;documentElement('document-empty').hidden=false;documentElement('document-edit-context').hidden=true;
  document.body.classList.remove('document-expanded');documentElement('document-expand').textContent='展开 ↗';documentElement('document-filter').value='';
  for(const id of ['document-location','document-version','document-feedback','document-source','document-preview'])documentElement(id).replaceChildren();
renderDocumentList();
}
function documentButton(text, callback) {
  const button=document.createElement('button');button.type='button';button.textContent=text;
  button.addEventListener('click',async()=>{button.disabled=true;try{await callback();}catch(error){setStatus(error.message);}finally{button.disabled=false;}});return button;
}
function renderDocumentList() {
  documentElement('document-count').textContent=new Set(chatArtifacts.map(a=>a.document_id)).size;
  const list=documentElement('document-list'),tabs=documentElement('document-tabs');list.replaceChildren();tabs.replaceChildren();
  const groups=new Map(),query=documentElement('document-filter').value.toLowerCase();
  for(const artifact of chatArtifacts){if(!groups.has(artifact.document_id))groups.set(artifact.document_id,[]);groups.get(artifact.document_id).push(artifact);}
  if(!groups.size)list.textContent='暂无文档';
  for(const versions of groups.values()) {
    versions.sort((a,b)=>b.revision-a.revision);const latest=versions[0];
    const tab=documentButton(latest.name,()=>showDocument(latest.id));tab.title=latest.name;tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(activeArtifact?.document_id===latest.document_id));tabs.append(tab);
    if(query&&!versions.some(a=>(a.name+' v'+a.revision).toLowerCase().includes(query)))continue;
    const group=document.createElement('details');group.open=true;group.className='document-tree-group';const summary=document.createElement('summary');summary.textContent='▤ '+latest.name;group.append(summary);
    for(const artifact of versions){const row=documentButton(`v${artifact.revision} · ${artifact.name}`,()=>showDocument(artifact.id));row.className='document-tree-file';row.setAttribute('aria-current',String(activeArtifact?.id===artifact.id));row.title=artifact.path;group.append(row);}
    list.append(group);
  }
  if(groups.size&&!list.children.length)list.textContent='没有匹配的文件';
  renderDocumentOutline();
}
function renderDocumentOutline(){
  const outline=documentElement('document-outline');outline.replaceChildren();const query=documentElement('document-filter').value.toLowerCase();
  for(const heading of documentElement('document-preview').querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if(query&&!heading.textContent.toLowerCase().includes(query))continue;
    const row=documentButton(heading.textContent,()=>{heading.scrollIntoView({block:'start',behavior:'smooth'});});row.style.paddingLeft=(10+(Number(heading.tagName.slice(1))-1)*12)+'px';outline.append(row);
  }
  if(!outline.children.length)outline.textContent=activeArtifact?'没有匹配的标题':'选择文档查看标题结构';
}
function renderDocumentCard(artifact) {
  const card=document.createElement('div');card.className='document-card';
  const title=document.createElement('strong');title.textContent=artifact.name;
  const path=document.createElement('small');path.textContent=artifact.path;path.className='document-path';
  const meta=document.createElement('span');meta.textContent=`Markdown · v${artifact.revision} · 已保存到本地`;
  title.title=artifact.path;
  card.append(title,meta,documentButton('预览文档',()=>showDocument(artifact.id)),documentButton('打开',()=>documentAction('open',artifact.id)),documentButton('另存为',()=>documentAction('saveAs',artifact.id)));
  return card;
}
// 聊天和文档预览使用同一安全渲染器，原始 HTML 不执行。
function renderMarkdown(body) {
  renderChatMarkdown(documentElement('document-preview'),body);
}
async function showDocument(id) {
  const generation=++documentGeneration, actor=chatAccount, chatId=currentChatId;
  activeArtifact=null;documentElement('document-view').hidden=true;
  const result=await chatCall('document.read',{id});
  if(generation!==documentGeneration||chatAccount!==actor||currentChatId!==chatId)return;
  if(!result.ok)throw Error(result.message);
  const a=result.artifact;activeArtifact=a;openPanel('documents');
  documentElement('document-view').hidden=false;documentElement('document-empty').hidden=true;
  documentElement('document-location').textContent=a.path;
  documentElement('document-version').textContent=`v${a.revision}`;
  documentElement('document-feedback').textContent=a.externalChange?'文件已在外部修改，当前显示磁盘中的最新内容。':'';
  documentElement('document-feedback').hidden=!a.externalChange;
  documentElement('document-more').open=false;
  documentElement('document-source').textContent=a.body;renderMarkdown(a.body);
  setDocumentView(false);renderDocumentList();
}
async function documentAction(action,id=activeArtifact?.id) {
  if(!id)throw Error('请先选择文档');
  const result=await window.cpclaw.documentAction({action,id});if(!result.ok)throw Error(result.message);
  if(action==='saveAs')setStatus(result.cancelled?'已取消另存为':`已另存为：${result.path}`);
}
function addArtifact(artifact) {if(!chatArtifacts.some(a=>a.id===artifact.id))chatArtifacts.push(artifact);renderDocumentList();}
documentElement('documents-toggle').onclick=()=>{openPanel('documents');renderDocumentList();};
documentElement('document-open').onclick=()=>documentAction('open').catch(e=>setStatus(e.message));
documentElement('document-save-as').onclick=()=>documentAction('saveAs').catch(e=>setStatus(e.message));
documentElement('document-reveal').onclick=()=>documentAction('reveal').catch(e=>setStatus(e.message));
documentElement('document-refresh').onclick=()=>activeArtifact&&showDocument(activeArtifact.id).catch(e=>setStatus(e.message));
documentElement('document-edit').onclick=()=>{
  if(!activeArtifact)return;
  if(innerWidth<=1100)documentElement('close-panel').click();
  else if(document.body.classList.contains('document-expanded'))documentElement('document-expand').click();
  editingArtifact={id:activeArtifact.id,expectedHash:activeArtifact.currentHash,name:activeArtifact.name};
  const context=documentElement('document-edit-context');context.hidden=false;context.replaceChildren(document.createTextNode(`正在修改 ${activeArtifact.name} · v${activeArtifact.revision} `),documentButton('取消修改',()=>{editingArtifact=null;context.hidden=true;}));
documentElement('note').placeholder='描述需要怎样修改，将生成新版本并保留原文档…';documentElement('note').focus();
};
function setDocumentView(source) {
  documentElement('document-preview').hidden=source;
  documentElement('document-source').hidden=!source;
  for(const [id,selected] of [['document-preview-tab',!source],['document-source-tab',source]]) {
    documentElement(id).setAttribute('aria-selected',String(selected));
    documentElement(id).tabIndex=selected?0:-1;
  }
}
documentElement('document-preview-tab').onclick=()=>setDocumentView(false);
documentElement('document-source-tab').onclick=()=>setDocumentView(true);
for(const id of ['document-preview-tab','document-source-tab'])documentElement(id).addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const source=event.key==='End'||event.key!=='Home'&&id==='document-preview-tab';
  setDocumentView(source);documentElement(source?'document-source-tab':'document-preview-tab').focus();
});
const documentMore=documentElement('document-more');
documentMore.addEventListener('click',event=>{if(event.target.closest('button'))documentMore.open=false;});
document.addEventListener('pointerdown',event=>{if(!documentMore.contains(event.target))documentMore.open=false;});
documentMore.addEventListener('keydown',event=>{if(event.key==='Escape'){documentMore.open=false;documentMore.querySelector('summary').focus();}});

let documentStructureTab='files',folderGeneration=0;
function clearProjectFolder(){folderGeneration++;documentElement('document-folder-tree').replaceChildren();documentElement('document-folder-heading').replaceChildren();}
function filterProjectFolder(){
  const query=documentElement('document-filter').value.toLowerCase();
  for(const row of documentElement('document-folder-tree').querySelectorAll('button[data-path]'))row.hidden=!row.dataset.path.toLowerCase().includes(query);
}
function projectFileIcon(name,folder=false,symlink=false){
  const icon=document.createElement('span');icon.setAttribute('aria-hidden','true');
  if(folder){icon.className='project-folder-icon';icon.innerHTML='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 4h4l1.5 1.5H14v7.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4Zm0 1V3.3a1 1 0 0 1 1-1h3L7.5 4H13a1 1 0 0 1 1 1"/></svg>';return icon;}
  const extension=name.includes('.')?name.split('.').at(-1).toLowerCase():'';
  const labels={md:'MD',txt:'TXT',ts:'TS',tsx:'TS',js:'JS',mjs:'JS',cjs:'JS',json:'{}',yaml:'Y',yml:'Y',pdf:'PDF',png:'IMG',jpg:'IMG',jpeg:'IMG',svg:'SVG',html:'<>',css:'#',csv:'CSV'};
  icon.className='project-file-icon';icon.dataset.kind=['ts','tsx','js','mjs','cjs'].includes(extension)?extension.replace(/^(mjs|cjs)$/,'js'):extension==='md'?'md':'file';icon.textContent=symlink?'↗':labels[extension]||'·';return icon;
}
function projectEntryName(name){const label=document.createElement('span');label.className='project-entry-name';label.textContent=name;return label;}
async function renderProjectFolder(){
  const tree=documentElement('document-folder-tree'),generation=++folderGeneration,actor=chatAccount,id=currentProjectId;
  tree.replaceChildren();documentElement('document-folder-heading').replaceChildren();
  if(!actor||!id){tree.textContent='选择项目后查看文件夹';return;}
  const current=()=>generation===folderGeneration&&actor===chatAccount&&id===currentProjectId;
  async function load(container,path){
    container.textContent='正在读取…';
    try{
      const result=await chatCall('project.entries',{id,path});if(!current())return;
      if(!result.ok)throw Error(result.message);
      container.replaceChildren();
      if(!result.entries.length)container.textContent='空文件夹';
      for(const entry of result.entries){
        if(entry.directory){
          const group=document.createElement('details');group.className='project-folder-group';
          const summary=document.createElement('summary');summary.append(projectFileIcon(entry.name,true),projectEntryName(entry.name));summary.title=entry.path;
          const children=document.createElement('div');children.className='project-folder-children';let loaded=false;
          group.ontoggle=()=>{if(group.open&&!loaded){loaded=true;void load(children,entry.path);}};
          group.append(summary,children);container.append(group);
        }else{
          const row=documentButton('',async()=>{
            const result=await window.cpclaw.projectAction({action:'revealFile',id,path:entry.path});if(!result.ok)throw Error(result.message);
          });
          row.className='project-file-row';row.append(projectFileIcon(entry.name,false,entry.symlink),projectEntryName(entry.name));row.dataset.path=entry.path;row.title=entry.path+' · 在文件夹中显示';container.append(row);
        }
      }
      filterProjectFolder();
    }catch(error){if(current()){container.replaceChildren(document.createTextNode(error.message),documentButton('重试',()=>load(container,path)));}}
  }
  const heading=documentElement('document-folder-heading');
  const project=projects.find(p=>p.id===id);const name=projectEntryName(project?.name||'项目文件夹');name.title=project?.folder||name.textContent;
  const refresh=documentButton('⟳',renderProjectFolder);refresh.title='刷新文件夹';refresh.setAttribute('aria-label','刷新文件夹');
  heading.append(projectFileIcon('',true),name,refresh);
  const contents=document.createElement('div');tree.append(contents);await load(contents,'');
}
function selectDocumentStructure(tab){
  documentStructureTab=tab;
  documentElement('document-folder-heading').hidden=tab!=='folders';
  documentElement('document-filter').placeholder=tab==='folders'?'筛选文件…':'筛选文件或标题…';
  for(const [name,panel] of [['folders','document-folder-tree'],['files','document-list'],['outline','document-outline']]){
    documentElement(panel).hidden=name!==tab;documentElement('document-'+name+'-tab').setAttribute('aria-pressed',String(name===tab));
  }
  if(tab==='folders')void renderProjectFolder();
  if(tab==='outline')renderDocumentOutline();
}
documentElement('document-filter').oninput=()=>{renderDocumentList();filterProjectFolder();};
for(const tab of ['folders','files','outline'])documentElement('document-'+tab+'-tab').onclick=()=>selectDocumentStructure(tab);
documentElement('document-expand').onclick=()=>{document.body.classList.toggle('document-expanded');documentElement('document-expand').textContent=document.body.classList.contains('document-expanded')?'收回 ↙':'展开 ↗';};
