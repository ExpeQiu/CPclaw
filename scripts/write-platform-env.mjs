// 仅部署入口调用：私有配置经 SSH stdin 传输，既不打印也不进入构建上下文。
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
const [target, remoteDir, envFile] = process.argv.slice(2);
if (!target || !remoteDir?.match(/^\/[A-Za-z0-9_/-]+$/) || !envFile) throw new Error('部署参数无效');
const vars = { ...parseEnv(readFileSync(envFile, 'utf8')), ...process.env };
if (!vars.MINIMAX_API_KEY || !vars.CPCLAW_SESSION_SECRET) throw new Error('缺少真实模型密钥或会话密钥');
const body = [
  'AI_MOCK_MODE=false', 'CPCLAW_REPORT_MODEL_MODE=real', 'CPCLAW_DATA_DIR=/data',
  'CPCLAW_PLATFORM_PORT=3928', 'CPCLAW_LISTEN_HOST=0.0.0.0', 'CPCLAW_PLATFORM_SEED=fixture',
  `CPCLAW_SESSION_SECRET=${vars.CPCLAW_SESSION_SECRET}`, `MINIMAX_API_KEY=${vars.MINIMAX_API_KEY}`,
  `MINIMAX_OPENAI_BASE_URL=${vars.MINIMAX_OPENAI_BASE_URL || 'https://api.minimaxi.com/v1'}`,
].join('\n') + '\n';
const result = spawnSync('ssh', ['-o', 'BatchMode=yes', target, `umask 077; cat > '${remoteDir}/repo/deploy/platform/.env'`], { input: body, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] });
if (result.status !== 0) { process.stderr.write('远端私有配置写入失败\n'); process.exit(1); }
console.log('真实模型私有配置已通过 SSH 写入远端（未输出凭证）。');
