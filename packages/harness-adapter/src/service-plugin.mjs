// Harness 选择任务步骤；宿主提供服务目录、对话权限和真实执行。
export const name = 'cpclaw-service';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register({
    name:'service_action',
    description:'通过当前用户选择的应用服务执行真实操作。request 为 JSON 字符串：先 {"action":"discover"} 获取真实 CLI help/schema 或 MCP tools；然后 CLI 用 {"action":"call","args":["子命令","参数"],"purpose":"操作目的"}，MCP 用 {"action":"call","tool":"已发现工具名","arguments":{}}。可以加 serviceId 在本轮服务目录中自主选择服务。local-terminal 提供本机文件与通用终端：先 discover，再用 {"action":"read_file","path":"文件路径"}、{"action":"write_file","path":"文件路径","content":"正文"} 或 {"action":"terminal","command":"终端命令","cwd":"工作目录","timeoutMs":60000}。browser-page 提供右侧原生页结构化操控：先 discover，再 open/snapshot，用 snapshot 返回的 ref 执行 click、type、scroll、press；登录、支付或密码输入须等待宿主强制确认，不得声称已登录或已付款，不得代填凭据。即梦创作仍优先 CLI。无需让用户逐步指挥，自主排查、实现并验证；宿主依据对话权限决定何时询问。一次一个操作；返回真实回执。不得猜测命令或伪造成功，失败时按回执恢复，不改写成说明文档。',
    parameters:{request:{type:'string',description:'包含 action 的 JSON 对象字符串；只调用已发现的真实能力。'}},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    async execute(args){
      const response=await fetch(`${process.env.CPCLAW_TOOL_URL}/service`,{method:'POST',headers:{authorization:`Bearer ${process.env.CPCLAW_LOOP_KEY}`,'content-type':'application/json'},body:args.request});
      if(!response.ok)throw Error('服务授权已失效或执行已中止');
      return response.text();
    },
  });
}
