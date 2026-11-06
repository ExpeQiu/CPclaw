import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createChatService} from '../chat-service.mjs';
import {writeAccountSession} from '@cpclaw/desktop-host/account-session';
import {fixture} from './fixtures/unified.mjs';

test('archive keeps generated files and delete removes only that chat', async t => {
  const f = fixture(t, async i => {
    i.onAccepted('accepted');
    const saved = await i.pipeline.execute({name:'deliver_document', callId:'doc', arguments:{documentKey:'note', filename:'note.md', part:0, content:'正文', complete:true}});
    assert.equal(saved.ok, true, saved.message);
    return {finalResponse:'已保存'};
  });
  try {
    const project = await f.service.dispatch('project.create', f.actor, {folder:f.root});
    assert.equal(project.ok, true, project.message);
    const createdA = await f.service.dispatch('chat.create', f.actor, {projectId:project.project.id});
    const createdB = await f.service.dispatch('chat.create', f.actor, {projectId:project.project.id});
    const savedA = await f.send(createdA.chatId, '写A', 'req-a');
    const savedB = await f.send(createdB.chatId, '写B', 'req-b');
    assert.equal(savedA.state, 'done', savedA.error);
    assert.equal(savedB.state, 'done', savedB.error);
    const imageDir = join(realpathSync(f.root), 'service-artifacts', createHash('sha256').update(f.actor).digest('hex').slice(0, 16), createdA.chatId);
    mkdirSync(imageDir, {recursive:true});
    writeFileSync(join(imageDir, 'dreamina-pic.png'), Buffer.from([137, 80, 78, 71]));
    const archived = await f.service.dispatch('chat.archive', f.actor, {chatId:createdA.chatId});
    assert.equal(archived.archived, true);
    assert.equal(existsSync(savedA.artifact.path), true);
    assert.equal(existsSync(imageDir), true);
    const listed = await f.service.dispatch('chat.list', f.actor, {});
    assert.equal(listed.chats.find(chat => chat.id === createdA.chatId).archived, true);
    assert.equal((await f.service.dispatch('chat.history', f.actor, {chatId:createdA.chatId})).artifacts.length, 1);
    const blocked = await f.service.dispatch('chat.send', f.actor, {chatId:createdA.chatId, requestId:'req-more', text:'继续'});
    assert.equal(blocked.code, 'ARCHIVED');
    const removed = await f.service.dispatch('chat.delete', f.actor, {chatId:createdA.chatId});
    assert.equal(removed.ok, true, removed.message);
    assert.equal(existsSync(savedA.artifact.path), false);
    assert.equal(existsSync(imageDir), false);
    assert.equal(existsSync(savedB.artifact.path), true);
    const after = await f.service.dispatch('chat.list', f.actor, {});
    assert.equal(after.chats.some(chat => chat.id === createdA.chatId), false);
    assert.equal((await f.service.dispatch('document.list', f.actor, {chatId:createdB.chatId})).artifacts.length, 1);
    const log = readFileSync(join(f.root, 'logs', 'desktop-worker.log'), 'utf8');
    assert.match(log, /chat_archived/);
    assert.match(log, /chat_deleted/);
  } finally { f.stop(); }
});

test('rename keeps the chosen title after the next reply', async t => {
  const f = fixture(t, async i => { i.onAccepted('accepted'); return {finalResponse:'已回复'}; });
  try {
    const created = await f.service.dispatch('chat.create', f.actor, {});
    const renamed = await f.service.dispatch('chat.rename', f.actor, {chatId:created.chatId, title:'  周报讨论  '});
    assert.equal(renamed.ok, true, renamed.message);
    assert.equal(renamed.title, '周报讨论');
    await f.send(created.chatId, '这是一条很长的首条消息，不应当覆盖已经改过的名称', 'req-rename');
    const listed = await f.service.dispatch('chat.list', f.actor, {});
    assert.equal(listed.chats.find(chat => chat.id === created.chatId).title, '周报讨论');
    assert.equal((await f.service.dispatch('chat.rename', f.actor, {chatId:created.chatId, title:'  '})).code, 'SCHEMA_INVALID');
    assert.equal((await f.service.dispatch('chat.rename', f.actor, {chatId:'missing', title:'名称'})).code, 'NOT_FOUND');
    const log = readFileSync(join(f.root, 'logs', 'desktop-worker.log'), 'utf8');
    assert.match(log, /chat_renamed/);
    assert.equal(log.includes('周报讨论'), false);
  } finally { f.stop(); }
});

test('existing chats gain an archived flag without changing their rows', async t => {
  const root = mkdtempSync('/tmp/cpclaw-archive-migrate-');
  const db = new DatabaseSync(join(root, 'chat.sqlite'));
  db.exec("CREATE TABLE chats(id TEXT PRIMARY KEY, actor TEXT NOT NULL, title TEXT NOT NULL, updated INTEGER NOT NULL); INSERT INTO chats VALUES('old','kernel-user','旧对话',1);");
  db.close();
  writeAccountSession(root, {schemaVersion:1, employeeId:'kernel-user', sessionId:'fixture', refreshToken:'fixture-refresh'}, {makeCurrent:true});
  writeFileSync(join(root, 'desktop-connection.json'), JSON.stringify({platformUrl:'https://fixture.invalid'}));
  const service = createChatService(root, () => {});
  try {
    const listed = await service.dispatch('chat.list', 'kernel-user', {});
    assert.equal(listed.chats.find(chat => chat.id === 'old').archived, false);
    assert.equal(listed.chats.find(chat => chat.id === 'old').title, '旧对话');
  } finally { service.stop(); rmSync(root, {recursive:true, force:true}); }
});
