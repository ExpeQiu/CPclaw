import test from 'node:test';
import assert from 'node:assert/strict';
import { canOfferSkillDistill, hasSubstantialResult } from '../message-actions.mjs';

test('skill distill needs multi-round chat and substantial output', () => {
  const short = { role: 'assistant', state: 'done', content: '好的。', hasServiceSteps: 0 };
  const richService = { role: 'assistant', state: 'done', content: '已查询工单系统，找到待办工单。', hasServiceSteps: 1 };
  const richPlain = { role: 'assistant', state: 'done', content: 'x'.repeat(800), hasServiceSteps: 0 };
  const oneRound = [{ role: 'user', content: '做图' }, richService];
  const twoRounds = [...oneRound, { role: 'user', content: '再调一下' }, short];

  assert.equal(canOfferSkillDistill(oneRound, richService), false);
  assert.equal(canOfferSkillDistill(twoRounds, richService), true);
  assert.equal(canOfferSkillDistill(twoRounds, short), false);
  assert.equal(canOfferSkillDistill(twoRounds, richPlain), true);
  assert.equal(hasSubstantialResult(richService, { stepCount: 1 }), true);
  assert.equal(hasSubstantialResult(short, { stepCount: 0 }), false);
});
