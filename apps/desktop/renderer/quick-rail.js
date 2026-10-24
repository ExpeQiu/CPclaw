function refreshQuickRail() {
  const inspector=document.getElementById('inspector');let section='home';
  if(document.getElementById('extension-picker')?.open)section='extensions';
  else if(!marketOverlay.hidden)section='market';
  else if(!inspector.hidden){for(const key of ['documents','sources','settings','extensions'])if(!document.getElementById('panel-'+key).hidden)section=key;}
  for(const button of document.querySelectorAll('[data-rail]')){
    const active=button.dataset.rail===section;
    if(button.getAttribute('aria-current')!==String(active))button.setAttribute('aria-current',String(active));
  }
  const account=document.getElementById('rail-account'),label=chatAccount?`账号：${chatAccount}`:'账号与登录';
  account.setAttribute('aria-label',label);account.dataset.tooltip=label;
  document.getElementById('rail-avatar').textContent=chatAccount?chatAccount.slice(-1).toUpperCase():'我';
}
function closeRailOverlay(){if(!marketOverlay.hidden)marketClose.click();}
for(const button of document.querySelectorAll('[data-rail]'))button.addEventListener('click',()=>{
  const key=button.dataset.rail;
  if(key!=='market')closeRailOverlay();
  if(key!=='extensions')document.getElementById('extension-picker')?.close();
  if(key==='home')document.getElementById('close-panel').click();
  else if(key==='chat')document.getElementById('close-panel').click();
  else if(key==='documents')document.getElementById('documents-toggle').click();
  else if(key==='extensions' && window.openExtensionPicker)void window.openExtensionPicker();
  else if(key==='sources'||key==='settings')openPanel(key);
  else if(key==='account'){openPanel('settings');document.getElementById(chatAccount?'account-summary':'employee-id').focus();}
  refreshQuickRail();
});
const railObserver=new MutationObserver(refreshQuickRail);
railObserver.observe(document.getElementById('inspector'),{attributes:true,subtree:true,attributeFilter:['hidden']});
railObserver.observe(marketOverlay,{attributes:true,attributeFilter:['hidden']});
const extensionPicker=document.getElementById('extension-picker');
if(extensionPicker)railObserver.observe(extensionPicker,{attributes:true,attributeFilter:['open']});
const railButtons=[...document.querySelectorAll('[data-rail]')];
for(const [index,button]of railButtons.entries())button.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?railButtons.length-1:(index+(event.key==='ArrowDown'?1:-1)+railButtons.length)%railButtons.length;railButtons[next].focus();});
refreshQuickRail();
