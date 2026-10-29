import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

/** 连接器探测分层：程序 → 协议/版本 → 登录 → 可发现能力。业务写入仍须任务内 discover。 */
export const PROBE_LAYERS = {
  binary_missing: '缺少程序',
  binary_ok: '程序可用',
  handshake_ok: '协议握手通过',
  auth_required: '待登录',
  auth_ok: '已登录',
  ready: '可调用（待任务内发现）',
  failed: '检测失败',
};

export function dreaminaTarget() {
  return join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'dreamina-canvas.exe' : 'dreamina-canvas');
}

/** 解析本机官方 lark-cli；可用 CPCLAW_FEISHU_CLI 覆盖。 */
export function resolveFeishuCli(env = process.env) {
  const name = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli';
  const candidates = [
    typeof env.CPCLAW_FEISHU_CLI === 'string' ? env.CPCLAW_FEISHU_CLI.trim() : '',
    join(homedir(), '.local', 'bin', name),
    join(homedir(), '.npm-global', 'bin', name),
    '/opt/homebrew/bin/' + name,
    '/usr/local/bin/' + name,
    ...(String(env.PATH || '')
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, name))),
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      if (existsSync(path)) return path;
    }
  }
  return '';
}

export function plannedChannelConnectors() {
  return [
    {
      id: 'channel-feishu-bot',
      title: '飞书机器人',
      type: 'CHANNEL',
      kind: 'channel',
      target: '',
      enabled: false,
      builtin: true,
      removable: false,
      planned: true,
      description: '消息渠道（规划中）。与飞书 CLI 服务调用分开；正式接入依赖测试应用与回调网络（Q11）。',
      status: '后续规划 · 未接入',
      probe: null,
    },
    {
      id: 'channel-wecom',
      title: '企业微信',
      type: 'CHANNEL',
      kind: 'channel',
      target: '',
      enabled: false,
      builtin: true,
      removable: false,
      planned: true,
      description: '消息渠道（规划中）。与服务调用连接器分开验收，不能由飞书 Mock 推定。',
      status: '后续规划 · 未接入',
      probe: null,
    },
  ];
}

export function builtinConnectors(env = process.env) {
  const dreaminaPath = dreaminaTarget();
  let dreaminaOk = false;
  try {
    accessSync(dreaminaPath, constants.X_OK);
    dreaminaOk = true;
  } catch {
    dreaminaOk = existsSync(dreaminaPath);
  }
  const feishuPath = resolveFeishuCli(env);
  return [
    {
      id: 'dreamina',
      title: '即梦画布',
      type: 'CLI',
      kind: 'service',
      target: dreaminaPath,
      enabled: true,
      builtin: true,
      removable: false,
      description: '内置服务调用连接。检测程序、登录与可发现命令；不代表飞书/企微等消息渠道已接入。',
      status: dreaminaOk ? '随内核提供 · 待检测登录' : '随内核提供 · 未找到 CLI',
      probe: null,
    },
    {
      id: 'feishu',
      title: '飞书 CLI',
      type: 'CLI',
      kind: 'service',
      target: feishuPath,
      enabled: Boolean(feishuPath),
      builtin: true,
      removable: false,
      description: '服务调用连接（官方 lark-cli）。检测程序与 auth status；连接 CLI 不代表已接入飞书机器人消息渠道。',
      status: feishuPath ? '随本机提供 · 待检测登录' : '未找到 lark-cli · 可安装 @larksuite/cli 或设置 CPCLAW_FEISHU_CLI',
      probe: null,
    },
  ];
}

export function mergeConnectorViews(userConnectors = [], localProbes = {}, { includeChannels = false } = {}) {
  const builtins = builtinConnectors().map((c) => {
    const probe = localProbes[c.id] || null;
    return probe ? { ...c, probe, status: statusLabel(probe) } : c;
  });
  const users = userConnectors.map((c) => {
    const probe = c.probe || localProbes[c.id] || null;
    return {
      ...c,
      kind: c.kind || 'service',
      builtin: false,
      removable: true,
      probe,
      status: probe ? statusLabel(probe) : c.status || '未检测',
    };
  });
  const channels = includeChannels ? plannedChannelConnectors() : [];
  return [...builtins, ...users, ...channels];
}

export function statusLabel(probe) {
  if (!probe || typeof probe !== 'object') return '未检测';
  const layer = PROBE_LAYERS[probe.layer] || probe.layer || '未检测';
  const when = probe.checkedAt ? ' · ' + new Date(probe.checkedAt).toLocaleString('zh-CN') : '';
  return layer + when;
}

export function summarizeCliVersionProbe({ ok, message, stdout }) {
  const checkedAt = Date.now();
  if (!ok) {
    return {
      layer: 'failed',
      checkedAt,
      message: message || '程序检测失败',
      capabilities: [],
    };
  }
  return {
    layer: 'binary_ok',
    checkedAt,
    message: message || ('程序版本检测通过' + (stdout ? '：' + String(stdout).trim().slice(0, 120) : '') + '（未验证登录与业务操作）'),
    capabilities: ['--version'],
  };
}

export function summarizeMcpProbe({ ok, message, serverName, tools }) {
  const checkedAt = Date.now();
  if (!ok) {
    return {
      layer: 'failed',
      checkedAt,
      message: message || 'MCP 握手失败',
      capabilities: [],
    };
  }
  return {
    layer: 'handshake_ok',
    checkedAt,
    message: message || ('MCP 握手通过' + (serverName ? '：' + serverName : '') + '（尚未授权业务写入）'),
    capabilities: Array.isArray(tools) ? tools.slice(0, 30) : ['initialize'],
  };
}

/** 飞书 lark-cli auth status --json → 分层摘要（不含 token/scope 原文）。 */
export function summarizeFeishuAuth({ ok, version, status, message }) {
  const checkedAt = Date.now();
  if (!resolveFeishuCli()) {
    return { layer: 'binary_missing', checkedAt, message: message || '未找到 lark-cli', capabilities: [], auth: 'required' };
  }
  if (!ok || !status || typeof status !== 'object') {
    return {
      layer: version ? 'binary_ok' : 'failed',
      checkedAt,
      message: message || '飞书认证状态读取失败',
      capabilities: version ? ['--version'] : [],
      auth: 'required',
      version: typeof version === 'string' ? version.slice(0, 80) : undefined,
    };
  }
  const bot = status.identities?.bot || {};
  const user = status.identities?.user || {};
  const botReady = bot.status === 'ready' || bot.available === true;
  const userReady = user.status === 'ready' || user.available === true;
  const userExpired = user.tokenStatus === 'expired' || /expired|missing/i.test(String(user.status || ''));
  const capabilities = ['auth status'];
  if (botReady) capabilities.push('bot');
  if (userReady) capabilities.push('user');
  if (botReady || userReady) {
    return {
      layer: 'ready',
      checkedAt,
      message:
        (botReady && userReady
          ? '飞书 CLI 程序可用；bot 与 user 身份均就绪'
          : botReady
            ? '飞书 CLI 程序可用；bot 身份就绪（user 未就绪时仅限租户/机器人 API）'
            : '飞书 CLI 程序可用；user 身份就绪') + '。不代表消息渠道机器人已接入；任务执行前仍会重新发现。',
      capabilities,
      auth: 'ok',
      version: typeof version === 'string' ? version.slice(0, 80) : undefined,
      brand: typeof status.brand === 'string' ? status.brand : undefined,
    };
  }
  return {
    layer: 'auth_required',
    checkedAt,
    message:
      (userExpired
        ? '飞书 CLI 已安装，但用户登录已过期；请在终端执行 lark-cli auth login。'
        : '飞书 CLI 已安装，但尚未完成可用登录；请执行 lark-cli auth login。') + ' 这与飞书机器人消息渠道无关。',
    capabilities: version ? ['--version', 'auth status'] : ['auth status'],
    auth: 'required',
    version: typeof version === 'string' ? version.slice(0, 80) : undefined,
  };
}

/** 即梦 discover 回执 → 分层探测摘要（不含凭据）。 */
export function summarizeDreaminaDiscover(result) {
  const checkedAt = Date.now();
  if (!result || result.ok === false) {
    const loggedIn = result?.auth?.data?.loggedIn === true;
    const layer = !existsSync(dreaminaTarget())
      ? 'binary_missing'
      : loggedIn
        ? 'failed'
        : result?.auth
          ? 'auth_required'
          : 'failed';
    return {
      layer,
      checkedAt,
      message: result?.message || '即梦检测未通过',
      capabilities: (result?.commands || []).map((c) => (Array.isArray(c.command) ? c.command.join(' ') : '')).filter(Boolean).slice(0, 20),
      auth: loggedIn ? 'ok' : 'required',
    };
  }
  const commands = (result.commands || []).map((c) => (Array.isArray(c.command) ? c.command.join(' ') : '')).filter(Boolean);
  return {
    layer: 'ready',
    checkedAt,
    message: '即梦程序、登录与能力目录检查通过；任务执行前仍会重新发现工具。',
    capabilities: commands.slice(0, 40),
    auth: 'ok',
    version: result.version?.data?.version || result.version?.output || undefined,
  };
}

export function defaultProbeHome() {
  return join(homedir(), '.local', 'bin');
}
