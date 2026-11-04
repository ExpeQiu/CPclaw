import {delimiter,dirname} from 'node:path';

/** Finder launches may omit the usual shell PATH; retain configured paths first. */
export function runtimeEnv(env=process.env) {
  if(process.platform==='win32')return {...env};
  const paths=[...(env.PATH||'').split(delimiter).filter(Boolean),
    ...(env.CPCLAW_NODE_BINARY?[dirname(env.CPCLAW_NODE_BINARY)]:[]),
    '/usr/bin','/bin','/usr/sbin','/sbin','/opt/homebrew/bin','/usr/local/bin'];
  return {...env,PATH:[...new Set(paths)].join(delimiter)};
}
