// 按 Electron 官方手工打包布局生成本机 macOS 应用；仅包含显式列出的代码与运行依赖。
import { cpSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync, realpathSync, chmodSync, renameSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { bundleHarness } from './bundle-harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('此打包入口仅用于 Apple Silicon macOS');
const runtime = process.env.CPCLAW_PACKAGE_NODE_DIR;
if (!runtime || !existsSync(join(runtime, 'bin/node'))) throw Error('请设置 CPCLAW_PACKAGE_NODE_DIR，指向官方 Node 22.23.3 darwin-arm64 解压目录');
if (execFileSync(join(runtime, 'bin/node'), ['--version'], {encoding:'utf8'}).trim() !== 'v22.23.3') throw Error('Node 运行时版本必须为 22.23.3');
const version = JSON.parse(readFileSync(join(root,'apps/desktop/package.json'))).version;
const out = join(process.env.CPCLAW_PACKAGE_OUTPUT_DIR || join(root, 'dist'), `CPclaw-${version}-mac-arm64`);
const bundle = join(out, 'CPclaw.app');
if (existsSync(out)) throw Error(`产物目录已存在，请先移走旧产物：${out}`);
mkdirSync(out, {recursive:true});
execFileSync('/usr/bin/ditto', [realpathSync(join(root,'apps/desktop/node_modules/electron/dist/Electron.app')), bundle]);
const contents = join(bundle, 'Contents');
renameSync(join(contents,'MacOS','Electron'), join(contents,'MacOS','CPclaw'));
const resources = join(contents, 'Resources');
const app = join(resources, 'app');
mkdirSync(app, {recursive:true});
for (const file of ['conversation-permissions.mjs','local-tools.mjs','chat-diagnostics.mjs','diagnostic-authority.mjs','diagnostic-journal.mjs','media-task-state.mjs','service-images.mjs','creation-process.mjs','market-service.mjs','service-runtime.mjs','local-command-authorization.mjs','extension-host.mjs','extension-service.mjs','computer-use.mjs','desktop-log.mjs','desktop-settings.mjs','message-actions.mjs','local-extensions.mjs','service-kinds.mjs','session-refresh.mjs','platform-capability.mjs','main.mjs','preload.cjs','workspace-client.mjs','workspace-worker.mjs','chat-service.mjs','knowledge-service.mjs','knowledge-actions.mjs','project-service.mjs','project-search.mjs','project-actions.mjs','document-service.mjs','document-actions.mjs','renderer']) {
  cpSync(join(root,'apps/desktop',file),join(app,file),{recursive:true,filter:p=>!basename(p).startsWith('._')});
}
writeFileSync(join(app,'package.json'), JSON.stringify({name:'cpclaw',productName:'CPclaw',version,type:'module',main:'main.mjs'},null,2));
const copied = new Set();
function copyPackage(name, from) {
  if (copied.has(name)) return;
  copied.add(name);
  const target = join(app,'node_modules',name);
  mkdirSync(dirname(target),{recursive:true});
  const manifest = JSON.parse(readFileSync(join(from,'package.json')));
  if (name.startsWith('@cpclaw/')) {
    mkdirSync(target,{recursive:true});
    cpSync(join(from,'package.json'),join(target,'package.json'));
    cpSync(join(from,'dist'),join(target,'dist'),{recursive:true,filter:p=>!basename(p).startsWith('._')&&!p.endsWith('.map')});
  } else {
    cpSync(from,target,{recursive:true,dereference:true,filter:p=>!basename(p).startsWith('._')&&!p.slice(from.length).split('/').includes('node_modules')&&!p.endsWith('.map')});
  }
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    const source = dep.startsWith('@cpclaw/') ? join(root,'packages',dep.split('/')[1]) : dirname(createRequire(join(from,'package.json')).resolve(`${dep}/package.json`));
    copyPackage(dep, source);
  }
}
copyPackage('@cpclaw/desktop-host',join(root,'packages/desktop-host'));
copyPackage('@cpclaw/platform',join(root,'packages/platform'));
// Harness is a required, self-contained runtime in every desktop distribution.
const harnessManifest = bundleHarness(process.env.CPCLAW_HARNESS_ROOT || resolve(root, '../../13 Github/deepseek-harness'), join(resources, 'harness'));
mkdirSync(join(app, 'node_modules/@cpclaw/harness-adapter/src'), {recursive:true});
for(const file of ['material-plugin.mjs','service-plugin.mjs'])cpSync(join(root, 'packages/harness-adapter/src',file), join(app, 'node_modules/@cpclaw/harness-adapter/src',file));
const nodeTarget = join(resources,'runtime');
mkdirSync(join(nodeTarget,'bin'),{recursive:true});
cpSync(join(runtime,'bin/node'),join(nodeTarget,'bin/node'));
chmodSync(join(nodeTarget,'bin/node'),0o755);
cpSync(join(runtime,'LICENSE'),join(nodeTarget,'LICENSE'));
cpSync(join(root,'apps/desktop/node_modules/electron/LICENSE'),join(resources,'ELECTRON-LICENSE'));
// 记录完整应用快照，包含新增拓展模块与所有已构建工作区包。
const releaseFiles = {};
function recordReleaseFiles(directory, prefix = '') {
  for (const entry of readdirSync(directory, {withFileTypes:true})) {
    if (entry.name.startsWith('._')) continue;
    const key = prefix + entry.name;
    if (entry.isDirectory()) recordReleaseFiles(join(directory, entry.name), key + '/');
    else if (entry.isFile()) releaseFiles[key] = createHash('sha256').update(readFileSync(join(directory, entry.name))).digest('hex');
  }
}
recordReleaseFiles(app);
writeFileSync(join(app, 'release-manifest.json'), JSON.stringify({version, buildType:'full-workspace', createdAt:new Date().toISOString(), features:['knowledge','projects','documents','markdown','elapsed-timer','extensions-picker','extensions-native-view','natural-service-requests','harness-service-tools','cli-mcp-execution','creation-process-export','skill-distillation','enterprise-skill-market','versioned-skill-install','skill-trials','scene-experts','conversation-permissions','local-tools','chat-diagnostics','computer-use','desktop-settings','desktop-log','local-extensions','service-kinds','service-catalog-compat','diagnose-repair-plans'], files:releaseFiles}, null, 2) + '\n');
const plist = join(contents,'Info.plist');
for (const [key,value] of Object.entries({CFBundleExecutable:'CPclaw',CFBundleName:'CPclaw',CFBundleDisplayName:'CPclaw',CFBundleIdentifier:'com.cpclaw.desktop',CFBundleShortVersionString:version,CFBundleVersion:version,NSHumanReadableCopyright:'CPclaw local build'})) {
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
}
for (const helper of readdirSync(join(contents,'Frameworks')).filter(n=>!n.startsWith('._')&&n.endsWith('.app'))) {
  const helperPlist = join(contents,'Frameworks',helper,'Contents/Info.plist');
  execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :CFBundleIdentifier com.cpclaw.desktop.${helper.replace(/[^a-zA-Z]/g,'')}`,helperPlist]);
}
// 修改 bundle 后重签本地临时签名；不声称 Developer ID 签名或公证。
execFileSync('/usr/bin/xattr',['-cr',bundle]);
execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',bundle],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'inherit'});
execFileSync(join(nodeTarget, 'bin/node'), [join(root, 'scripts/verify-bundled-harness.mjs'), bundle], {stdio:'inherit'});
execFileSync(join(nodeTarget,'bin/node'),[join(root,'scripts/verify-bundled-service.mjs'),bundle],{stdio:'inherit'});
const dmgStage = join(out, 'dmg');
mkdirSync(dmgStage);
execFileSync('/usr/bin/ditto', [bundle, join(dmgStage, 'CPclaw.app')]);
execFileSync('/bin/ln', ['-s', '/Applications', join(dmgStage, 'Applications')]);
const dmg = `${out}.dmg`;
execFileSync('/usr/bin/hdiutil', ['create', '-volname', `CPclaw ${version}`, '-srcfolder', dmgStage, '-ov', '-format', 'UDZO', dmg], {stdio:'inherit'});
const zip = `${out}.zip`;
execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',bundle,zip]);
const manifest = {product:'CPclaw',version,platform:'darwin',arch:'arm64',electron:'33.4.11',node:'22.23.3',harness:harnessManifest,dmg:basename(dmg),dmgSha256:createHash('sha256').update(readFileSync(dmg)).digest('hex'),signature:'ad-hoc',notarized:false,createdAt:new Date().toISOString(),zip:basename(zip),sha256:createHash('sha256').update(readFileSync(zip)).digest('hex')};
writeFileSync(`${out}.json`,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({bundle,zip,dmg,manifest:`${out}.json`}));
