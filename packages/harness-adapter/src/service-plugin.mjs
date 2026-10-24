// 仅装配宿主注册的服务工具；模型不能安装插件、选择程序路径或声明已获授权。
export const name = 'cpclaw-service';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register({
    name:'service_action',
    description:'通过当前用户选择的应用服务执行真实操作。request 为 JSON 字符串：先 {"action":"discover"} 获取真实 CLI help/schema 或 MCP tools；然后 CLI 用 {"action":"call","args":["子命令","参数"],"purpose":"操作目的"}，MCP 用 {"action":"call","tool":"已发现工具名","arguments":{}}。一次一个操作；宿主负责授权并返回真实回执。不得猜测命令或伪造成功，失败时按回执恢复，不改写成说明文档。',
    parameters:{request:{type:'string',description:'包含 action 的 JSON 对象字符串；只调用已发现的真实能力。'}},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    async execute(args){
      const response=await fetch(`${process.env.CPCLAW_TOOL_URL}/service`,{method:'POST',headers:{authorization:`Bearer ${process.env.CPCLAW_LOOP_KEY}`,'content-type':'application/json'},body:args.request});
      if(!response.ok)throw Error('服务授权已失效或执行已中止');
      return response.text();
    },
  });
}
