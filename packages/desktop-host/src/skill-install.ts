import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { skillFiles } from '@cpclaw/contracts';
import type { SkillFile } from '@cpclaw/contracts';
import { hostLog } from './host-log.js';
export type SkillInstallFailure={ok:false;code:string;message:string};
export type InstalledSkill={skillId:string;version:string;contentSha256:string;path:string;entry?:string};
const fail=(code:string,message:string):SkillInstallFailure=>({ok:false,code,message});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const identifier=(s:string)=>/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,120}$/.test(s)&&!s.includes('..');
function paths(dataDir:string,skillId:string,version:string){
  if(!identifier(skillId)||!/^\d+\.\d+\.\d+$/.test(version))throw Error('Skill 标识或版本不合法');
  const root=resolve(dataDir,'skills');const base=join(root,skillId),target=join(base,version);
  for(const path of [resolve(dataDir),root,base,target])if(existsSync(path)&&(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink()))throw Error('安装目录不能是链接或非目录文件');
  return {root,base,target};
}
function unpack(body:string):SkillFile[]{
  if(Buffer.byteLength(body)>250000)throw Error('技能包超过上限');
  let parsed:unknown;try{parsed=JSON.parse(body);}catch{return [{path:'SKILL.md',body}];}
  if(parsed&&typeof parsed==='object'&&Reflect.get(parsed,'schemaVersion')===1){return skillFiles(JSON.stringify({files:Reflect.get(parsed,'files')}),'upload');}
  return [{path:'SKILL.md',body}];
}
function checkFiles(target:string,body:string):string {
  const files=unpack(body);
  for(const file of files){const path=join(target,file.path);let current=target;for(const part of file.path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw Error('技能文件包含链接');}if(!lstatSync(path).isFile()||readFileSync(path,'utf8')!==file.body)throw Error('技能文件校验失败');}
  const entry=files.find(f=>f.path.split('/').at(-1)==='SKILL.md');if(!entry)throw Error('缺少技能入口');return entry.path;
}
function point(base:string,installed:InstalledSkill){
  const temp=join(base,'.current-'+randomUUID()+'.json');
  try{writeFileSync(temp,JSON.stringify(installed)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,join(base,'current.json'));}finally{rmSync(temp,{force:true});}
}
export function readInstalledSkill(dataDir:string,skillId:string,version:string,expectedSha256?:string):{ok:true;installed:InstalledSkill;instruction:string}|SkillInstallFailure {
  try{
    const {target}=paths(dataDir,skillId,version);
    const raw=join(target,'.package');if(existsSync(raw)&&lstatSync(raw).isSymbolicLink())throw Error('技能包不能是链接');
    const body=existsSync(raw)?readFileSync(raw,'utf8'):readFileSync(join(target,'SKILL.md'),'utf8');
    const digest=hash(body);if(expectedSha256&&digest!==expectedSha256)throw Error('技能摘要不符');
    const entry=checkFiles(target,body);
    return {ok:true,installed:{skillId,version,contentSha256:digest,path:target,entry},instruction:readFileSync(join(target,entry),'utf8')};
  }catch(error){return fail('DIGEST',error instanceof Error?error.message:'技能制品校验失败');}
}
/** 暂存并验证所有文件，版本目录不可覆盖；仅在完整成功后原子切换指针。 */
export function installSkillPackage(input:{dataDir:string;skillId:string;version:string;expectedSha256:string;packageBody:string;platforms:string[];activate?:boolean}):{ok:true;installed:InstalledSkill;previous?:InstalledSkill}|SkillInstallFailure {
  if(!input.platforms.includes(process.platform+'-'+process.arch))return fail('PLATFORM','平台不兼容，拒绝安装');
  if(hash(input.packageBody)!==input.expectedSha256)return fail('DIGEST','摘要不符，拒绝安装');
  let staging='';
  try{
    const {base,target}=paths(input.dataDir,input.skillId,input.version);mkdirSync(base,{recursive:true,mode:0o700});
    const previousResult=readCurrentSkill(input.dataDir,input.skillId);const previous=previousResult.ok?previousResult.installed:undefined;
    const existing=existsSync(target);
    const verified=existing?readInstalledSkill(input.dataDir,input.skillId,input.version,input.expectedSha256):null;
    if(!verified?.ok){
      // 完整且自洽的版本不可被另一份内容覆盖；损坏版本可以从受认证的发布包恢复。
      if(existing&&readInstalledSkill(input.dataDir,input.skillId,input.version).ok)throw Error('固定版本内容不同，拒绝覆盖，请另建版本');
      const files=unpack(input.packageBody);staging=join(base,'.staging-'+randomUUID());mkdirSync(staging,{mode:0o700});
      for(const file of files){const path=join(staging,file.path);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,file.body,{mode:0o600,flag:'wx'});}
      writeFileSync(join(staging,'.package'),input.packageBody,{mode:0o600,flag:'wx'});checkFiles(staging,input.packageBody);
      const damaged=existing?join(base,'.damaged-'+randomUUID()):null;
      if(damaged)renameSync(target,damaged);
      try{renameSync(staging,target);staging='';}
      catch(error){if(damaged&&!existsSync(target))renameSync(damaged,target);throw error;}
      if(damaged)rmSync(damaged,{recursive:true,force:true});
    }
    const checked=readInstalledSkill(input.dataDir,input.skillId,input.version,input.expectedSha256);if(!checked.ok)throw Error(checked.message);
    if(input.activate!==false)point(base,checked.installed);hostLog(input.dataDir,'info','skill_installed',input.activate===false?'固定版本已准备':'固定版本已校验并切换',{skillId:input.skillId,version:input.version});
    return previous?{ok:true,installed:checked.installed,previous}:{ok:true,installed:checked.installed};
  }catch(error){hostLog(input.dataDir,'error','skill_install_failed','技能安装失败，保留原指针',{skillId:input.skillId});return fail('INSTALL',error instanceof Error?error.message:'技能安装失败');}
  finally{if(staging)rmSync(staging,{force:true,recursive:true});}
}
export function readCurrentSkill(dataDir:string,skillId:string):{ok:true;installed:InstalledSkill}|SkillInstallFailure {
  try{
    if(!identifier(skillId))throw Error('Skill 标识不合法');
    const pointer=join(dataDir,'skills',skillId,'current.json');if(lstatSync(pointer).isSymbolicLink())throw Error('安装指针不能为链接');
    const current=JSON.parse(readFileSync(pointer,'utf8')) as InstalledSkill;
    if(current.skillId!==skillId||typeof current.version!=='string'||typeof current.contentSha256!=='string')throw Error('安装指针损坏');
    const {target}=paths(dataDir,skillId,current.version);if(current.path!==target)throw Error('安装指针路径无效');
    const checked=readInstalledSkill(dataDir,skillId,current.version,current.contentSha256);return checked.ok?{ok:true,installed:checked.installed}:checked;
  }catch(error){return fail('NOT_FOUND',error instanceof Error?error.message:'尚未安装此技能');}
}

export function activateInstalledSkill(dataDir:string,skillId:string,version:string,digest:string):{ok:true;installed:InstalledSkill}|SkillInstallFailure {
  const checked=readInstalledSkill(dataDir,skillId,version,digest);if(!checked.ok)return checked;
  try{const {base}=paths(dataDir,skillId,version);point(base,checked.installed);return {ok:true,installed:checked.installed};}catch(e){return fail('INSTALL',e instanceof Error?e.message:'切换安装指针失败');}
}
