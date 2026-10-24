// Uses only the packaged Node, SDK, CLI, plugins and adapter. No developer loader or model credentials.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const bundle = resolve(process.argv[2]);
const resources = realpathSync(join(bundle, 'Contents/Resources'));
if (process.argv[3] !== '--child') {
  const home = mkdtempSync(join(tmpdir(), 'cpclaw-bundled-harness-'));
  const result = spawnSync(join(resources, 'runtime/bin/node'), [import.meta.filename, bundle, '--child'], {
    cwd: home, env: { HOME: home, TMPDIR: tmpdir(), PATH: '/usr/bin:/bin', CPCLAW_HARNESS_BUNDLE: join(resources, 'harness') }, encoding: 'utf8', timeout: 120_000,
  });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
function inspect(dir) {
  for (const item of readdirSync(dir)) {
    const file = join(dir, item), stat = lstatSync(file);
    if (stat.isSymbolicLink()) assert(!relative(resources, realpathSync(file)).startsWith('..'), `External dependency: ${file}`);
    else if (stat.isDirectory()) inspect(file);
  }
}
inspect(join(resources, 'harness'));
// Exercise the actual desktop worker launcher with a deliberately absent development checkout.
const {createWorkspaceClient} = await import(pathToFileURL(join(resources, 'app/workspace-client.mjs')));
process.env.CPCLAW_NODE_BINARY = process.execPath;
process.env.CPCLAW_REPORT_ENGINE = 'harness';
process.env.CPCLAW_HARNESS_ROOT = '/nonexistent/development-harness';
delete process.env.CPCLAW_HARNESS_BUNDLE;
const worker = createWorkspaceClient(process.env.HOME, join(resources, 'app'));
try {
  const snapshot = await Promise.race([worker.request({method:'snapshot',actorId:'bundle-verifier'}), new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Packaged worker timeout')),15_000);timer.unref();})]);
  assert.equal(snapshot.ok,true,JSON.stringify(snapshot));
} finally { worker.stop(); }
process.env.CPCLAW_HARNESS_BUNDLE = join(resources, 'harness');
let requests = 0;
const finalResponse = '# 任务目标\n验证包内运行。\n# 材料与来源\npolicy.md#p1\n# 要点\n保留来源 policy.md#p1\n# 未覆盖项\n未验证真实模型。';
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/harness/completions');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests++;
    const toolResult = body.messages.some(m => m.role === 'tool');
    if (toolResult) assert(JSON.stringify(body.messages).includes('材料测试正文'));
    const chunk = (delta, finish_reason) => `data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`;
    res.writeHead(200, {'content-type':'text/event-stream'});
    if (!toolResult) res.write(chunk({role:'assistant',tool_calls:[{index:0,id:'read-1',type:'function',function:{name:'read_material',arguments:'{}'}}]},null));
    else res.write(chunk({role:'assistant',content:finalResponse},null));
    res.end(chunk({},toolResult?'stop':'tool_calls')+'data: [DONE]\n\n');
  } catch (error) { res.writeHead(500);res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const {runBoundReportLoop} = await import(pathToFileURL(join(resources,'app/node_modules/@cpclaw/desktop-host/dist/harness-report.js')));
  let charged = 0;
  const result = await runBoundReportLoop({ homeParent: process.env.HOME, platformBase: `http://127.0.0.1:${server.address().port}`, accessToken:'fixture-only', goal:'验证包内材料工具', materials:[{fileName:'policy.md',paragraphs:[{id:'p1',text:'材料测试正文'}]}], signal:AbortSignal.timeout(90_000), beforeCall:()=>{charged++;},unknownUsage:()=>{throw Error('Unexpected failed call');} });
  assert.equal(result.finalResponse,finalResponse);assert.equal(result.toolCalls,1);assert.equal(requests,2);assert.equal(charged,2);assert.equal(result.childCommandSeenAfterClose,false);
  console.log(JSON.stringify({passed:true,node:process.version,harness:JSON.parse(readFileSync(join(resources,'harness/manifest.json'))).version,...result,model:'local deterministic fixture; no real model called'}));
} finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
