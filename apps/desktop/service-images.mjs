import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,statSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';

export const MAX_IMAGE_BYTES=64*1024*1024;
export function inspectServiceImage(path,expected={}) {
  const info=statSync(path);
  if(!info.isFile()||info.size<12||info.size>MAX_IMAGE_BYTES)throw Error('图片文件为空或超过本机读取限制（64 MiB）');
  const bytes=readFileSync(path),sha256=createHash('sha256').update(bytes).digest('hex');
  if(expected.size!==undefined&&expected.size!==bytes.length)throw Error('下载文件大小与服务回执不一致');
  if(expected.sha256&&expected.sha256!==sha256)throw Error('下载文件校验失败');
  const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
  if(!mime)throw Error('下载内容不是可预览的图片');
  return {path,size:bytes.length,sha256,mime};
}
export function serviceImageData(path,expected={}) {
  const image=inspectServiceImage(path,expected);
  return `data:${image.mime};base64,${readFileSync(path).toString('base64')}`;
}
export function serviceArtifactRoot(dataDir,actorId,chatId) {
  if(typeof actorId!=='string'||!actorId||typeof chatId!=='string'||!/^[\w-]{1,64}$/.test(chatId))throw Error('成果目录缺少有效账号或对话');
  return resolve(realpathSync(dataDir),'service-artifacts',createHash('sha256').update(actorId).digest('hex').slice(0,16),chatId);
}
export function localServiceImage(dataDir,context,{path,resourceId,expected={}}={}) {
  const root=serviceArtifactRoot(dataDir,context.actorId,context.chatId);
  // Reject symlinked parent directories as well as symlinked files.
  if(realpathSync(root)!==root)throw Error('成果目录包含外部路径引用');
  if(!path){
    if(typeof resourceId!=='string'||!/^[-\w]{1,128}$/.test(resourceId))throw Error('图片资源编号无效');
    const name=readdirSync(root).find(n=>n.startsWith(`dreamina-${resourceId}.`)&&/\.(png|jpe?g|webp)$/i.test(n));
    if(!name)throw Error('本机尚无该图片文件');
    path=join(root,name);
  }
  const actual=realpathSync(path);
  if(!actual.startsWith(root+'/'))throw Error('图片路径超出当前账号与对话的成果目录');
  return inspectServiceImage(actual,expected);
}
