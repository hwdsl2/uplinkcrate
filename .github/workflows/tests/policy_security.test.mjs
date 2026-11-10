import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  classifyPath, clientStateScope, credentialIdentity, hashToken, modeEnvironment,
  modeForSettings, nativeHeader, readSettings,
  resolveCredential, sameToken, selectMode, validateKeyState, validateToken,
} from '../../../policy/security.ts';

const bootstrap = 'custom-service-secret';
const state = () => ({
  mcpServers: {},
  systemConfig: { routing: { enableBearerAuth: false } },
  bearerKeys: [{ id: 'one', token: 'native-secret', kind: 'system', enabled: true, accessType: 'all' }],
  users: [],
});

test('bootstrap validation rejects malformed keys without disclosing their values', () => {
  for (const token of ['mcp-123', 'custom_key', 'a+/b==', 'test.secret~']) validateToken(token);
  for (const token of ['', 'a\nb', 'a\rb', 'a\n', 'a\r', 'a\r\n', 'a\u2028', 'a\u2029',
    'a b', 'a*b', 'a,b', '"secret"', 'é', 'x'.repeat(8193)]) {
    assert.throws(() => validateToken(token), (error) => !error.message.includes(token || 'NOT_A_SECRET'));
  }
  assert.equal(sameToken('one', 'one'), true);
  assert.equal(sameToken('one', 'two'), false);
  assert.equal(sameToken('one', 'one-longer'), false);
});

test('mode follows literal upstream database precedence without changing the environment', () => {
  const cases = [
    [{}, 'delegated'], [{ DB_URL: 'postgres://fixture' }, 'legacy'],
    [{ USE_DB: 'false', DB_URL: 'postgres://fixture' }, 'delegated'],
    [{ USE_DB: '', DB_URL: 'postgres://fixture' }, 'delegated'],
    [{ USE_DB: 'TRUE', DB_URL: 'postgres://fixture' }, 'delegated'],
    [{ USE_DB: 'true' }, 'legacy'], [{ HUB_MODE: 'hosted' }, 'legacy'],
    [{ BASE_PATH: '/hub' }, 'legacy'], [{ BASE_PATH: '/' }, 'delegated'],
    [{ BASE_PATH: ' //// ' }, 'delegated'], [{ BASE_PATH: 'hub///' }, 'legacy'],
    [{ MCPHUB_REPLICA_MODE: 'true' }, 'legacy'],
    [{ FORWARD_AUTH_ENABLED: 'true' }, 'legacy'],
  ];
  for (const [env, mode] of cases) {
    const before = structuredClone(env);
    assert.equal(selectMode(state(), env).mode, mode);
    assert.deepEqual(env, before);
  }
  const settings = state();
  settings.systemConfig.routing.skipAuth = true;
  assert.equal(selectMode(settings, {}).mode, 'legacy');
});

test('mode snapshot contains only startup decisions while live JSON changes remain enforced', () => {
  const snapshot = modeEnvironment({ USE_DB: 'false', DB_URL: 'postgres://PRIVATE_SECRET',
    HUB_MODE: 'self-hosted', BASE_PATH: '/', FORWARD_AUTH_SECRET: 'PRIVATE_SECRET' });
  assert.deepEqual(snapshot, { database: false, hosted: false, customBasePath: false,
    replica: false, advancedAuth: false });
  assert(!JSON.stringify(snapshot).includes('PRIVATE_SECRET'));
  assert.equal(modeForSettings(state(), snapshot).mode, 'delegated');
  assert.equal(selectMode(state(), { USE_DB: 'true' }).mode, 'legacy');
  const changed = state();
  changed.systemConfig.routing.skipAuth = true;
  assert.equal(modeForSettings(changed, snapshot).mode, 'legacy');
});

test('headers preserve a custom native header but reject reserved names', () => {
  assert.equal(nativeHeader({}), 'authorization');
  assert.equal(nativeHeader({ routing: { bearerAuthHeaderName: ' X-API-Key ' } }), 'x-api-key');
  for (const name of ['Host', 'Cookie', 'x-auth-token', 'Content-Type', 'Mcp-Session-Id',
    'MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name', 'X-MCPHub-State-Id',
    'X-Forwarded-For', 'Proxy-Authorization', 'Sec-WebSocket-Key', 'bad name']) {
    const settings = state();
    settings.systemConfig.routing.bearerAuthHeaderName = name;
    assert.throws(() => nativeHeader(settings.systemConfig));
    assert.equal(selectMode(settings, {}).mode, 'legacy');
  }
});

test('credential resolution rejects duplicate, combined and conflicting inputs', () => {
  const resolve = (headers, raw = [], header = 'authorization') =>
    resolveCredential(headers, raw, header, bootstrap);
  assert.deepEqual(resolve({ authorization: `Bearer ${bootstrap}` }), { token: bootstrap, bootstrap: true });
  assert.equal(resolve({ 'x-api-key': 'bearer native-secret' }, [], 'x-api-key').bootstrap, false);
  assert.equal(resolve({ authorization: `Bearer ${bootstrap}` }, [], 'x-api-key').bootstrap, true);
  assert.equal(resolve({ authorization: 'Bearer native-secret', 'x-api-key': 'Bearer native-secret' }, [], 'x-api-key').token, 'native-secret');
  for (const headers of [{}, { authorization: 'Basic native-secret' },
    { authorization: 'Bearer one, Bearer two' }, { authorization: ['Bearer one', 'Bearer two'] },
    { authorization: 'Bearer one', Authorization: 'Bearer two' }, { authorization: 'Bearer a\rb' }]) {
    assert.throws(() => resolve(headers));
  }
  assert.throws(() => resolve({ authorization: 'Bearer one' }, ['Authorization', 'Bearer one', 'authorization', 'Bearer two']));
  assert.throws(() => resolve({ authorization: 'Bearer one', 'x-api-key': 'Bearer two' }, [], 'x-api-key'));
  assert.throws(() => resolve({ authorization: 'Bearer native-secret' }, [], 'x-api-key'));
});

test('raw/hashed/disabled/legacy key collisions fail without modifying state', () => {
  const settings = state();
  const before = structuredClone(settings);
  validateKeyState(settings, bootstrap);
  assert.deepEqual(settings, before);
  for (const key of [
    { token: bootstrap }, { tokenHash: hashToken(bootstrap), enabled: false },
    { token: 'native-secret' }, { tokenHash: hashToken('native-secret') },
    { token: 'different', tokenHash: hashToken('native-secret') },
    { tokenHash: 'malformed' },
    { tokenHash: hashToken('another') + '\n' },
    { token: 'another', enabled: 'false' },
    { token: 'another', kind: 'administrator' },
    { token: 'another', accessType: 'unknown-scope' },
    { token: 'another', owner: { username: 'admin' } },
    { token: 'another', allowedServers: 'alpha,beta' },
  ]) {
    const candidate = state();
    candidate.bearerKeys.push(key);
    assert.throws(() => validateKeyState(candidate, bootstrap));
  }
  assert.throws(() => validateKeyState(state(), bootstrap, [hashToken('native-secret')]));
  assert.throws(() => validateKeyState({ mcpServers: {}, systemConfig: { routing: { bearerAuthKey: bootstrap } } }, bootstrap));
  validateKeyState({ mcpServers: {}, bearerKeys: [], systemConfig: { routing: { bearerAuthKey: bootstrap } } }, bootstrap);
});

test('route classification gives management priority and rejects ambiguous paths', () => {
  assert.equal(classifyPath('/health?check=yes'), 'health');
  for (const url of ['/api', '/api/mcp', '/API/sse', '/%61pi/mcp', '/api/mcp/fetch?x=1']) assert.equal(classifyPath(url), 'management');
  for (const url of ['/mcp', '/mcp/fetch', '/mcp/$smart/group', '/alice/mcp/fetch', '/sse/group',
    '/alice/messages?sessionId=123', '/mcp/space%20group', '/mcp/%E7%BE%A4%E7%BB%84']) {
    assert.equal(classifyPath(url), 'transport');
  }
  for (const url of ['/healthz', '/health/', '/he%61lth', '/.well-known/oauth-authorization-server', '/oauth/token', '/foo/bar/mcp']) {
    assert.equal(classifyPath(url), 'other');
  }
  for (const url of ['/api%2fmcp', '//mcp', '/a/../mcp', '/a/./mcp', '/a\\mcp', '/mcp\n',
    '/mcp/%00', '/mcp/%5c', '/mcp/%252f', '/mcp/%2e%2e', '/mcp/%zz']) assert.throws(() => classifyPath(url));
});

test('session identity is credential-bound, changes with scopes and ignores bootstrap user lifecycle', () => {
  const settings = state();
  const identity = credentialIdentity(settings, 'native-secret', false);
  assert.equal(identity, credentialIdentity(settings, 'native-secret', false));
  settings.bearerKeys[0].allowedServers = ['fetch'];
  assert.notEqual(identity, credentialIdentity(settings, 'native-secret', false));
  const bootstrapIdentity = credentialIdentity(settings, bootstrap, true);
  settings.users.push({ username: 'admin', isAdmin: true });
  assert.equal(bootstrapIdentity, credentialIdentity(settings, bootstrap, true));
  assert.notEqual(bootstrapIdentity, credentialIdentity(settings, 'rotated-secret', true));
  assert.throws(() => credentialIdentity(settings, 'unknown', false));
  assert.equal(clientStateScope(identity, 'alice', 'alpha'), clientStateScope(identity, 'alice', 'alpha'));
  assert.notEqual(clientStateScope(identity, 'alice', 'alpha'), clientStateScope(identity, 'bob', 'alpha'));
  assert.notEqual(clientStateScope(identity, 'alice', 'alpha'), clientStateScope(identity, 'alice', 'beta'));
  assert.notEqual(clientStateScope(identity, 'alice', 'alpha'), clientStateScope(bootstrapIdentity, 'alice', 'alpha'));
});

test('reading corrupt, missing or malformed settings is fail-closed and never rewrites them', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'uplink-policy-read-'));
  try {
    const file = path.join(scratch, 'settings.json');
    assert.throws(() => readSettings(file));
    for (const input of ['{"secret":"PRIVATE_SECRET",', 'null', '[]', '{}', '{"mcpServers":{},"bearerKeys":{}}',
      '{"mcpServers":{},"users":[{"username":"alice","isAdmin":"false"}]}',
      '{"mcpServers":{},"users":[{"username":"alice","userGroups":"admin"}]}']) {
      writeFileSync(file, input);
      assert.throws(() => readSettings(file), (error) => !error.message.includes('PRIVATE_SECRET'));
      assert.equal(readFileSync(file, 'utf8'), input);
    }
    writeFileSync(file, '\ufeff' + JSON.stringify(state()));
    assert.deepEqual(readSettings(file), state());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
