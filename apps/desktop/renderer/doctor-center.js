(() => {
 const $=id=>document.getElementById(id),root=$('doctor-center');if(!root)return;
 let busy=false,snapshot=null,generation=0;
 const out=$('doctor-out');
 const commands=[['chat','当前对话诊断'],['probe','检查平台连接'],['kernel','刷新内核状态'],['logs','打开日志目录'],['data','打开数据目录'],['file','定位诊断包'],['status','查询云端回执']];
 function line(label,value,status){const row=document.createElement('div');row.className='doctor-check '+(status?'doctor-'+status:'');const title=document.createElement('strong');title.textContent=label;const detail=document.createElement('span');detail.textContent=value;row.append(title,detail);return row;}
 function render(result){
  if(result.report){
   snapshot=result;$('doctor-cloud').replaceChildren();const list=$('doctor-checks');list.replaceChildren();
   list.append(line('APP',`v${result.app?.version||'未知'} · ${result.app?.packaged?'安装版':'开发模式'}`,'ok'));
   list.append(line('系统命令路径',result.app?.systemPathReady?'检查通过':'需修复',result.app?.systemPathReady?'ok':'fail'));
   list.append(line('工作进程','已响应诊断请求','ok'));
   const k=result.app?.kernel;list.append(line('推理内核',k?.ready?`${k.name||'Harness'} · ${k.source==='bundle'?'包内内核':'本机检出'}（未调用模型）`:'不可用，请检查配置',k?.ready?'ok':'fail'));
   for(const c of result.report.checks)list.append(line(({identity:'登录会话',model:'模型配置',cli_mcp:'应用工具',im:'消息渠道',directory:'目录权限',sync:'同步状态'})[c.id]||c.id,c.summary,c.status));
   out.textContent=`检查完成 · ${result.logCount} 条脱敏日志；检查完成不代表所有问题已修复。`;
  }
  if(result.upload){const cloud=$('doctor-cloud');cloud.replaceChildren();cloud.append(line('云端诊断包',result.upload.status==='available'?'已保存并通过完整性校验':result.upload.status,result.upload.status==='available'?'ok':'warn'));
   const code=document.createElement('code');code.textContent=result.upload.uploadId;cloud.append(code);out.textContent='云端回执已确认，可通过快捷操作再次查询。';}
 }
 async function run(action){
  if(busy)return;
  if(action==='chat'){$('chat-diagnose').click();return;}
  busy=true;const actor=typeof chatAccount==='undefined'?null:chatAccount;const version=++generation;
  root.querySelectorAll('button').forEach(b=>b.disabled=true);out.textContent='正在执行…';
  const current=()=>version===generation&&actor===(typeof chatAccount==='undefined'?null:chatAccount);
  try{
   if(!window.cpclaw?.doctorAction)throw Error('桌面诊断入口不可用，请更新应用。');
   if(action==='upload'&&!snapshot){const first=await window.cpclaw.doctorAction({action:'check',chatId:typeof currentChatId==='undefined'?'':currentChatId,includeExtra:$('diag-extra').checked});if(!current())return;if(!first.ok)throw Error(first.message);render(first);}
   const result=await window.cpclaw.doctorAction({action,chatId:typeof currentChatId==='undefined'?'':currentChatId,includeExtra:$('diag-extra').checked});
   if(!current())return;if(!result.ok)throw Error(result.message||'操作未完成');
   render(result);
   if(action==='repair'){out.textContent=result.verified?'运行环境修复后检查通过；任务结果请通过当前对话诊断核实。':result.message;await window.refreshKernelStatus?.();}
   else if(action==='export')out.textContent=`已导出 ${result.fileName}（${result.bytes} 字节）。可用快捷操作定位文件。`;
   else if(action==='kernel')out.textContent=result.kernel?.ready?'内核文件检查通过；未调用真实模型。':'内核不可用，请检查配置。';
   else if(action==='probe')out.textContent=result.summary||result.message||'平台连接检查完成';
   else if(['file','logs','data'].includes(action))out.textContent=result.message;
  }catch(e){if(current())out.textContent=e.message||'操作失败，请重试。';}
  finally{busy=false;root.querySelectorAll('button').forEach(b=>b.disabled=false);}
 }
 $('diag-extra').addEventListener('change',()=>{snapshot=null;$('doctor-cloud').replaceChildren();});
 $('doctor').onclick=()=>void run('check');$('doctor-repair').onclick=()=>void run('repair');$('doctor-export').onclick=()=>void run('export');$('doctor-upload').onclick=()=>void run('upload');
 for(const [action,label]of commands){const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.command=action;button.onclick=()=>void run(action);$('doctor-shortcuts').append(button);}
 window.clearDoctorCenter=()=>{generation++;snapshot=null;$('doctor-checks').replaceChildren();$('doctor-cloud').replaceChildren();out.textContent='尚未运行诊断';};
})();
