import type {DocumentContext,DocumentDelivery} from './document-tool.js';
/** Decode only top-level string fields. An incomplete JSON string is a draft, never a delivery. */
export function partialDocument(raw:string,context:DocumentContext):DocumentDelivery|undefined{
 let pos=0;const fields:Record<string,string>={};
 const ws=()=>{while(/\s/.test(raw[pos]||'x'))pos++;};
 function string():{value:string;complete:boolean}|undefined{
  if(raw[pos++]!=='"')return;const start=pos;let safe=pos;
  while(pos<raw.length){const c=raw[pos++];if(c==='"')return {value:JSON.parse('"'+raw.slice(start,pos-1)+'"') as string,complete:true};
   if(c==='\\'){if(pos>=raw.length)break;const escape=raw[pos++];if(escape==='u'){if(!/^[0-9a-fA-F]{4}$/.test(raw.slice(pos,pos+4)))break;pos+=4;}}
   safe=pos;
  }
  try{return {value:JSON.parse('"'+raw.slice(start,safe)+'"') as string,complete:false};}catch{return;}
 }
 try{
  ws();if(raw[pos++]!=='{')return;
  for(let i=0;i<4;i++){
   ws();const key=string();if(!key?.complete)return;ws();if(raw[pos++]!==':')return;ws();
   if(raw[pos]!=='"')break;const value=string();if(!value)return;fields[key.value]=value.value;
   if(!value.complete)break;ws();if(raw[pos++]!==',')break;
  }
 }catch{return;}
 const filename=fields.filename,content=fields.content,sourceId=fields.sourceId??context.draft?.sourceId??(context.files.length===0?'':undefined);
 if(!filename||!content||sourceId===undefined||! /^[^/\\\x00-\x1f<>:"|?*]{1,100}\.md$/i.test(filename)||filename.startsWith('.')||content.length>128000||sourceId!==''&&!context.files.some(f=>f.id===sourceId))return;
 return {filename,content,sourceId,complete:false};
}
