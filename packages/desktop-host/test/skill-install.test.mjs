import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,symlinkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {installSkillPackage,readInstalledSkill,readCurrentSkill,activateInstalledSkill} from '../dist/index.js';
const digest=s=>createHash('sha256').update(s).digest('hex');
test('不可变版本、真实多文件校验、失败保留指针与恢复旧版',()=>{const dataDir=mkdtempSync('/tmp/cpclaw-skill-installer-');try{
 const body=JSON.stringify({schemaVersion:1,files:[{path:'demo/SKILL.md',body:'# v1'},{path:'demo/references/a.md',body:'资料'}]});const input={dataDir,skillId:'method',version:'1.0.0',packageBody:body,expectedSha256:digest(body),platforms:[process.platform+'-'+process.arch]};assert.ok(installSkillPackage(input).ok);assert.equal(readInstalledSkill(dataDir,'method','1.0.0').instruction,'# v1');
 const replacement='# 偷换版本';assert.equal(installSkillPackage({...input,packageBody:replacement,expectedSha256:digest(replacement)}).ok,false);assert.equal(readCurrentSkill(dataDir,'method').installed.version,'1.0.0');
 const v2='# v2';assert.ok(installSkillPackage({...input,version:'1.0.1',packageBody:v2,expectedSha256:digest(v2),activate:false}).ok);assert.equal(readCurrentSkill(dataDir,'method').installed.version,'1.0.0');assert.ok(activateInstalledSkill(dataDir,'method','1.0.1',digest(v2)).ok);assert.equal(readCurrentSkill(dataDir,'method').installed.version,'1.0.1');assert.ok(installSkillPackage(input).ok);assert.equal(readCurrentSkill(dataDir,'method').installed.version,'1.0.0');
 writeFileSync(join(dataDir,'skills/method/1.0.0/demo/references/a.md'),'篡改');assert.equal(readInstalledSkill(dataDir,'method','1.0.0',digest(body)).ok,false);assert.ok(installSkillPackage(input).ok,'损坏的附属文件可从同一发布包修复');assert.equal(readFileSync(join(dataDir,'skills/method/1.0.0/demo/references/a.md'),'utf8'),'资料');
}finally{rmSync(dataDir,{recursive:true,force:true});}});
test('路径段、符号链接和伪造指针被拒绝，正文中的正常省略号可用',()=>{const dataDir=mkdtempSync('/tmp/cpclaw-skill-path-');try{
 const body='# 方法\n例如 a..b 不构成文件路径';const input={dataDir,skillId:'safe',version:'1.0.0',packageBody:body,expectedSha256:digest(body),platforms:[process.platform+'-'+process.arch]};assert.ok(installSkillPackage(input).ok);assert.equal(installSkillPackage({...input,skillId:'/tmp/escape'}).ok,false);
 mkdirSync(join(dataDir,'elsewhere'));symlinkSync(join(dataDir,'elsewhere'),join(dataDir,'skills/linked'));assert.equal(installSkillPackage({...input,skillId:'linked'}).ok,false);
 writeFileSync(join(dataDir,'skills/safe/current.json'),JSON.stringify({skillId:'safe',version:'1.0.0',contentSha256:digest(body),path:'/tmp/forged'}));assert.equal(readCurrentSkill(dataDir,'safe').ok,false);
 const evil=JSON.stringify({schemaVersion:1,files:[{path:'../SKILL.md',body:'bad'}]});assert.equal(installSkillPackage({...input,version:'2.0.0',packageBody:evil,expectedSha256:digest(evil)}).ok,false);assert.equal(readFileSync(join(dataDir,'skills/safe/1.0.0/SKILL.md'),'utf8'),body);
}finally{rmSync(dataDir,{recursive:true,force:true});}});
