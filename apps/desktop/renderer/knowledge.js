let knowledgeLinks=[], knowledgeScope='personal', knowledgeGeneration=0, knowledgeReturnFocus=null;
const kbDialog=byId('knowledge-dialog'),kbBody=byId('knowledge-dialog-body');
const knowledgeOverlay=byId('knowledge-overlay');
function kbNode(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
function kbButton(text,action){const b=kbNode('button',text);b.type='button';b.onclick=async()=>{b.disabled=true;byId('knowledge-dialog-feedback').textContent='';try{await action();}catch(e){byId(kbDialog.open?'knowledge-dialog-feedback':'knowledge-feedback').textContent=e.message;}finally{b.disabled=false;}};return b;}
async function kbCall(method,input={}){const actor=chatAccount,r=await chatCall(method,input);if(actor!==chatAccount)throw Error('账号已变化');if(!r.ok)throw Error(r.message);return r;}
function clearKnowledge(){knowledgeGeneration++;knowledgeLinks=[];kbDialog.close();kbBody.replaceChildren();knowledgeOverlay.hidden=true;for(const scope of ['enterprise','personal'])byId(`knowledge-${scope}-list`).replaceChildren();byId('knowledge-feedback').textContent='';}
function kbOpen(title){byId('knowledge-dialog-title').textContent=title;kbBody.replaceChildren();byId('knowledge-dialog-feedback').textContent='';if(!kbDialog.open)kbDialog.showModal();}
function closeKnowledgeOverlay(){if(knowledgeOverlay.hidden)return;knowledgeOverlay.hidden=true;kbDialog.close();knowledgeReturnFocus?.focus();window.refreshQuickRail?.();}
window.closeKnowledgeOverlay=closeKnowledgeOverlay;
window.openKnowledge=async()=>{
  if(typeof closeRailOverlay==='function')closeRailOverlay();
  document.getElementById('extension-picker')?.close();
  knowledgeReturnFocus=document.activeElement;
  knowledgeOverlay.hidden=false;
  window.refreshQuickRail?.();
  try{await loadKnowledge();}catch(error){setStatus(error.message);byId('knowledge-feedback').textContent=error.message;}
  byId('knowledge-overlay-close').focus();
};
async function loadKnowledge(){
 const generation=++knowledgeGeneration,r=await kbCall('knowledge.list',{chatId:currentChatId});if(generation!==knowledgeGeneration)return;knowledgeLinks=r.links;
 for(const scope of ['enterprise','personal']){const list=byId(`knowledge-${scope}-list`);list.replaceChildren();for(const link of r.links.filter(l=>l.scope===scope)){
  const card=kbNode('article');card.className='knowledge-card';card.append(kbNode('strong',link.name),kbNode('p',(link.kind==='local'?'本地目录':'CPclaw 平台')+' · '+(link.kind==='local'?`${link.count} 份文档`:'按当前权限读取')));
  if(link.kind==='local')card.append(kbNode('small',link.target));
  card.append(kbNode('p',link.status==='error'?link.error:link.updated?'可用 · '+new Date(link.updated).toLocaleString():'已关联'));
  const actions=kbNode('div');actions.className='button-row';actions.append(kbButton('查看',()=>kbView(link)),kbButton('更新',async()=>{try{await kbCall('knowledge.update',{id:link.id});byId('knowledge-feedback').textContent='知识库已更新';}finally{await loadKnowledge();}}),kbButton('解除关联',async()=>{await kbCall('knowledge.unlink',{id:link.id});await loadKnowledge();byId('knowledge-feedback').textContent='已解除关联，原始资料保留';}));card.append(actions);list.append(card);
 }if(!list.children.length)list.append(kbNode('p','尚未关联知识库'));}
}
function kbAssociate(scope){knowledgeScope=scope;kbOpen(scope==='enterprise'?'关联 企业知识库（wiki）':'关联 个人知识库（wiki）');kbBody.append(kbNode('p','选择来源'),kbButton('本地目录',async()=>{const actor=chatAccount;const r=await window.cpclaw.knowledgeAction({action:'directory',scope});if(actor!==chatAccount)return;if(!r.ok)throw Error(r.message);if(r.cancelled)return;kbDialog.close();await loadKnowledge();}),kbButton('CPclaw 平台',()=>kbPlatform(scope)));}
async function kbPlatform(scope){
 const r=await kbCall('knowledge.remote',{action:'list'});kbOpen('CPclaw 平台 · '+(scope==='enterprise'?'企业知识库':'个人知识库'));
 const libraries=r.libraries.filter(l=>l.scope===scope);
 for(const lib of libraries){const row=kbNode('div');row.className='knowledge-card';row.append(kbNode('strong',lib.name),kbNode('p',`${lib.count} 份文档`),kbButton('关联',async()=>{await kbCall('knowledge.link',{scope,kind:'platform',target:lib.id});kbDialog.close();await loadKnowledge();}));kbBody.append(row);}
 if(!libraries.length)kbBody.append(kbNode('p','暂无可访问的知识库。企业知识库需由管理员创建并授权。'));
 if(scope==='personal'||r.role==='admin')kbBody.append(kbButton('＋ 新建知识库',()=>kbEditLibrary(scope)));
}
function kbField(label,value='',multi=false){const wrap=kbNode('label',label),input=kbNode(multi?'textarea':'input');input.value=value;if(multi)input.rows=10;wrap.append(input);kbBody.append(wrap);return input;}
function kbEditLibrary(scope,library){
 kbOpen(library?'修改知识库':'新建知识库');const name=kbField('名称',library?.name??''),members=scope==='enterprise'?kbField('可访问成员（员工编号，用逗号分隔）',(library?.members??[]).join(', ')):null;
 kbBody.append(kbNode('p',scope==='enterprise'?'仅管理员及指定成员可访问。':'个人知识库仅本人可见。'));
 kbBody.append(kbButton('保存并关联',async()=>{const r=await kbCall('knowledge.remote',{action:'save',input:{id:library?.id,scope,name:name.value,members:members?members.value.split(/[,，\s]+/).filter(Boolean):[]}});await kbCall('knowledge.link',{scope,kind:'platform',target:r.id});kbDialog.close();await loadKnowledge();}));
}
async function kbView(link,documentId){
 const r=await kbCall('knowledge.read',{id:link.id});kbOpen(link.name);
 if(r.library.editable){kbBody.append(kbButton('＋ 新建文档',()=>kbEditDocument(link)),kbButton('修改名称 / 权限',()=>kbEditLibrary(link.scope,r.library)));}
 const docs=documentId?r.documents.filter(d=>d.id===documentId):r.documents;
 if(!docs.length)kbBody.append(kbNode('p','暂无文档。'));
 for(const doc of docs){const detail=kbNode('details');detail.open=Boolean(documentId);detail.append(kbNode('summary',doc.title));const pre=kbNode('pre',doc.body);pre.className='knowledge-document';detail.append(pre);
 if(link.kind==='local')detail.append(kbButton('在文件夹中显示',async()=>{const result=await window.cpclaw.knowledgeAction({action:'open',id:link.id,path:doc.id});if(!result.ok)throw Error(result.message);}));
 if(r.library.editable)detail.append(kbButton('编辑文档',()=>kbEditDocument(link,doc)));kbBody.append(detail);}
}
function kbEditDocument(link,doc){kbOpen(doc?'编辑文档':'新建文档');const title=kbField('文档名称',doc?.title??''),body=kbField('正文（Markdown / TXT）',doc?.body??'',true);kbBody.append(kbButton('保存',async()=>{await kbCall('knowledge.remote',{action:'document-save',input:{id:link.target,documentId:doc?.id,revision:doc?.revision,title:title.value,body:body.value}});await loadKnowledge();await kbView(link);}));}
async function kbChoose(){if(!chatAccount)throw Error('请先登录');if(!currentChatId){const created=await kbCall('chat.create',{projectId:currentProjectId});currentChatId=created.chatId;await loadChats();}const chat=currentChatId,r=await kbCall('knowledge.list',{chatId:chat});kbOpen('当前对话的知识来源');kbBody.append(kbNode('p','勾选后，用于此对话的问答及文档生成；最多 12 个。'));const boxes=[];for(const link of r.links){const label=kbNode('label'),box=kbNode('input');label.className='checkbox';box.type='checkbox';box.checked=r.selected.includes(link.id);box.value=link.id;label.append(box,document.createTextNode((link.scope==='enterprise'?'企业 · ':'个人 · ')+link.name));kbBody.append(label);boxes.push(box);}if(!boxes.length)kbBody.append(kbNode('p','请先在知识库弹窗中关联来源。'),kbButton('打开知识库',async()=>{kbDialog.close();await window.openKnowledge();}));kbBody.append(kbButton('保存选择',async()=>{if(chat!==currentChatId)throw Error('对话已切换，请重新选择');await kbCall('knowledge.choose',{chatId:chat,ids:boxes.filter(b=>b.checked).map(b=>b.value)});kbDialog.close();setStatus('知识来源已保存到当前对话');}));}
function renderKnowledgeCitations(sources){const details=kbNode('details');details.className='project-citations';details.append(kbNode('summary',`知识库参考资料 · ${sources.length} 份`));for(const source of sources){details.append(kbButton(`${source.scope==='enterprise'?'企业':'个人'} · ${source.libraryName} / ${source.title} · L${source.lineStart}–${source.lineEnd}`,async()=>{const r=await kbCall('knowledge.list'),link=r.links.find(l=>l.id===source.linkId);if(!link)throw Error('知识库已解除关联，请重新关联后查看');await kbView(link,source.id);}));}return details;}
byId('knowledge-dialog-close').onclick=()=>kbDialog.close();
byId('knowledge-overlay-close').onclick=()=>closeKnowledgeOverlay();
byId('knowledge-enterprise').onclick=()=>kbAssociate('enterprise');byId('knowledge-personal').onclick=()=>kbAssociate('personal');
byId('knowledge-sources').onclick=()=>kbChoose().catch(e=>setStatus(e.message));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!knowledgeOverlay.hidden&&!kbDialog.open)closeKnowledgeOverlay();});
