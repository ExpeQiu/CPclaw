import {existsSync,readFileSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {basename,dirname,isAbsolute,join} from 'node:path';
import {packagePath} from './tpcstore-apps.mjs';

// Recognition is static: never imports selected code, starts a process or opens a network connection.
export function inspectAppFolder(input) {
  if(typeof input!=='string'||!isAbsolute(input))throw Error('请选择有效的文件夹');
  const root=realpathSync(input);if(!statSync(root).isDirectory())throw Error('所选路径不是文件夹');
  const isStore=p=>existsSync(join(p,'bin/tpcstore-cli.mjs'))&&existsSync(join(p,'contracts/products.json'))&&existsSync(join(p,'apps'));
  if(isStore(root))return {kind:'store',root,storeRoot:root,title:'TPCstore 应用目录',description:'检查目录后选择应用，自动连接工作台。'};
  let parent=dirname(root);
  for(let depth=0;depth<8;depth++) {
    if(isStore(parent)) {
      const matches=[];
      for(const name of readdirSync(join(parent,'apps')).filter(n=>n.endsWith('.json')&&!n.startsWith('._'))) {
        let app;try{app=JSON.parse(readFileSync(join(parent,'apps',name),'utf8'));}catch{throw Error('所属 TPCstore 的应用清单无法读取，请修复后重试');}
        if(app.integration&&packagePath(parent,app.integration.root,true)===root)matches.push(app);
      }
      if(matches.length>1)throw Error('多个应用清单指向此文件夹，请修复重复登记');
      if(matches.length===1){const app=matches[0];if(app.protocol_version!=='1.0.0')throw Error('应用协议版本暂不支持，请更新宿主或应用');return {kind:'app',root,storeRoot:parent,appId:app.app_id,title:app.app_id==='tpcstore.cutpot'?'CutPot':app.app_id,description:app.app_id==='tpcstore.cutpot'?'已识别视频创作应用。连接后可通过对话操作，并在右侧打开工作台。':app.description,connectable:app.app_id==='tpcstore.cutpot'&&app.stage!=='design'};}
      let catalog;try{catalog=JSON.parse(readFileSync(join(parent,'contracts/products.json'),'utf8'));}catch{throw Error('产品登记无法读取，请修复后重试');}
      for(const product of catalog.products||[])if(packagePath(parent,product.code_path,true)===root)return {kind:'unsupported',root,title:product.name||product.id,description:'已识别登记产品，当前尚未提供受支持的工作台连接。请选择其他应用，或等待应用接入完成。'};
      break;
    }
    const next=dirname(parent);if(next===parent)break;parent=next;
  }
  if(existsSync(join(root,'app-manifest.json'))){
    let app;try{app=JSON.parse(readFileSync(join(root,'app-manifest.json'),'utf8'));}catch{throw Error('app-manifest.json 无法解析，请修复后重试');}
    return {kind:'unsupported',root,title:app.app_id||basename(root),description:'发现应用清单，但当前版本尚不支持此应用直接加载。请从其 TPCstore 目录添加。'};
  }
  return {kind:'project',root,title:basename(root),description:'未发现可连接的应用清单。可作为普通项目添加，供对话读取文件与执行终端操作。'};
}
