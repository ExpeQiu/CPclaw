// 仅用于自动测试的可控模型；生产判断由真实模型工具调用完成。
import { createServer } from 'node:http';
export function documentModelFixture(decide) {
  return createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw), system=body.messages.find(m=>m.role==='system')?.content??'';
    const context=system.includes('Document context: ')?JSON.parse(system.split('Document context: ')[1]):{files:[]};
    const choice=decide({body,context});
    res.writeHead(200,{'content-type':'text/event-stream'});
    const send=value=>res.write('data: '+JSON.stringify(value)+'\n\n');
    if(choice.kind==='answer') {send({choices:[{delta:{content:choice.content??'你好，这是直接回答。'}}]});send({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});res.end();return;}
    const args=choice.rawArgs??JSON.stringify({filename:choice.filename??'x.md',content:choice.content??'# 资料整理\n\n## 步骤\n- 核对来源\n- 整理信息\n\n## 验收标准\n核实结果。',sourceId:choice.sourceId??context.active?.id??''});
    send({choices:[{delta:{tool_calls:[{index:0,id:'call-document',type:'function',function:{name:choice.toolName??'deliver_document',arguments:''}}]}}]});
    let offset=0;const timer=setInterval(()=>{const part=args.slice(offset,offset+(choice.slow?10:80));offset+=part.length;send({choices:[{delta:{tool_calls:[{index:0,function:{arguments:part}}]}}]});if(offset>=args.length){clearInterval(timer);send({choices:[{delta:{},finish_reason:choice.finish??'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:8}});res.end();}},choice.slow?20:5);
    res.on('close',()=>clearInterval(timer));
  });
}
