// 仅用于自动测试的可控模型；生产判断由真实模型工具调用完成。
import { createServer } from 'node:http';
import {randomUUID} from 'node:crypto';
export function documentModelFixture(decide) {
  return createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw), system=body.messages.find(m=>m.role==='system')?.content??'';
    const native=body.tools?.some(t=>t.function.name==='list_resources');
    const last=body.messages.at(-1);let resources=null;
    if(native&&last?.role==='tool'){try{resources=JSON.parse(last.content).resources||null;}catch{}}
    const context=native?{files:resources?.documents||[],active:(resources?.documents||[]).find(d=>d.id===resources?.input?.documentId)||(resources?.documents||[]).at(-1)}:system.includes('Document context: ')?JSON.parse(system.split('Document context: ')[1]):{files:[]};
    let choice=native&&last?.role==='tool'&&!resources?{kind:'answer',content:'内核交付完成'}:decide({body:{...body,messages:body.messages.map(m=>({...m,content:Array.isArray(m.content)?m.content.map(b=>b.type==='text'?b.text:'').join('\n'):m.content}))},context});
    if(native&&choice.kind==='document'&&!resources){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'list_resources',arguments:'{}'}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=value=>res.write('data: '+JSON.stringify(value)+'\n\n');
    if(choice.kind==='answer') {send({choices:[{delta:{content:choice.content??'你好，这是直接回答。'}}]});send({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});res.end();return;}
    const args=choice.rawArgs??JSON.stringify({... (native?{documentKey:'doc-'+resources.inputId,part:0,complete:true,expectedHash:resources?.input?.expectedHash||context.active?.hash||''}:{}),filename:choice.filename??'x.md',content:choice.content??'# 资料整理\n\n## 步骤\n- 核对来源\n- 整理信息\n\n## 验收标准\n核实结果。',sourceId:choice.sourceId??context.active?.id??''});
    send({choices:[{delta:{tool_calls:[{index:0,id:native?'call-document-'+resources.inputId:'call-document',type:'function',function:{name:choice.toolName??'deliver_document',arguments:''}}]}}]});
    let offset=0;const timer=setInterval(()=>{const part=args.slice(offset,offset+(choice.slow?10:80));offset+=part.length;send({choices:[{delta:{tool_calls:[{index:0,function:{arguments:part}}]}}]});if(offset>=args.length){clearInterval(timer);send({choices:[{delta:{},finish_reason:choice.finish??'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:8}});res.end();}},choice.slow?20:5);
    res.on('close',()=>clearInterval(timer));
  });
}
