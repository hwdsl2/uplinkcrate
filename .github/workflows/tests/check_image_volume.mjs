import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const [operation, phase, base, cleanup] = process.argv.slice(2);
const file = '/state/mcp_settings.json';
const bootstrap = 'custom-image-upgrade-bootstrap';
const token = 'existing-dashboard-key-before-upgrade';
const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const key = { id: 'preserved-native-key', name: 'Existing key', token, kind: 'system',
  enabled: true, accessType: 'all', allowedGroups: [], allowedServers: [] };

if (operation === 'seed') {
  chmodSync('/state', 0o700);
  const require = createRequire('/app/package.json');
  const settings = {
    mcpServers: { alpha: { command: '/usr/bin/env', args: ['node',
      '/wrapper/.github/workflows/tests/fixtures/echo-server.mjs', 'alpha'] } },
    users: [{ username: 'admin', password: require('bcryptjs').hashSync('Synthetic-Password-123!', 4), isAdmin: true }],
    groups: [{ id: '11111111-1111-4111-8111-111111111111', name: 'preserved-group', servers: ['alpha'] }],
    bearerKeys: [key], systemConfig: { routing: { enableBearerAuth: false, enableGlobalRoute: true } },
    retainedUnknown: { value: 'preserve-current-data' },
  };
  for (const [name, value] of [['mcp_settings.json', JSON.stringify(settings)],
    ['fixture-reference.json', JSON.stringify(settings)], ['.api_key', bootstrap],
    ['.initialized', ''], ['mcp_settings.json.credentials.key', encryptionKey]]) {
    writeFileSync(`/state/${name}`, value, { mode: 0o600 });
  }
} else if (operation === 'check') {
  // Boundary tests assert their mount/directory/symlink behavior separately.
  if (cleanup !== 'boundary') assert.equal(existsSync('/state/.Caddyfile'), phase !== 'new',
    'Old startup must generate the config; the candidate must remove it and keep it absent after restart');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  const reference = JSON.parse(readFileSync('/state/fixture-reference.json', 'utf8'));
  assert.deepEqual(settings.retainedUnknown, reference.retainedUnknown);
  assert.equal(settings.users.length, reference.users.length);
  for (const user of reference.users) {
    const actual = settings.users.find((value) => value.username === user.username);
    assert(actual);
    for (const field of ['username', 'password', 'isAdmin']) assert.deepEqual(actual[field], user[field]);
  }
  assert.equal(settings.groups.length, reference.groups.length);
  for (const group of reference.groups) {
    const actual = settings.groups.find((value) => value.id === group.id);
    assert(actual);
    for (const field of ['id', 'name', 'servers']) assert.deepEqual(actual[field], group[field]);
  }
  assert.equal(settings.mcpServers.alpha.command, reference.mcpServers.alpha.command);
  assert.deepEqual(settings.mcpServers.alpha.args, reference.mcpServers.alpha.args);
  assert.equal(settings.systemConfig.routing.enableBearerAuth, false);
  assert.equal(readFileSync('/state/.api_key', 'utf8'), bootstrap);
  assert.equal(readFileSync('/state/mcp_settings.json.credentials.key', 'utf8'), encryptionKey);
  assert.equal(settings.bearerKeys.length, 1);
  for (const field of ['id', 'name', 'kind', 'enabled', 'accessType', 'allowedGroups', 'allowedServers']) {
    assert.deepEqual(settings.bearerKeys[0][field], key[field]);
  }
  if (phase === 'old') assert.equal(settings.bearerKeys[0].token, token);
  else {
    assert.equal(settings.bearerKeys[0].token, undefined);
    assert.equal(settings.bearerKeys[0].tokenHash, createHash('sha256').update(token).digest('hex'));
  }
} else if (operation === 'probe') {
  async function request(credential, body, headers = {}, method = 'POST', route = '/mcp/alpha') {
    return fetch(base + route, { method, headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  }
  async function rpc(response) {
    const text = await response.text();
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return JSON.parse(text);
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        const value = JSON.parse(line.slice(5));
        if (value.id !== undefined) return value;
      }
    }
    throw new Error('Missing JSON-RPC response');
  }
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'volume-upgrade', version: '1.0' },
  } };
  for (const credential of [undefined, 'wrong-synthetic-key']) {
    const response = await request(credential, initialize);
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  }
  for (const credential of [bootstrap, token]) {
    const initialized = await request(credential, initialize);
    if (credential === token && phase !== 'new') {
      assert.equal(initialized.status, 401, 'Old proxy must retain bootstrap-only behavior');
      await initialized.arrayBuffer();
      continue;
    }
    assert.equal(initialized.status, 200);
    assert((await rpc(initialized)).result.serverInfo);
    const session = initialized.headers.get('mcp-session-id');
    assert(session);
    const headers = { 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' };
    try {
      const notification = await request(credential, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
      assert([200, 202, 204].includes(notification.status));
      await notification.arrayBuffer();
      const tools = await request(credential, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, headers);
      assert.equal(tools.status, 200);
      const echo = (await rpc(tools)).result.tools.find((tool) => tool.name.includes('echo'));
      assert(echo, 'The retained server must expose its tool');
      const called = await request(credential, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
        name: echo.name, arguments: { text: 'upgrade-proof' },
      } }, headers);
      assert.equal(called.status, 200);
      const result = (await rpc(called)).result;
      assert(!result.isError && result.content.some((item) => item.text === 'alpha:upgrade-proof'),
        'The retained server must remain callable with the accepted credential');
    } finally {
      const removed = await request(credential, undefined, headers, 'DELETE');
      await removed.arrayBuffer();
    }
  }
  const management = await request(bootstrap, undefined, {}, 'GET', '/api/users');
  assert([401, 403].includes(management.status), 'Bootstrap alone must not grant dashboard administrator access');
  await management.arrayBuffer();
} else throw new Error('Unknown disposable-volume operation');
