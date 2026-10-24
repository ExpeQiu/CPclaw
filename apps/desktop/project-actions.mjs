import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
export async function performProjectAction({input,actor,request,isCurrent,dialog,shell,parent}) {
  if(!actor)return {ok:false,message:'请先登录'};
  try {
    if(input?.action==='create'){
      const choice=await dialog.showOpenDialog(parent,{title:'选择项目文件夹',properties:['openDirectory','createDirectory']});
      if(choice.canceled)return {ok:true,cancelled:true};
      if(!isCurrent(actor))throw Error('账号已变化');
      return await request({method:'project.create',input:{folder:choice.filePaths[0]}});
    }
    const result=await request({method:'project.get',input:{id:input?.id}});if(!result.ok)return result;
    if(!isCurrent(actor))throw Error('账号已变化');
    if(input.action==='revealFile'){const file=await request({method:'project.entry',input:{id:input.id,path:input.path}});if(!file.ok)return file;if(!isCurrent(actor))throw Error('账号已变化');shell.showItemInFolder(file.path);return {ok:true};}
    if(input.action==='reveal'){shell.showItemInFolder(result.project.folder);return {ok:true};}
    if(input.action!=='file')throw Error('未知项目操作');
    const choice=await dialog.showOpenDialog(parent,{title:'选择本次使用的项目材料',defaultPath:result.project.folder,properties:['openFile'],filters:[{name:'文本材料',extensions:['md','txt','csv','json','yaml','yml']}]});
    if(choice.canceled)return {ok:true,cancelled:true};
    if(!isCurrent(actor))throw Error('账号已变化');
    return await request({method:'project.file',input:{id:input.id,path:relative(result.project.folder,realpathSync(choice.filePaths[0]))}});
  }catch(error){return {ok:false,message:error.message};}
}
