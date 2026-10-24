// 由固定部署配置加载；模型不能指定程序、文件路径或安装插件。
export const name = 'cpclaw-material';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register({
    name: 'read_material',
    description: '读取用户为本次报告明确选择的材料。生成报告前必须调用，返回 fileName 和段落来源 id。没有任意文件读取或写入能力。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const response = await fetch(`${process.env.CPCLAW_TOOL_URL}/material`, { headers: { authorization: `Bearer ${process.env.CPCLAW_LOOP_KEY}` } });
      if (!response.ok) throw new Error('材料授权已失效');
      return await response.text();
    },
  });
}
