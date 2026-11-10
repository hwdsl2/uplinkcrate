// Source-build design proof, not a substitute for the Docker/bridge CI gates.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAnythingLLM } from './check_anythingllm_client.mjs';

const [upstreamArg, caddy, anythingLLMSource] = process.argv.slice(2);
assert(upstreamArg && caddy && anythingLLMSource,
  'Usage: node check_policy_runtime.mjs <built-upstream-root> <caddy-binary> <pinned-anythingllm-source>');
const upstream = path.resolve(upstreamArg);
const directory = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.resolve(directory, '../../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'uplink-policy-runtime-'));
const settingsFile = path.join(scratch, 'settings.json');
let bootstrap = 'custom-integration-key-without-generated-prefix';
const keyFile = path.join(scratch, 'bootstrap');
const integrityFile = path.join(scratch, 'integrity.json');
const runtime = path.join(scratch, 'run');
const helper = path.join(upstream, 'dist/uplinkPolicy.js');
let native, proxy;
let logs = '';
const streams = new Set();

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: upstream, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}

function parseRpc(body) {
  if (!body.startsWith('event:') && !body.startsWith('data:')) return JSON.parse(body);
  const frames = body.split(/\r?\n\r?\n/).flatMap((frame) =>
    frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()));
  for (const frame of frames) {
    try { const value = JSON.parse(frame); if (value.id !== undefined) return value; } catch { /* another event */ }
  }
  throw new Error('No JSON-RPC response in SSE frames');
}

try {
  const internalPort = await availablePort(), publicPort = await availablePort();
  const base = `http://127.0.0.1:${publicPort}`;
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    NODE_ENV: 'production', PORT: String(internalPort), USE_DB: 'false',
    MCPHUB_SETTING_PATH: settingsFile, JWT_SECRET: 'synthetic-test-secret-never-used-in-production-0123456789',
    MCP_DISABLE_USAGE_COUNTS: '1', XDG_CONFIG_HOME: path.join(scratch, 'config'),
    ALLOWED_ORIGINS: 'https://approved.invalid',
    XDG_DATA_HOME: path.join(scratch, 'data'), XDG_CACHE_HOME: path.join(scratch, 'cache'),
  };
  const require = createRequire(path.join(upstream, 'package.json'));
  const password = 'Synthetic-Password-123!';
  const passwordHash = require('bcryptjs').hashSync(password, 4);
  const fixture = path.join(directory, 'fixtures/echo-server.mjs');
  const settings = {
    mcpServers: Object.fromEntries(['alpha', 'beta'].map((name) => [name, {
      command: process.execPath, args: [fixture, name], owner: name === 'alpha' ? 'alice' : 'admin',
      visibility: 'private',
    }])),
    users: [{ username: 'admin', password: passwordHash, isAdmin: true },
      { username: 'alice', password: passwordHash, isAdmin: false }],
    groups: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'only-alpha', servers: ['alpha'], owner: 'alice' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'mixed', servers: ['alpha', 'beta'], owner: 'admin' },
      { id: '44444444-4444-4444-8444-444444444444', name: 'space group', servers: ['alpha'], owner: 'alice' },
    ],
    bearerKeys: [{ id: 'legacy-key', name: 'legacy', token: 'existing-raw-native-key', enabled: true,
      kind: 'system', accessType: 'all', allowedGroups: [], allowedServers: [] }],
    systemConfig: { routing: { enableBearerAuth: false, enableGlobalRoute: true, enableGroupNameRoute: true } },
    retainedUnknown: { value: 'must survive upstream migration' },
  };
  writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  writeFileSync(keyFile, bootstrap, { mode: 0o600 });
  writeFileSync(integrityFile, run(process.execPath, [path.join(wrapper, 'policy/apply.mjs'), upstream, '--manifest'], env), { mode: 0o600 });
  const status = path.join(runtime, 'status.json');
  function prepare(previousKeyFile) {
    run(process.execPath, [helper, 'prepare', keyFile, settingsFile, runtime, integrityFile,
      ...(previousKeyFile ? [previousKeyFile] : [])], env);
    env.UPLINK_BOOT_FILE = path.join(runtime, 'boot.json');
  }
  const proxyFile = path.join(scratch, 'caddy.json');
  async function startNative() {
    assert(!existsSync(status), 'Prepare must remove stale readiness records before launch');
    native = spawn(process.execPath, ['dist/index.js'], { cwd: upstream, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [native.stdout, native.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk).slice(-24000); });
    for (let i = 0; i < 200 && !existsSync(status) && native.exitCode === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(existsSync(status), `Patched process failed readiness: ${logs}`);
    run(process.execPath, [helper, 'verify-ready', String(native.pid)], env);
  }
  async function startProxy() {
    const config = JSON.parse(run(process.execPath, [helper, 'proxy', String(publicPort), String(internalPort)], env));
    config.apps.http.servers.uplink.listen = [`127.0.0.1:${publicPort}`];
    writeFileSync(proxyFile, JSON.stringify(config), { mode: 0o600 });
    run(caddy, ['validate', '--config', proxyFile], env);
    proxy = spawn(caddy, ['run', '--config', proxyFile], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [proxy.stdout, proxy.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk).slice(-24000); });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* not listening yet */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Public proxy did not become ready');
  }
  prepare();
  await startNative();
  await startProxy();
  const staleHelperEnvironment = { ...env, USE_DB: 'true', HUB_MODE: 'hosted', BASE_PATH: '/stale' };
  assert.match(run(process.execPath, [helper, 'status'], staleHelperEnvironment), /Authentication: delegated/,
    'Status must use the resolved startup mode, not stale docker-exec environment');

  let nativeAuthHeader = 'Authorization';
  const authentication = (token) => token ? {
    [token === bootstrap ? 'Authorization' : nativeAuthHeader]: `Bearer ${token}`,
  } : {};
  async function request(route, token, body, extras = {}, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, {
      method, headers: { ...authentication(token),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Accept: 'application/json, text/event-stream', ...extras },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }
  async function initialize(token, route = '/mcp/alpha', extras = {}) {
    const response = await request(route, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'uplink-proof', version: '1.0.0' },
    } }, extras);
    assert.equal(response.status, 200, response.text);
    assert(parseRpc(response.text).result.serverInfo);
    const session = response.headers.get('mcp-session-id');
    assert(session, 'Legacy initialize must return a session');
    const headers = { ...extras, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-03-26' };
    const initialized = await request(route, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
    assert.equal(initialized.status, 202, initialized.text);
    return { session, headers, route, token };
  }
  async function list(session, token = session.token) {
    return request(session.route, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session.headers);
  }
  const initBody = () => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'uplink-proof', version: '1' },
  } });
  function changeSettings(change) {
    const value = JSON.parse(readFileSync(settingsFile, 'utf8'));
    change(value);
    writeFileSync(settingsFile, JSON.stringify(value));
  }
  async function raw(route, pairs) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(base + route, { method: 'GET', headers: ['Host', new URL(base).host, ...pairs], timeout: 5000 }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Raw request timed out')));
      req.end();
    });
  }
  async function openSse(token, route = '/sse/alpha') {
    const controller = new AbortController();
    streams.add(controller);
    const response = await fetch(base + route, {
      headers: { ...authentication(token), Accept: 'text/event-stream' },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    });
    assert.equal(response.status, 200);
    assert(response.headers.get('content-type').startsWith('text/event-stream'));
    const reader = response.body.getReader();
    let buffer = '';
    async function nextFrame() {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        assert(!chunk.done, 'SSE stream unexpectedly ended');
        buffer = (buffer + new TextDecoder().decode(chunk.value)).replace(/\r\n/g, '\n');
      }
      const index = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      return frame;
    }
    const frame = await nextFrame();
    assert(frame.includes('event: endpoint'));
    const endpoint = new URL(frame.split('\n').find((line) => line.startsWith('data:')).slice(5).trim(), base);
    assert.equal(endpoint.origin, base);
    return { endpoint: endpoint.pathname + endpoint.search, nextFrame, controller };
  }

  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/mcp/alpha')).status, 401);
  assert.equal((await request('/mcp/alpha', 'wrong-key')).status, 401);
  const preflight = await request('/mcp/alpha', undefined, undefined, {
    Origin: 'https://approved.invalid', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'Authorization, Content-Type, Mcp-Session-Id',
  }, 'OPTIONS');
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://approved.invalid');
  for (const requested of ['Authorization,authorization', 'Authorization,,Content-Type', 'bad header']) {
    assert.equal((await request('/mcp/alpha', undefined, undefined, {
      Origin: 'https://approved.invalid', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': requested,
    }, 'OPTIONS')).status, 405);
  }
  const browserDenied = await request('/mcp/alpha', undefined, undefined, { Origin: 'https://approved.invalid' });
  assert.equal(browserDenied.status, 401);
  assert.equal(browserDenied.headers.get('access-control-allow-origin'), 'https://approved.invalid');
  assert.equal((await request('/mcp/alpha', undefined, undefined, {
    Origin: 'https://disallowed.invalid', 'Access-Control-Request-Method': 'POST',
  }, 'OPTIONS')).status, 403);
  assert.equal((await request('/mcp/alpha', bootstrap, {}, {}, 'PUT')).status, 405);
  assert.equal((await request('/api/servers', bootstrap)).status, 401, 'Bootstrap must not grant admin login');
  const login = await request('/api/auth/login', bootstrap, { username: 'admin', password });
  assert.equal(login.status, 200, login.text);
  const adminHeaders = { 'x-auth-token': JSON.parse(login.text).token };
  run(process.execPath, [path.join(directory, 'check_query_boundary.mjs'), upstream,
    adminHeaders['x-auth-token']], env);
  async function createKey(fields) {
    const response = await request('/api/auth/keys', bootstrap, { enabled: true, ...fields }, adminHeaders);
    assert.equal(response.status, 201, response.text);
    const key = JSON.parse(response.text).data;
    assert(key.token);
    return key;
  }
  assert(adminHeaders['x-auth-token']);
  assert.equal((await request('/api/servers', bootstrap, undefined, adminHeaders)).status, 200);
  const logStream = await fetch(base + '/api/logs/stream?token=' + encodeURIComponent(adminHeaders['x-auth-token']), {
    headers: { ...authentication(bootstrap), Accept: 'text/event-stream' }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(logStream.status, 200, 'Management log-stream query JWT must survive bootstrap-header stripping');
  assert(logStream.headers.get('content-type')?.startsWith('text/event-stream'));
  await logStream.body.cancel();
  const disable = await request('/api/system-config', bootstrap,
    { routing: { enableBearerAuth: false } }, adminHeaders, 'PUT');
  assert.equal(disable.status, 400, disable.text);
  assert(disable.text.includes('cannot be disabled'));
  for (const unsafe of [{ routing: { skipAuth: true } },
    { routing: { bearerAuthHeaderName: 'Cookie' } }, { auth: { forwardAuth: { enabled: true } } }]) {
    const denied = await request('/api/system-config', bootstrap, unsafe, adminHeaders, 'PUT');
    assert.equal(denied.status, 400, denied.text);
  }
  const rename = await request('/api/system-config', bootstrap,
    { dashboardName: 'Disposable auth proof' }, adminHeaders, 'PUT');
  assert.equal(rename.status, 200, rename.text);
  assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).systemConfig.routing.enableBearerAuth, false);
  const beforeReset = readFileSync(settingsFile, 'utf8');
  const resetOutput = path.join(scratch, 'reset-projection.json');
  run(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    const { SystemConfigDaoImpl } = await import('./dist/dao/SystemConfigDao.js');
    const result = await new SystemConfigDaoImpl().reset();
    writeFileSync(process.argv[1], JSON.stringify(result), { mode: 0o600 });
  `, resetOutput], env);
  const resetProjection = JSON.parse(readFileSync(resetOutput, 'utf8'));
  assert.equal(resetProjection.routing.enableBearerAuth, true);
  assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).systemConfig.routing.enableBearerAuth, false,
    'Native DAO reset must retain the underlying legacy flag for rollback');
  writeFileSync(settingsFile, beforeReset);

  const created = await request('/api/auth/keys', bootstrap, {
    name: 'Dashboard scoped fixture', accessType: 'servers', allowedServers: ['alpha'], enabled: true,
  }, adminHeaders);
  assert.equal(created.status, 201, created.text);
  const dashboard = JSON.parse(created.text).data;
  assert(dashboard.token, 'Dashboard create must return a usable one-time token');
  const bootstrapSession = await initialize(bootstrap);
  run(process.execPath, [path.join(wrapper, 'policy/probe.mjs'), String(publicPort), 'alpha', keyFile], env);
  const dashboardSession = await initialize(dashboard.token);
  assert.equal((await list({ ...dashboardSession, route: '/mcp' })).status, 200,
    'A scoped session may continue through the global URL using its stored group');
  assert.equal((await list({ ...dashboardSession, route: '/mcp/beta' })).status, 401,
    'A continuation URL cannot broaden the native scope');
  const legacySession = await initialize('existing-raw-native-key');
  await checkAnythingLLM({ source: anythingLLMSource, upstream, storage: path.join(scratch, 'anythingllm'),
    url: base + '/mcp/alpha', bootstrap, dashboard: dashboard.token });
  console.log('PASS: actual pinned AnythingLLM MCP client swaps from bootstrap to dashboard key and lists/calls the harmless tool');
  for (const session of [bootstrapSession, dashboardSession, legacySession]) {
    const response = await list(session);
    assert.equal(response.status, 200, response.text);
    assert(parseRpc(response.text).result.tools.some((tool) => tool.name.includes('echo')));
  }
  assert.equal((await list(bootstrapSession, dashboard.token)).status, 403, 'Dashboard key must not reuse bootstrap session');
  assert.equal((await list(dashboardSession, bootstrap)).status, 403, 'Bootstrap must not reuse dashboard session');
  assert.equal((await request('/api/servers', dashboard.token)).status, 401);
  assert.equal((await request('/mcp/beta', dashboard.token, { jsonrpc: '2.0', id: 5, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'denied', version: '1' },
  } })).status, 401, 'Server-scoped key must not reach beta');
  assert.equal((await request('/mcp/alpha', bootstrap, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { ...bootstrapSession.headers, Origin: 'https://disallowed.invalid' })).status, 403);
  for (const Origin of [base, 'https://approved.invalid']) {
    assert.equal((await request('/mcp/alpha', bootstrap,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { ...bootstrapSession.headers, Origin })).status, 200);
  }
  for (const route of ['/api/mcp/alpha', '/API/mcp/alpha', '/healthz', '/health/', '/.well-known/oauth-authorization-server']) {
    assert.equal((await request(route, dashboard.token)).status, 401, `Unexpected management/public exemption: ${route}`);
  }
  for (const route of ['/api%2fmcp/alpha', '/%61pi/mcp/alpha', '//mcp/alpha', '/mcp%2falpha']) {
    assert([400, 401].includes((await raw(route, ['Authorization', `Bearer ${dashboard.token}`])).status), route);
  }
  assert.equal((await raw('/mcp/alpha', ['Authorization', `Bearer ${bootstrap}`, 'Authorization', `Bearer ${bootstrap}`])).status, 401);
  const groupKey = await createKey({ name: 'group', accessType: 'groups', allowedGroups: ['only-alpha', 'space group'] });
  const customKey = await createKey({ name: 'custom', accessType: 'custom', allowedGroups: [], allowedServers: ['alpha'] });
  const excludeKey = await createKey({ name: 'exclude', accessType: 'exclude', excludedServers: ['beta'] });
  const allKey = await createKey({ name: 'all', accessType: 'all' });
  const aliceKey = await createKey({ name: 'alice', kind: 'user', owner: 'alice' });
  const adminKey = await createKey({ name: 'admin', kind: 'user', owner: 'admin' });
  const adminQuery = '?token=' + encodeURIComponent(adminHeaders['x-auth-token']);
  const betaControl = await initialize(allKey.token, '/mcp/beta');
  const betaCatalog = await list(betaControl);
  assert.equal(betaCatalog.status, 200, betaCatalog.text);
  const betaEcho = parseRpc(betaCatalog.text).result.tools.find((tool) => tool.name.includes('echo'));
  assert(betaEcho, 'The private beta fixture must have a working tool');
  const callEcho = (session, name, text) => request(session.route, session.token, {
    jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name, arguments: { text } },
  }, session.headers);
  const betaProof = await callEcho(betaControl, betaEcho.name, 'private-control');
  assert.equal(betaProof.status, 200, betaProof.text);
  assert(parseRpc(betaProof.text).result.content.some((item) => item.text === 'beta:private-control'));
  // A valid user key may initialize an empty server route. Native ownership
  // filtering applies to the actual tool listing and call, not initialize.
  for (const [label, query, extras] of [
    ['no JWT', '', {}],
    ['administrator header JWT', '', adminHeaders],
    ['administrator query JWT', adminQuery, {}],
  ]) {
    const privateSession = await initialize(aliceKey.token, '/mcp/beta' + query, extras);
    const hidden = await list(privateSession);
    assert.equal(hidden.status, 200, hidden.text);
    assert.deepEqual(parseRpc(hidden.text).result.tools, [], label + ': private beta tools must stay hidden');
    const denied = await callEcho(privateSession, betaEcho.name, 'must-not-run');
    assert.equal(denied.status, 200, denied.text);
    const failure = parseRpc(denied.text);
    assert(failure.error || failure.result?.isError === true, label + ': private beta calls must fail');
    assert(!denied.text.includes('beta:must-not-run'), label + ': private beta tool ran');
    const allowedSession = await initialize(aliceKey.token, '/alice/mcp/alpha' + query, extras);
    const visible = await list(allowedSession);
    assert.equal(visible.status, 200, visible.text);
    const alphaEcho = parseRpc(visible.text).result.tools.find((tool) => tool.name.includes('echo'));
    assert(alphaEcho, label + ': the key owner must retain access to alpha');
    const allowed = await callEcho(allowedSession, alphaEcho.name, 'owner-proof');
    assert.equal(allowed.status, 200, allowed.text);
    assert(parseRpc(allowed.text).result.content.some((item) => item.text === 'alpha:owner-proof'));
  }
  console.log('PASS: user-key tool visibility and calls follow ownership with or without conflicting dashboard JWTs');
  const aliceLogin = await request('/api/auth/login', bootstrap, { username: 'alice', password });
  assert.equal(aliceLogin.status, 200);
  const aliceQuery = '?token=' + encodeURIComponent(JSON.parse(aliceLogin.text).token);
  const bootstrapQuerySession = await initialize(bootstrap, '/mcp/beta' + aliceQuery);
  for (const session of [bootstrapQuerySession, { ...bootstrapQuerySession, route: '/mcp/beta' }]) {
    const visible = await list(session);
    assert.equal(visible.status, 200, visible.text);
    assert(parseRpc(visible.text).result.tools.some((tool) => tool.name === betaEcho.name),
      'Bootstrap must retain private beta access with or without the query JWT');
    const called = await callEcho(session, betaEcho.name, 'bootstrap-query-proof');
    assert.equal(called.status, 200, called.text);
    assert(parseRpc(called.text).result.content.some((item) => item.text === 'beta:bootstrap-query-proof'));
  }
  for (const credential of [undefined, 'wrong-synthetic-key']) {
    assert.equal((await request('/mcp/alpha' + adminQuery, credential, initBody())).status, 401,
      'A valid query JWT cannot replace a transport bearer');
  }
  for (const [key, route] of [[groupKey, '/mcp/only-alpha'], [groupKey, '/mcp/space%20group'],
    [groupKey, '/mcp/11111111-1111-4111-8111-111111111111'],
    [customKey, '/mcp/alpha'], [allKey, '/mcp'], [aliceKey, '/alice/mcp/alpha']]) {
    assert.equal((await list(await initialize(key.token, route))).status, 200);
  }
  for (const [key, route] of [[dashboard, '/mcp'], [customKey, '/mcp'], [groupKey, '/mcp/alpha'],
    [dashboard, '/mcp/mixed'], [customKey, '/mcp/mixed'], [groupKey, '/mcp/mixed']]) {
    assert.equal((await request(route, key.token, initBody())).status, 401, route);
  }
  assert.equal((await request('/admin/mcp/alpha', aliceKey.token, initBody())).status, 403);
  assert.equal((await list(await initialize(groupKey.token, '/mcp/$smart/only-alpha'))).status, 200);
  assert.equal((await request('/mcp/$smart/mixed', groupKey.token, initBody())).status, 401);
  const groupSession = await initialize(groupKey.token, '/mcp/only-alpha');
  const groupTools = parseRpc((await list(groupSession)).text).result.tools;
  const previousGroupState = readFileSync(settingsFile, 'utf8');
  changeSettings((value) => { value.groups.find((group) => group.name === 'only-alpha').servers = ['beta']; });
  const changedGroup = parseRpc((await list(groupSession)).text).result.tools;
  assert(changedGroup.some((tool) => tool.name.includes('beta')));
  assert(!changedGroup.some((tool) => tool.name.includes('alpha')));
  const staleGroupCall = await request(groupSession.route, groupKey.token, { jsonrpc: '2.0', id: 16,
    method: 'tools/call', params: { name: groupTools[0].name, arguments: { text: 'must-not-run' } } }, groupSession.headers);
  assert.equal(staleGroupCall.status, 200);
  const staleGroupResult = parseRpc(staleGroupCall.text);
  assert(staleGroupResult.error || staleGroupResult.result?.isError,
    'Removed group tools must not remain callable through a cached session');
  writeFileSync(settingsFile, previousGroupState);
  const exclusion = await list(await initialize(excludeKey.token, '/mcp'));
  const visibleTools = parseRpc(exclusion.text).result.tools;
  assert(visibleTools.some((tool) => tool.name.includes('alpha')));
  assert(!visibleTools.some((tool) => tool.name.includes('beta')));
  assert.equal((await request('/api/servers', allKey.token)).status, 401, 'Native all-access key cannot bypass outer management gate');
  const beforeCollision = readFileSync(settingsFile, 'utf8');
  changeSettings((value) => { value.groups.push({
    id: '33333333-3333-4333-8333-333333333333', name: 'alpha', servers: ['beta'], owner: 'admin',
  }); });
  assert.equal((await request('/mcp/alpha', dashboard.token, initBody())).status, 401,
    'Group-first name collision must not grant the server-scoped key another server');
  writeFileSync(settingsFile, beforeCollision);
  const listed = parseRpc((await list(dashboardSession)).text).result.tools;
  const called = await request(dashboardSession.route, dashboard.token, { jsonrpc: '2.0', id: 3,
    method: 'tools/call', params: { name: listed[0].name, arguments: { text: 'harmless-proof' } } }, dashboardSession.headers);
  assert.equal(called.status, 200, called.text);
  assert(parseRpc(called.text).result.content.some((item) => item.text === 'alpha:harmless-proof'));
  const modern = await request('/mcp/alpha', dashboard.token, { jsonrpc: '2.0', id: 8,
    method: 'tools/list', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    } } }, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' });
  assert.equal(modern.status, 200, modern.text);
  assert(parseRpc(modern.text).result.tools.some((tool) => tool.name.includes('echo')));
  assert.equal(modern.headers.get('mcp-session-id'), null);
  const sse = await openSse(groupKey.token, '/sse/only-alpha');
  assert.equal((await request(sse.endpoint, groupKey.token, initBody())).status, 202);
  assert(parseRpc(await sse.nextFrame()).result.serverInfo);
  assert.equal((await request(sse.endpoint, groupKey.token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await request(sse.endpoint, groupKey.token, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).status, 202);
  assert(parseRpc(await sse.nextFrame()).result.tools.some((tool) => tool.name.includes('echo')));
  assert.equal((await request(sse.endpoint, bootstrap, { jsonrpc: '2.0', id: 10, method: 'tools/list' })).status, 403);
  sse.controller.abort();
  streams.delete(sse.controller);
  for (const [token, route] of [[groupKey.token, '/sse/only-alpha'], [aliceKey.token, '/alice/sse/alpha']]) {
    const reconnected = await openSse(token, route);
    assert.equal((await request(reconnected.endpoint, token, initBody())).status, 202);
    assert(parseRpc(await reconnected.nextFrame()).result.serverInfo);
    assert.equal((await request(reconnected.endpoint, token, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.equal((await request(reconnected.endpoint, token, { jsonrpc: '2.0', id: 15, method: 'tools/list' })).status, 202);
    assert(parseRpc(await reconnected.nextFrame()).result.tools.some((tool) => tool.name.includes('echo')));
    reconnected.controller.abort();
    streams.delete(reconnected.controller);
  }
  const streaming = await fetch(base + bootstrapSession.route, {
    headers: { ...authentication(bootstrap), ...bootstrapSession.headers, Accept: 'text/event-stream' },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(streaming.status, 200);
  await streaming.body.cancel();
  const deletable = await initialize(bootstrap);
  assert.equal((await request(deletable.route, dashboard.token, undefined, deletable.headers, 'DELETE')).status, 403);
  assert.equal((await request(deletable.route, bootstrap, undefined, deletable.headers, 'DELETE')).status, 200);
  assert.equal((await list(deletable)).status, 404);
  console.log('PASS: native all/server/group/custom/user/exclusion scopes, real tool call, SSE, stateless MCP, protocol headers, DELETE and route/header/Origin boundaries');

  const updateKey = (key, change) => request(`/api/auth/keys/${key.id}`, bootstrap, change, adminHeaders, 'PUT');
  assert.equal((await updateKey(dashboard, { enabled: false })).status, 200);
  assert.equal((await list(dashboardSession)).status, 401);
  assert.equal((await updateKey(dashboard, { enabled: true })).status, 200);
  assert.equal((await updateKey(dashboard, { allowedServers: ['beta'] })).status, 200);
  assert.equal((await list(dashboardSession)).status, 401);
  assert.equal((await updateKey(dashboard, { allowedServers: ['alpha'] })).status, 200);
  assert.equal((await list(await initialize(dashboard.token))).status, 200);
  const removable = await createKey({ name: 'to-delete', accessType: 'all' });
  const removedSession = await initialize(removable.token);
  assert.equal((await request(`/api/auth/keys/${removable.id}`, bootstrap, undefined, adminHeaders, 'DELETE')).status, 200);
  assert.equal((await list(removedSession)).status, 401);
  const beforeOwnerChange = readFileSync(settingsFile, 'utf8');
  const ownerSession = await initialize(adminKey.token);
  changeSettings((value) => { value.users.find((user) => user.username === 'admin').isAdmin = false; });
  assert.equal((await list(ownerSession)).status, 403);
  assert.equal((await list(bootstrapSession)).status, 200);
  changeSettings((value) => { value.users = value.users.filter((user) => user.username !== 'admin'); });
  assert.equal((await list(ownerSession)).status, 401);
  assert.equal((await list(bootstrapSession)).status, 200);
  writeFileSync(settingsFile, beforeOwnerChange);
  const customHeader = await request('/api/system-config', bootstrap,
    { routing: { bearerAuthHeaderName: 'X-MCP-Key' } }, adminHeaders, 'PUT');
  assert.equal(customHeader.status, 200, customHeader.text);
  nativeAuthHeader = 'X-MCP-Key';
  assert.equal((await list(await initialize(dashboard.token))).status, 200);
  assert.equal((await list(bootstrapSession)).status, 200);
  assert.equal((await request('/mcp/alpha', undefined, initBody(), { Authorization: `Bearer ${dashboard.token}` })).status, 401);
  assert.equal((await request('/mcp/alpha', bootstrap, initBody(), { 'X-MCP-Key': `Bearer ${dashboard.token}` })).status, 401);
  assert.equal((await request('/mcp/alpha', undefined, initBody(), {
    Authorization: `Bearer ${dashboard.token}`, 'X-MCP-Key': `Bearer ${dashboard.token}`,
  })).status, 200);
  const restoreHeader = await request('/api/system-config', bootstrap,
    { routing: { bearerAuthHeaderName: 'Authorization' } }, adminHeaders, 'PUT');
  assert.equal(restoreHeader.status, 200, restoreHeader.text);
  nativeAuthHeader = 'Authorization';
  console.log('PASS: live disable/delete/scope changes, owner demotion/deletion independence and runtime custom-header changes');

  const stored = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.equal(stored.users.find((user) => user.username === 'admin').password, passwordHash);
  assert.deepEqual(stored.retainedUnknown, settings.retainedUnknown);
  assert.equal(stored.systemConfig.routing.enableBearerAuth, false, 'Wrapper must not rewrite the stored flag');
  assert(stored.bearerKeys.find((key) => key.id === 'legacy-key').tokenHash, 'Upgrade must hash the legacy token');
  const original = readFileSync(settingsFile, 'utf8');
  writeFileSync(settingsFile, '{"private":"DO_NOT_LOG",');
  assert.equal((await list(bootstrapSession)).status, 503);
  assert.equal(readFileSync(settingsFile, 'utf8'), '{"private":"DO_NOT_LOG",');
  assert(!logs.includes('DO_NOT_LOG'), 'Corrupt state must not leak source text');
  writeFileSync(settingsFile, original);
  assert.equal((await list(bootstrapSession)).status, 200);
  const saved = path.join(scratch, 'saved-settings.json');
  renameSync(settingsFile, saved);
  assert.equal((await list(bootstrapSession)).status, 503);
  assert(!existsSync(settingsFile), 'Missing state must not be recreated with defaults');
  mkdirSync(settingsFile);
  assert.equal((await list(bootstrapSession)).status, 503);
  rmSync(settingsFile, { recursive: true });
  renameSync(saved, settingsFile);
  changeSettings((value) => { value.bearerKeys.push({ ...value.bearerKeys[0], id: 'duplicate' }); });
  assert.equal((await list(bootstrapSession)).status, 503);
  writeFileSync(settingsFile, original);
  assert.equal((await list(bootstrapSession)).status, 200);
  const actualReady = readFileSync(status, 'utf8');
  writeFileSync(status, JSON.stringify({ ...JSON.parse(actualReady), nonce: '0'.repeat(64) }));
  assert.notEqual(spawnSync(process.execPath, [helper, 'verify-ready', String(native.pid)], { cwd: upstream, env }).status, 0);
  writeFileSync(status, actualReady);
  assert.notEqual(spawnSync(process.execPath, [helper, 'verify-ready', String(native.pid + 1)], { cwd: upstream, env }).status, 0);
  run(process.execPath, [helper, 'verify-ready', String(native.pid)], env);
  const invalidManifestFile = path.join(scratch, 'invalid-integrity.json');
  const invalidManifest = JSON.parse(readFileSync(integrityFile, 'utf8'));
  invalidManifest.files['server.js'] = '0'.repeat(64);
  writeFileSync(invalidManifestFile, JSON.stringify(invalidManifest), { mode: 0o600 });
  const failedRuntime = path.join(scratch, 'must-not-start');
  const failedPrepare = spawnSync(process.execPath,
    [helper, 'prepare', keyFile, settingsFile, failedRuntime, invalidManifestFile], { cwd: upstream, env });
  assert.notEqual(failedPrepare.status, 0, 'Mismatched compiled code must fail before any listener is launched');
  assert(!existsSync(failedRuntime), 'Failed preflight must not publish startup state');
  console.log('PASS: malformed/missing/unreadable/duplicate state and stale nonce/PID readiness fail closed without data recovery');

  await stop(proxy);
  await stop(native);
  const beforeRestart = readFileSync(settingsFile, 'utf8');
  prepare();
  await startNative();
  await startProxy();
  assert.equal(readFileSync(settingsFile, 'utf8'), beforeRestart, 'Restart must not duplicate keys or modify retained state');
  assert.equal((await list(bootstrapSession)).status, 404, 'Old session cannot be transparently re-owned after restart');
  assert.equal((await list(await initialize(bootstrap))).status, 200);
  assert.equal((await list(await initialize(dashboard.token))).status, 200);
  const originalBootstrap = bootstrap;
  const previousKeyFile = path.join(scratch, 'previous-bootstrap');
  writeFileSync(previousKeyFile, originalBootstrap, { mode: 0o600 });
  writeFileSync(keyFile, 'rotated-custom-bootstrap', { mode: 0o600 });
  assert.equal((await request('/mcp/alpha', 'rotated-custom-bootstrap', initBody())).status, 401,
    'Editing the private key file must not live-reload the running credential');
  assert.equal((await list(await initialize(originalBootstrap))).status, 200);
  await stop(proxy);
  await stop(native);
  bootstrap = 'rotated-custom-bootstrap';
  prepare(previousKeyFile);
  await startNative();
  await startProxy();
  assert.equal((await request('/mcp/alpha', originalBootstrap, initBody())).status, 401);
  assert.equal((await list(await initialize(bootstrap))).status, 200);
  assert.equal((await list(await initialize(dashboard.token))).status, 200);
  console.log('PASS: restart/idempotence, authenticated reinitialization and restart-only bootstrap rotation preserve native keys');

  await stop(proxy);
  await stop(native);
  changeSettings((value) => { value.systemConfig.routing.skipAuth = true; });
  prepare();
  await startNative();
  await startProxy();
  assert.equal(JSON.parse(readFileSync(status, 'utf8')).mode, 'legacy');
  assert.equal((await list(await initialize(bootstrap))).status, 200);
  assert.equal((await request('/mcp/alpha', dashboard.token, initBody())).status, 401,
    'Unsupported-mode fallback must not mix delegated routing with legacy native policy');
  assert.equal((await request('/mcp/alpha')).status, 401);
  console.log('PASS: intentional skipAuth retains coherent legacy bootstrap-only proxy behavior');

  const dotenvDirectory = path.join(scratch, 'dotenv');
  mkdirSync(dotenvDirectory);
  writeFileSync(path.join(dotenvDirectory, '.env'), 'USE_DB=true\nDB_URL=postgres://unused-fixture\n');
  changeSettings((value) => { delete value.systemConfig.routing.skipAuth; });
  for (const [value, mode] of [[undefined, 'legacy'], ['false', 'delegated'], ['', 'delegated'], ['TRUE', 'delegated']]) {
    const checkEnv = { ...env };
    if (value === undefined) delete checkEnv.USE_DB;
    else checkEnv.USE_DB = value;
    const fixtureRun = path.join(dotenvDirectory, `run-${value === undefined ? 'unset' : value || 'empty'}`);
    const prepared = spawnSync(process.execPath, [helper, 'prepare', keyFile, settingsFile, fixtureRun, integrityFile], {
      cwd: dotenvDirectory, env: checkEnv, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(fixtureRun, 'boot.json'), 'utf8')).mode, mode);
  }
  console.log('PASS: actual dotenv working-directory loading and exported literal USE_DB precedence agree with upstream');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  for (const controller of streams) controller.abort();
  await stop(proxy);
  await stop(native);
  rmSync(scratch, { recursive: true, force: true });
}
