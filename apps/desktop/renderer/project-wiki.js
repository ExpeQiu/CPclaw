// Project operations keep their own UI and event channel; changing chats does not cancel a run.
const wikiDialog=document.createElement('dialog');wikiDialog.id='project-wiki-dialog';wikiDialog.className='project-wiki-dialog';wikiDialog.setAttribute('aria-labelledby','project-wiki-title');document.body.append(wikiDialog);
let wikiProject=null,wikiActor=null,wikiGeneration=0,wikiStatus=null;
window.clearProjectWiki=()=>{
  wikiGeneration++;wikiProject=null;wikiActor=null;wikiStatus=null;wikiDialog.close();
  wikiScope.textContent='';wikiSummary.textContent='';wikiFeedback.textContent='';wikiDetails.replaceChildren();wikiPreview.replaceChildren();
};
function wikiNode(tag,text){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;}
const wikiHeading=wikiNode('h2','信息压缩');wikiHeading.id='project-wiki-title';
const wikiClose=documentButton('关闭',()=>wikiDialog.close()),wikiHead=wikiNode('div');wikiHead.className='project-wiki-heading';wikiHead.append(wikiHeading,wikiClose);
const wikiScope=wikiNode('p'),wikiSummary=wikiNode('p'),wikiFeedback=wikiNode('p'),wikiActions=wikiNode('div'),wikiDetails=wikiNode('div'),wikiPreview=wikiNode('article');
wikiScope.className='muted';wikiScope.style.overflowWrap='anywhere';wikiFeedback.setAttribute('role','status');wikiFeedback.setAttribute('aria-live','polite');wikiActions.className='button-row';wikiPreview.className='project-wiki-preview';
const wikiStart=documentButton('开始整理',()=>runProjectWiki()),wikiStop=documentButton('停止整理',async()=>{await wikiCall('project.wiki.cancel');wikiFeedback.textContent='正在停止整理…';}),wikiView=documentButton('查看 Wiki',()=>viewProjectWiki()),wikiChanges=documentButton('查看本次变更',()=>viewProjectWiki(wikiStatus?.last?.changeFile));
wikiStart.className='primary';wikiActions.append(wikiStart,wikiStop,wikiView,wikiChanges);
wikiDialog.append(wikiHead,wikiScope,wikiNode('p','整理项目资料，更新 Wiki 与 Agent 索引。原文件保持原位，仅手动执行；变化的文本将通过当前平台模型加工并消耗模型额度。'),wikiSummary,wikiActions,wikiFeedback,wikiDetails,wikiPreview);
async function wikiCall(method,input={}) {
  const actor=wikiActor,id=wikiProject?.id;
  if(!id || actor!==chatAccount)throw Error('账号已变化，请重新打开项目');
  const result=await chatCall(method,{id,...input});
  if(actor!==chatAccount || actor!==wikiActor || id!==wikiProject?.id)throw Error('项目或账号已变化，请重新打开');
  if(!result.ok)throw Error(result.message);return result;
}
function wikiBusy(value){wikiStart.disabled=value;wikiStop.hidden=!value;wikiView.disabled=!wikiStatus?.updated;wikiChanges.disabled=!wikiStatus?.last?.changeFile;}
function wikiIssues(rows,title){if(!rows?.length)return;const details=wikiNode('details'),summary=wikiNode('summary',`${title}（${rows.length}）`),list=wikiNode('ul');for(const row of rows)list.append(wikiNode('li',row.path+'：'+row.reason));details.append(summary,list);wikiDetails.append(details);}
function renderWikiStatus(result) {
  wikiStatus=result;
  wikiSummary.textContent=`${result.total} 份支持的文本 · ${result.changed} 份新增或变化 · ${result.removed} 份来源移除。上次更新：${result.updated?new Date(result.updated).toLocaleString():'尚未整理'}`;
  wikiStart.textContent=result.updated?'更新知识':'开始整理';wikiBusy(result.busy);
  wikiDetails.replaceChildren();wikiIssues(result.last?.pending,'待处理');wikiIssues(result.skipped,'未加工材料');
  if(!result.busy && result.run?.state==='error')wikiFeedback.textContent=result.run.message;
  if(result.run?.state==='interrupted')wikiFeedback.textContent='上次整理被中断；再次执行将复用已完成的加工结果。';
}
async function openProjectWiki(project) {
  const generation=++wikiGeneration;wikiProject=project;wikiActor=chatAccount;wikiStatus=null;
  wikiHeading.textContent=project.name+' · 信息压缩';wikiScope.textContent=project.folder;wikiSummary.textContent='正在扫描项目资料…';wikiFeedback.textContent='';wikiDetails.replaceChildren();wikiPreview.replaceChildren();wikiBusy(true);
  if(!wikiDialog.open)wikiDialog.showModal();
  try {const result=await wikiCall('project.wiki.status');if(generation===wikiGeneration)renderWikiStatus(result);}
  catch(error){if(generation===wikiGeneration){wikiFeedback.textContent=error.message;wikiBusy(false);wikiStart.disabled=true;}}
}
async function runProjectWiki() {
  const generation=wikiGeneration;wikiBusy(true);wikiFeedback.textContent='正在扫描项目资料…';wikiPreview.replaceChildren();
  try {
    const result=await wikiCall('project.wiki.run');if(generation!==wikiGeneration)return;
    renderWikiStatus(await wikiCall('project.wiki.status'));
    wikiFeedback.textContent=result.unchanged?'资料没有变化，未调用模型。':`整理完成：新增 ${result.created} 页、更新 ${result.changed} 页、移除 ${result.removed} 份来源；${result.pending.length} 项待处理。Agent 索引已就绪，检索时会校验来源有效性。`;
  } catch(error) {
    if(generation!==wikiGeneration)return;wikiFeedback.textContent=error.message;
    try {renderWikiStatus(await wikiCall('project.wiki.status'));}catch{}
  } finally {if(generation===wikiGeneration)wikiBusy(false);}
}
async function viewProjectWiki(path='') {
  const generation=wikiGeneration,result=await wikiCall('project.wiki.read',{path});if(generation!==wikiGeneration)return;
  wikiPreview.replaceChildren();const navigation=wikiNode('div');navigation.className='project-wiki-navigation';
  navigation.append(documentButton('概览',()=>viewProjectWiki()));
  for(const page of result.pages)navigation.append(documentButton(page.title,()=>viewProjectWiki(page.path)));
  const content=wikiNode('div');renderChatMarkdown(content,result.body);
  for(const label of content.querySelectorAll('.markdown-link-label')) {
    let destination;
    try {
      const url=new URL(label.title,'https://project.invalid/'+result.path);
      if(url.origin!=='https://project.invalid' || url.search)continue;
      destination=decodeURIComponent(url.pathname.slice(1));
    }catch{continue;}
    const button=documentButton(label.textContent,async()=>{
      if(generation!==wikiGeneration)return;
      if(result.pages.some(p=>p.path===destination))await viewProjectWiki(destination);
      else {
        const response=await window.cpclaw.projectAction({action:'revealFile',id:wikiProject.id,path:destination});
        if(!response.ok)throw Error(response.message);
      }
    });button.className='project-wiki-link';button.title=destination;label.replaceWith(button);
  }
  wikiPreview.append(navigation,content);
}
window.cpclaw.onChatEvent(event=>{
  if(event.channel!=='project-wiki' || event.actorId!==chatAccount || event.actorId!==wikiActor || event.projectId!==wikiProject?.id)return;
  const labels={scan:'正在扫描项目资料…',publish:'正在发布 Wiki 与检索索引…',done:'整理完成'};
  wikiFeedback.textContent=event.stage==='process'?`正在加工 ${event.path} · ${event.completed}/${event.total} 份 · 片段 ${event.chunk}/${event.chunks}`:event.message||labels[event.stage]||event.stage;
  wikiBusy(!['done','error'].includes(event.stage));
  if(['done','error'].includes(event.stage)) {
    const generation=wikiGeneration;
    void wikiCall('project.wiki.status').then(result=>{if(generation===wikiGeneration)renderWikiStatus(result);}).catch(()=>{});
  }
});
wikiDialog.addEventListener('close',()=>{wikiPreview.replaceChildren();});
