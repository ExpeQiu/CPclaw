// Read-only cloud acceptance, apart from creating and logging out its own sessions.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {adminPage} from '../packages/platform/dist/admin-page.js';
const base=process.env.CPCLAW_PLATFORM_URL||'http://47.113.225.93:3928';
const checks=[];
async function request(path,token,body){const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});return {status:response.status,body:await response.json()};}
const page=await fetch(base+'/admin',{signal:AbortSignal.timeout(10000)});assert.equal(page.status,200);assert.equal(await page.text(),adminPage());checks.push('deployed HTML matches local build');
const root=await fetch(base+'/',{redirect:'manual',signal:AbortSignal.timeout(10000)});assert.equal(root.status,302);assert.equal(root.headers.get('location'),'/admin');
const health=await request('/health');assert.equal(health.status,200);assert.equal(health.body.mode,'real');checks.push('external health and root redirect');
assert.equal((await request('/v1/admin/manage',undefined,{action:'diagnostics'})).status,401);
const login=await request('/v1/session/login',undefined,{employeeId:process.env.CPCLAW_TEST_ADMIN_ID||'admin',password:process.env.CPCLAW_TEST_ADMIN_PASSWORD||'fixture-admin',deviceLabel:'admin-release-verification'});assert.equal(login.status,200);assert.equal(login.body.role,'admin');let token=login.body.accessToken;
try{
 for(const path of ['/v1/admin/employees','/v1/admin/provider','/v1/admin/audit'])assert.equal((await request(path,token)).status,200);
 for(const action of ['diagnostics','backups','catalog','audit-query','usage','quota-requests','uploads','log-receipts','connectors','learning-policy','learning-candidates','resources','wiki-revisions','originals','integrations'])assert.equal((await request('/v1/admin/manage',token,{action})).status,200);
 const market=await request('/v1/market',token,{action:'list',input:{summary:true}});assert.equal(market.status,200);assert.equal(market.body.role,'admin');checks.push('admin reads all business management modules');
 const catalog=await request('/v1/admin/manage',token,{action:'catalog'});assert.equal(catalog.body.schemaVersion,4);assert.equal(catalog.body.supportedSchema,4);const libraries=await request('/v1/knowledge',token,{action:'list'});assert.equal(libraries.status,200);checks.push('knowledge API and recovery schema aligned');
 const refreshed=await request('/v1/session/refresh',undefined,{refreshToken:login.body.refreshToken});assert.equal(refreshed.status,200);token=refreshed.body.accessToken;checks.push('session refresh');
}finally{assert.equal((await request('/v1/session/logout',token,{})).status,200);}
assert.equal((await request('/v1/admin/employees',token)).status,401);checks.push('logout revokes session');
const employee=await request('/v1/session/login',undefined,{employeeId:process.env.CPCLAW_TEST_EMPLOYEE_ID||'employee-a',password:process.env.CPCLAW_TEST_EMPLOYEE_PASSWORD||'fixture-employee-a',deviceLabel:'admin-denial-verification'});assert.equal(employee.status,200);
try{for(const action of ['diagnostics','diagnostic-read','backups','employee-create','employee-update','catalog','audit-query','usage','uploads','connectors','connector-control','learning-review','learning-set','resources','wiki-review','integrations'])assert.equal((await request('/v1/admin/manage',employee.body.accessToken,{action,input:{}})).status,403);}finally{await request('/v1/session/logout',employee.body.accessToken,{});}
checks.push('anonymous and employee management access denied');
console.log(JSON.stringify({passed:true,base,htmlSha256:createHash('sha256').update(adminPage()).digest('hex'),mode:'real',checks,finishedAt:new Date().toISOString()},null,2));
