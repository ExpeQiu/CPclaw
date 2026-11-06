(() => {
  const picker=document.getElementById('composer-model'),label=document.getElementById('composer-model-label');
  function render(){label.textContent='企业模型';label.title='所有对话通过内核使用企业端配置的模型';picker.dataset.mode='platform';}
  window.refreshComposerModel=async()=>render();window.renderComposerModel=render;
  document.addEventListener('pointerdown',event=>{if(!picker.contains(event.target))picker.open=false;});
  picker.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();picker.open=false;label.focus();}});render();
})();
