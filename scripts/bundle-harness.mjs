import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Preserve workspace-relative configuration assets; every dependency link stays inside the bundle.
export function bundleHarness(sourceRoot, targetRoot) {
  sourceRoot = realpathSync(sourceRoot);
  const workspace = new Map();
  function scan(dir, depth) {
    if (existsSync(join(dir, 'package.json'))) {
      const m = JSON.parse(readFileSync(join(dir, 'package.json')));
      if (m.name) workspace.set(m.name, dir);
    }
    if (depth) for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && !['node_modules', 'lib', 'src', 'tests', '.git'].includes(d.name)) scan(join(dir, d.name), depth - 1);
    }
  }
  for (const d of ['apps', 'packages', 'vendor', 'native']) scan(join(sourceRoot, d), 3);
  const copied = new Map();
  const omittedOptional = [];
  function locate(name, from) {
    if (workspace.has(name)) return workspace.get(name);
    for (let dir = from; ; dir = dirname(dir)) {
      const path = join(dir, 'node_modules', name);
      if (existsSync(join(path, 'package.json'))) return realpathSync(path);
      if (dirname(dir) === dir) throw Error(`Harness dependency missing: ${name} from ${from}`);
    }
  }
  function copy(from) {
    from = realpathSync(from);
    if (copied.has(from)) return copied.get(from);
    const m = JSON.parse(readFileSync(join(from, 'package.json')));
    const local = workspace.get(m.name) === from;
    const target = local ? join(targetRoot, relative(sourceRoot, from)) : join(targetRoot, 'dependencies', String(copied.size));
    copied.set(from, target);
    mkdirSync(target, { recursive: true });
    cpSync(from, target, { recursive: true, dereference: true, filter: p => {
      const parts = relative(from, p).split('/');
      return !parts.some(n => ['node_modules', '.git', 'tests', 'test', '__tests__', 'coverage'].includes(n) || n.startsWith('._') || n === '.env' || n.startsWith('.env.')) && !p.endsWith('.map') && !(local && parts[0] === 'src');
    }});
    const deps = { ...m.dependencies, ...m.peerDependencies, ...m.optionalDependencies };
    for (const name of Object.keys(deps)) {
      let dep;
      try { dep = locate(name, from); } catch (error) {
        if (m.optionalDependencies?.[name] || m.peerDependenciesMeta?.[name]?.optional) { omittedOptional.push(name); continue; }
        throw error;
      }
      const destination = copy(dep);
      const link = join(target, 'node_modules', name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(relative(dirname(link), destination), link);
    }
    // Dynamic Cordis plugin resolution uses the install anchor's node_modules.
    {
      const link = join(targetRoot, 'node_modules', m.name);
      if (!existsSync(link)) { mkdirSync(dirname(link), { recursive: true }); symlinkSync(relative(dirname(link), target), link); }
    }
    return target;
  }
  for (const name of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh', '@deepseek-ai/dsh-llm-pi-ai']) copy(locate(name, sourceRoot));
  const sdk = join(targetRoot, 'node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js');
  const cli = join(targetRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  if (!existsSync(sdk) || !existsSync(cli)) throw Error('Build Harness before packaging: compiled SDK/CLI missing');
  cpSync(join(sourceRoot, 'LICENSE'), join(targetRoot, 'LICENSE'));
  const manifest = { version: JSON.parse(readFileSync(join(sourceRoot, 'package.json'))).version, commit: execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), packages: copied.size, omittedOptional: [...new Set(omittedOptional)] };
  writeFileSync(join(targetRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
