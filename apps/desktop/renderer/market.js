const marketOverlay = document.createElement('section');
marketOverlay.hidden = true;
marketOverlay.className='market-overlay';
marketOverlay.style.cssText='position:fixed;inset:28px 28px 28px 260px;z-index:30;background:#f7f8fa;border:1px solid #dbe0e8;border-radius:16px;box-shadow:0 12px 50px #17233a24;display:flex;flex-direction:column;overflow:hidden';
const marketClose = document.createElement('button');marketClose.textContent='关闭技能市场 ×';marketClose.style.cssText='align-self:flex-end;margin:10px';marketClose.onclick=()=>{marketOverlay.hidden=true;};
const marketFrame = document.createElement('iframe');marketFrame.title='技能市场';marketFrame.style.cssText='border:0;flex:1;width:100%';
marketOverlay.append(marketClose,marketFrame);document.body.append(marketOverlay);
window.openSkillDraft=async skillId=>{
  const r=await window.cpclaw.workspace({method:'market.page',input:{}});if(!r.ok)throw Error(r.message);
  const draftLoad=()=>{marketFrame.contentWindow.postMessage({type:'cpclaw-open-skill',skillId},'*');};
  if(skillId)marketFrame.addEventListener('load',draftLoad,{once:true});marketFrame.srcdoc=r.html;marketOverlay.hidden=false;
};
document.getElementById('rail-market').onclick=()=>window.openSkillDraft().catch(e=>setStatus(e.message));
window.addEventListener('message',async e=>{if(e.source!==marketFrame.contentWindow||e.data?.type!=='market-use')return;marketOverlay.hidden=true;await loadChats();await selectChat(e.data.chatId);});
