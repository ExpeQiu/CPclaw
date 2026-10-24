export async function performKnowledgeAction({input,actor,request,isCurrent,dialog,shell,parent}){
 if(!actor)return {ok:false,message:'请先登录'};
 try{
  if(input?.action==='directory'){
   const choice=await dialog.showOpenDialog(parent,{title:'选择知识库目录',properties:['openDirectory']});
   if(choice.canceled)return {ok:true,cancelled:true};
   if(!isCurrent(actor))throw Error('账号已变化');
   return await request({method:'knowledge.link',input:{scope:input.scope,kind:'local',target:choice.filePaths[0]}});
  }
  if(input?.action!=='open')throw Error('未知知识库操作');
  const r=await request({method:'knowledge.entry',input:{id:input.id,path:input.path}});
  if(!r.ok)return r;if(!isCurrent(actor))throw Error('账号已变化');shell.showItemInFolder(r.path);return {ok:true};
 }catch(error){return {ok:false,message:error.message};}
}
