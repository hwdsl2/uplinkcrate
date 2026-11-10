// Execute only inside the disposable CI image, against its actual Caddy binary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [upstream, caddy] = process.argv.slice(2);
assert(upstream && caddy);
const { caddyConfig } = await import(pathToFileURL(path.join(upstream, 'dist/uplinkPolicy.js')));
const directory = mkdtempSync(path.join(tmpdir(), 'uplink-proxy-headers-'));
const key = 'synthetic-bootstrap-header-check';
const capture = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ headers: request.headers, url: request.url }));
});
let proxy;
try {
  capture.listen(0, '127.0.0.1');
  await once(capture, 'listening');
  const internalPort = capture.address().port;
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const publicPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const config = caddyConfig(key, String(publicPort), String(internalPort), true);
  config.apps.http.servers.uplink.listen = [`127.0.0.1:${publicPort}`];
  const file = path.join(directory, 'caddy.json');
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  proxy = spawn(caddy, ['run', '--config', file], { cwd: directory,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', XDG_CONFIG_HOME: directory, XDG_DATA_HOME: directory },
    stdio: 'ignore' });
  const base = `http://127.0.0.1:${publicPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.status === 200) { ready = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(ready, 'Caddy must be ready for the header test');
  for (const [route, credential] of [['/health', undefined], ['/api/servers', key], ['/', key],
    ['/mcp/alpha', 'synthetic-native-key'], ['/sse/alpha', 'synthetic-native-key'], ['/messages', 'synthetic-native-key']]) {
    const response = await fetch(base + route, { headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      'X-Forwarded-For': '203.0.113.99', 'X-Forwarded-Host': 'spoofed.invalid', 'X-Forwarded-Proto': 'https',
      'Mcp-Session-Id': 'synthetic-session', 'MCP-Protocol-Version': '2025-03-26',
      'Last-Event-ID': 'synthetic-event', 'x-auth-token': 'synthetic-dashboard-jwt',
      Accept: 'text/event-stream', Origin: 'https://approved.invalid',
    }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.headers['x-forwarded-for'], undefined, route);
    assert.equal(result.headers['x-forwarded-host'], new URL(base).host, route);
    assert.equal(result.headers['x-forwarded-proto'], 'http', route);
    assert.equal(result.headers.host, new URL(base).host, route);
    assert.equal(result.headers.authorization, credential ? `Bearer ${credential}` : undefined, route);
    assert.equal(result.headers['mcp-session-id'], 'synthetic-session', route);
    assert.equal(result.headers['mcp-protocol-version'], '2025-03-26', route);
    assert.equal(result.headers['last-event-id'], 'synthetic-event', route);
    assert.equal(result.headers['x-auth-token'], 'synthetic-dashboard-jwt', route);
    assert.equal(result.headers.origin, 'https://approved.invalid', route);
    assert.equal(result.headers.accept, 'text/event-stream', route);
  }
  for (const route of ['/api/mcp/alpha', '/']) {
    const response = await fetch(base + route, { headers: { Authorization: 'Bearer synthetic-native-key' },
      signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  }
  console.log('PASS: actual Caddy preserves protocol/credential headers and removes spoofed forwarding headers in every branch');
} finally {
  if (proxy && proxy.exitCode === null && proxy.signalCode === null) {
    const stopped = once(proxy, 'exit');
    proxy.kill('SIGTERM');
    const timer = setTimeout(() => proxy.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(timer);
  }
  capture.closeAllConnections();
  await new Promise((resolve) => capture.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
