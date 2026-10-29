import test from 'node:test';
import assert from 'node:assert/strict';
import {getInternalSkill,isInternalSkillId,listInternalSkills} from '../internal-skills.mjs';

test('内部技能目录随内核提供且身份稳定',()=>{
 const items=listInternalSkills();
 assert.ok(items.length>=2);
 assert.ok(items.every(x=>x.source==='internal'&&x.owner==='kernel'&&isInternalSkillId(x.id)));
 assert.equal(getInternalSkill(items[0].id)?.title,items[0].title);
 assert.equal(listInternalSkills({q:'澄清'}).length,1);
 assert.equal(isInternalSkillId('market-uuid'),false);
});
