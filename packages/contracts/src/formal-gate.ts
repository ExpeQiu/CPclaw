/** 首期正式联调闸门。缺输入只关闭对应轨道，不把空字符串或自动更新开关当成已确认。 */

export type FormalTrackId =
  | "signing"
  | "cli"
  | "mcp"
  | "knowledgeSample"
  | "learningQuota"
  | "feishu"
  | "wecom"
  | "deploy"
  | "oidc"
  | "autoUpdate";

export type FormalTrack = {
  id: FormalTrackId;
  open: boolean;
  missing: string;
};

type Env = Record<string, string | undefined>;

function present(env: Env, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 判断各正式轨道是否已有业务输入。
 * @param env 进程环境。空字符串视为未提供。
 * @returns 每条轨道的开关和缺失说明。自动更新始终关闭。
 */
export function assessFormalTracks(env: Env): FormalTrack[] {
  const callback = present(env, "CPCLAW_IM_CALLBACK_VERIFIED");
  return [
    { id: "signing", open: present(env, "CPCLAW_SIGNING_IDENTITY"), missing: "签名与公证账号（Q3）" },
    { id: "cli", open: present(env, "CPCLAW_FIRST_CLI"), missing: "首个 CLI 程序、许可证与测试账号（Q7）" },
    { id: "mcp", open: present(env, "CPCLAW_FIRST_MCP"), missing: "首个 MCP 地址、版本与认证（Q7）" },
    { id: "knowledgeSample", open: present(env, "CPCLAW_KNOWLEDGE_SAMPLE"), missing: "正式知识样本与格式范围（Q8）" },
    { id: "learningQuota", open: present(env, "CPCLAW_LEARNING_BUDGET"), missing: "学习预算与审核角色（Q9）" },
    { id: "feishu", open: present(env, "CPCLAW_FEISHU_APP_ID") && callback, missing: "飞书测试应用与回调网络（Q11）" },
    { id: "wecom", open: present(env, "CPCLAW_WECOM_AGENT_ID") && callback, missing: "企微测试应用与回调网络（Q11）" },
    { id: "deploy", open: present(env, "CPCLAW_FORMAL_DEPLOY"), missing: "正式部署位置（Q2）" },
    { id: "oidc", open: present(env, "CPCLAW_OIDC_ISSUER"), missing: "外部身份源（Q6）" },
    { id: "autoUpdate", open: false, missing: "自动更新仍待 Q12，环境变量不能打开" },
  ];
}

/**
 * 正式阶段是否可宣布通过。自动更新不在首期通过条件里，其余轨道必须打开。
 * @param env 进程环境
 * @returns 除自动更新外的轨道是否都已打开
 */
export function formalPhaseReady(env: Env): boolean {
  return assessFormalTracks(env).every((track) => track.id === "autoUpdate" || track.open);
}
