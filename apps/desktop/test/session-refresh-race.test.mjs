import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPlatform, fixtureEmployees } from '@cpclaw/platform';
import { writeAccountSession, readCurrentAccountSession } from '@cpclaw/desktop-host/account-session';
import { createChatService } from '../chat-service.mjs';
import { resetSessionRefresher } from '../session-refresh.mjs';

/**
 * 回归：刷新令牌是单次使用语义，桌面端并发续期会互相作废并丢失最新令牌。
 *
 * 复现路径与线上故障一致：
 *   技能市场首屏同时触发多个 market.call，每个都先续期一次；
 *   平台每次续期都轮换 refresh_hash，旧令牌立即作废；
 *   未做单飞收敛时，后到的续期拿到 401，且最新令牌从未写回本机，
 *   于是本机令牌与平台永久不一致，后续所有请求都是「登录凭证无效」。
 */
function setup(t, { desktopDir, platformDir }) {
  const opened = openPlatform({
    dataDir: platformDir, port: 0, listenHost: '127.0.0.1',
    sessionSecret: 'race-test-secret-0123456789abcdef', accessTtlSec: 3600, refreshTtlSec: 7200,
    seed: { kind: 'fixture', employees: fixtureEmployees }, keyPresent: false, now: () => Date.now(),
  });
  assert.ok(opened.ok);
  const app = opened.app;
  const login = app.login({ employeeId: 'employee-a', password: 'fixture-employee-a', deviceLabel: 'race-test' });
  assert.ok(login.ok);
  const admin = app.login({ employeeId: 'admin', password: 'fixture-admin', deviceLabel: 'race-test-admin' });
  assert.ok(admin.ok);

  writeAccountSession(desktopDir, {
    schemaVersion: 1, employeeId: 'employee-a', sessionId: login.sessionId, refreshToken: login.refreshToken,
  }, { makeCurrent: true });
  writeFileSync(join(desktopDir, 'desktop-connection.json'), JSON.stringify({ platformUrl: 'https://race-fixture.invalid' }));

  let refreshCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.endsWith('/v1/session/refresh')) {
      refreshCalls += 1;
      // 真实平台语义：凭当前令牌续期，轮换出全新令牌；旧令牌立即作废。
      const { refreshToken } = JSON.parse(init.body);
      const result = await app.refresh(refreshToken);
      if (!result.ok) {
        return Response.json({ ok: false, code: result.code, message: result.message }, { status: 401 });
      }
      return Response.json({
        ok: true, employeeId: result.employeeId, sessionId: result.sessionId,
        refreshToken: result.refreshToken, accessToken: result.accessToken,
      });
    }
    if (url.endsWith('/v1/market')) {
      const { action, input = {} } = JSON.parse(init.body);
      const result = app.market(login.accessToken, action, input);
      if (!result.ok) return Response.json({ ok: false, code: result.code, message: result.message }, { status: 400 });
      return Response.json(result);
    }
    throw Error('未知测试请求 ' + url);
  });

  return { app, login, admin, refreshCalls: () => refreshCalls };
}

test('并发续期只发一次请求，本机令牌始终等于平台有效令牌', async t => {
  const platformDir = mkdtempSync('/tmp/cpclaw-race-platform-');
  const desktopDir = mkdtempSync('/tmp/cpclaw-race-desktop-');
  const f = setup(t, { platformDir, desktopDir });
  const service = createChatService(desktopDir, () => {});
  try {
    // 技能市场首屏：refresh + renderItems 会并发触发多个市场请求。
    const results = await Promise.all([
      service.dispatch('market.call', 'employee-a', { action: 'list', input: { summary: true } }),
      service.dispatch('market.call', 'employee-a', { action: 'catalog', input: { scope: 'market' } }),
      service.dispatch('market.call', 'employee-a', { action: 'list', input: { summary: true } }),
      service.dispatch('chat.services', 'employee-a', {}),
      service.dispatch('market.call', 'employee-a', { action: 'catalog', input: { scope: 'mine' } }),
    ]);
    for (const r of results) assert.equal(r.ok, true, r.message);

    // 关键断言：并发期间只应发出一次续期请求（单飞收敛）。
    assert.equal(f.refreshCalls(), 1, `并发续期应收敛为 1 次，实际 ${f.refreshCalls()} 次`);

    // 关键断言：本机保存的令牌必须仍是平台上的有效令牌。
    const stored = readCurrentAccountSession(desktopDir);
    assert.equal(stored.ok, true);
    assert.equal(stored.session.employeeId, 'employee-a');
    const again = await f.app.refresh(stored.session.refreshToken);
    assert.equal(again.ok, true, '本机令牌已被平台作废，会话将持续报「登录凭证无效」');
  } finally {
    service.stop();
    f.app.close();
    resetSessionRefresher(desktopDir);
    rmSync(platformDir, { recursive: true, force: true });
    rmSync(desktopDir, { recursive: true, force: true });
  }
});

test('续期失败后不写坏本机会话，可重新登录恢复', async t => {
  const platformDir = mkdtempSync('/tmp/cpclaw-race-platform2-');
  const desktopDir = mkdtempSync('/tmp/cpclaw-race-desktop2-');
  const f = setup(t, { platformDir, desktopDir });
  const service = createChatService(desktopDir, () => {});
  try {
    // 先做一次成功续期，确认写回正常。
    const first = await service.dispatch('market.call', 'employee-a', { action: 'list', input: { summary: true } });
    assert.equal(first.ok, true, first.message);
    const before = readCurrentAccountSession(desktopDir);
    assert.equal(before.ok, true);

    // 平台侧撤销该会话后续期必然失败。
    const revoked = f.app.revoke(f.admin.accessToken, before.session.sessionId);
    assert.equal(revoked.ok, true, revoked.message);
    const failed = await service.dispatch('market.call', 'employee-a', { action: 'list', input: { summary: true } });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /凭证|过期|撤销|续期/);

    // 失败不应把本机会话改写成残缺内容。
    const after = readCurrentAccountSession(desktopDir);
    assert.equal(after.ok, true, after.message);
    assert.equal(after.session.refreshToken, before.session.refreshToken);
  } finally {
    service.stop();
    f.app.close();
    resetSessionRefresher(desktopDir);
    rmSync(platformDir, { recursive: true, force: true });
    rmSync(desktopDir, { recursive: true, force: true });
  }
});
