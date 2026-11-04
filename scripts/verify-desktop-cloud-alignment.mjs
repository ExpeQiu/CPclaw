import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {managementCatalog} from '../packages/platform/dist/management-catalog.js';
const installed='/Applications/CPclaw.app/Contents/Resources/app';
const dir=process.env.CPCLAW_DESKTOP_DIR||(existsSync(installed)?installed:fileURLToPath(new URL('../apps/desktop/',import.meta.url)));
const endpoints=new Set(managementCatalog.flatMap(m=>m.endpoints)),observed=new Set();
for(const file of ['chat-service.mjs','diagnostic-center.mjs','session-refresh.mjs','workspace-worker.mjs']){if(!existsSync(join(dir,file)))continue;const source=readFileSync(join(dir,file),'utf8');for(const match of source.matchAll(/["'`](\/v1\/[a-z0-9_/-]+)["'`]/g)){const path=match[1].replace(/\/$/,'');assert(endpoints.has(path)||endpoints.has(path+'/:id'),'missing desktop route '+path);observed.add(path);}}
const {publicServices}=await import(pathToFileURL(join(dir,'service-runtime.mjs')).href);
const connector={id:'verification-connector',title:'验证连接器',type:'MCP',target:'https://example.com/mcp'};
assert.equal(publicServices([{...connector,enabled:false}]).some(s=>s.id===connector.id),false);
assert.equal(publicServices([{...connector,enabled:true}]).some(s=>s.id===connector.id),true);
const version=JSON.parse(readFileSync(join(dir,'package.json'),'utf8')).version;
console.log(JSON.stringify({passed:true,desktopDir:dir,version,coveredEndpoints:[...observed].sort(),checks:['desktop cloud routes covered by management catalog','installed desktop respects effective connector enabled state'],limits:['does not execute installed app UI or access user workspace','does not verify new source-only desktop features in installed package']},null,2));
