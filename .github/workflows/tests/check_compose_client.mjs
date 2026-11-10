// Runs inside the candidate image, using only synthetic state and local tools.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { checkAnythingLLM } from './check_anythingllm_client.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
const [operation, base] = process.argv.slice(2);
const bootstrap = 'compose-env-bootstrap';
const password = 'Synthetic-Compose-Password-123!';
const settingsFile = '/state/mcp_settings.json';
const stateFile = '/client/keys.json';
if (operation === 'seed') {
  const dependency = createRequire('/app/package.json');
  chmodSync('/state', 0o700);
  const settings = {
    mcpServers: Object.fromEntries(['fetch', 'grocy'].map((name) => [name, {
      command: '/usr/bin/env', args: ['node', '/wrapper/.github/workflows/tests/fixtures/echo-server.mjs', name],
    }])),
    users: [{ username: 'admin', password: dependency('bcryptjs').hashSync(password, 4), isAdmin: true }],
    groups: [], bearerKeys: [], retainedUnknown: { value: 'compose-state' },
    systemConfig: { routing: { enableBearerAuth: false, enableGlobalRoute: true } },
  };
  for (const [name, value] of [['mcp_settings.json', JSON.stringify(settings)],
    ['reference.json', JSON.stringify(settings)], ['.api_key', 'stale-volume-fixture'],
    ['.initialized', ''], ['mcp_settings.json.credentials.key', Buffer.alloc(32, 7).toString('base64')]]) {
    writeFileSync('/state/' + name, value, { mode: 0o600 });
  }
} else {
  assert(['initial', 'restart'].includes(operation) && base);
  const initialize = () => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'arm64-compose', version: '1.0' },
  } });
  async function request(route, token, body, extra = {}, method = 'POST') {
    return fetch(base + route, { method, headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  }
  async function rpc(response) {
    const text = await response.text();
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) return JSON.parse(text);
    for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) {
      const value = JSON.parse(line.slice(5)); if (value.id !== undefined) return value;
    }
    throw new Error('Missing JSON-RPC response');
  }
  async function exercise(token, server) {
    const route = '/mcp/' + server;
    const response = await request(route, token, initialize());
    assert.equal(response.status, 200);
    assert((await rpc(response)).result.serverInfo);
    const session = response.headers.get('mcp-session-id'); assert(session);
    const headers = { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' };
    try {
      const notification = await request(route, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
      assert([200, 202, 204].includes(notification.status)); await notification.arrayBuffer();
      const listed = await request(route, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, headers);
      assert.equal(listed.status, 200);
      const echo = (await rpc(listed)).result.tools.find((tool) => tool.name.includes('echo')); assert(echo);
      const called = await request(route, token, { jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: echo.name, arguments: { text: 'compose-proof' } } }, headers);
      assert.equal(called.status, 200);
      assert((await rpc(called)).result.content.some((item) => item.text === server + ':compose-proof'));
    } finally {
      const removed = await request(route, token, undefined, headers, 'DELETE'); await removed.arrayBuffer();
    }
  }
  for (const token of [undefined, 'wrong-key', 'stale-container-fixture', 'stale-volume-fixture']) {
    const denied = await request('/mcp/fetch', token, initialize());
    assert.equal(denied.status, 401); await denied.arrayBuffer();
  }
  const login = await request('/api/auth/login', bootstrap, { username: 'admin', password });
  assert.equal(login.status, 200);
  const jwt = (await login.json()).token; assert(jwt);
  let keys;
  if (operation === 'initial') {
    keys = {};
    for (const scope of ['all', 'fetch', 'grocy']) {
      const created = await request('/api/auth/keys', bootstrap, {
        name: 'Compose ' + scope, enabled: true, accessType: scope === 'all' ? 'all' : 'servers',
        ...(scope === 'all' ? {} : { allowedServers: [scope] }),
      }, { 'x-auth-token': jwt });
      assert.equal(created.status, 201);
      keys[scope] = (await created.json()).data; assert(keys[scope].token);
    }
    writeFileSync(stateFile, JSON.stringify(keys), { mode: 0o600 });
  } else keys = JSON.parse(readFileSync(stateFile, 'utf8'));
  for (const server of ['fetch', 'grocy']) {
    await exercise(bootstrap, server); await exercise(keys.all.token, server); await exercise(keys[server].token, server);
    const other = server === 'fetch' ? 'grocy' : 'fetch';
    const denied = await request('/mcp/' + other, keys[server].token, initialize());
    assert([401, 403].includes(denied.status)); await denied.arrayBuffer();
  }
  assert(readFileSync('/fixtures/anythingllm-LICENSE', 'utf8').includes('MIT License'));
  await checkAnythingLLM({ source: '/fixtures/anythingllm-hypervisor.cjs', upstream: '/app',
    storage: '/client', url: base + '/mcp/fetch', bootstrap, dashboard: keys.fetch.token, echoPrefix: 'fetch' });
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  const reference = JSON.parse(readFileSync('/state/reference.json', 'utf8'));
  assert.deepEqual(settings.retainedUnknown, reference.retainedUnknown);
  assert.deepEqual(settings.groups, reference.groups);
  assert.deepEqual(Object.keys(settings.mcpServers).sort(), ['fetch', 'grocy']);
  for (const [name, server] of Object.entries(reference.mcpServers)) {
    assert.equal(settings.mcpServers[name].command, server.command);
    assert.deepEqual(settings.mcpServers[name].args, server.args);
  }
  for (const user of reference.users) {
    const actual = settings.users.find((value) => value.username === user.username); assert(actual);
    for (const field of ['username', 'password', 'isAdmin']) assert.equal(actual[field], user[field]);
  }
  assert.equal(settings.systemConfig.routing.enableBearerAuth, false);
  assert.equal(settings.bearerKeys.length, 3);
  for (const scope of ['all', 'fetch', 'grocy']) {
    const actual = settings.bearerKeys.find((value) => value.id === keys[scope].id); assert(actual);
    assert.equal(actual.token, undefined); assert.equal(actual.enabled, true);
    assert.equal(actual.tokenHash, createHash('sha256').update(keys[scope].token).digest('hex'));
    assert.equal(actual.accessType, scope === 'all' ? 'all' : 'servers');
    if (scope !== 'all') assert.deepEqual(actual.allowedServers, [scope]);
  }
  assert.equal(readFileSync('/state/.api_key', 'utf8'), bootstrap);
  assert.equal(statSync('/state/.api_key').mode & 0o777, 0o600);
  assert.equal(readFileSync('/state/.port', 'utf8'), '3000');
  assert.equal(readFileSync('/state/mcp_settings.json.credentials.key', 'utf8'), Buffer.alloc(32, 7).toString('base64'));
  console.log('PASS: ARM64 Compose ' + operation + ' preserves bootstrap/native scopes and actual AnythingLLM key switching');
}
