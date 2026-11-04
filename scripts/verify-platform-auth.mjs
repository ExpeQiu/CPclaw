// 仅创建并撤销隔离验证会话，不打印口令、令牌或业务数据。
import assert from 'node:assert/strict';
const base = process.env.CPCLAW_PLATFORM_URL;
const employeeId = process.env.CPCLAW_TEST_EMPLOYEE_ID;
const credential = process.env.CPCLAW_TEST_PASSWORD;
if (!base || !employeeId || !credential) throw Error('需要平台地址、CPCLAW_TEST_EMPLOYEE_ID 和 CPCLAW_TEST_PASSWORD');
async function request(path, { body, token } = {}) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}
assert.equal((await request('/health')).status, 200);
const anonymous = await request('/v1/me/quota');
assert.equal(anonymous.status, 401);
assert.equal(anonymous.body.code, 'AUTH_REQUIRED');
const invalid = await request('/v1/me/quota', { token: 'invalid-verification-token' });
assert.equal(invalid.status, 401);
const loginBody = { employeeId, password: credential, deviceLabel: 'network-policy-verification' };
assert.equal((await request('/v1/session/login', { body: { ...loginBody, password: 'wrong-' + crypto.randomUUID() } })).status, 401);
const login = await request('/v1/session/login', { body: loginBody });
assert.equal(login.status, 200, '正确账号口令应登录成功');
const token = login.body.accessToken;
assert.equal(typeof token, 'string');
try {
  assert.equal((await request('/v1/me/quota', { token })).status, 200);
} finally {
  assert.equal((await request('/v1/session/logout', { token, body: {} })).status, 200);
}
assert.equal((await request('/v1/me/quota', { token })).status, 401);
console.log(JSON.stringify({ health: 200, anonymous: 401, invalidToken: 401, wrongCredential: 401, login: 200, authorized: 200, revokedAfterLogout: 401 }));
