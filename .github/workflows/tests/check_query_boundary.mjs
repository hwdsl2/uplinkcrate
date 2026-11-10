// Linux image only: observe the request after the real built policy/Express.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'linux');
const [upstream, jwt] = process.argv.slice(2);
assert(upstream && jwt && process.env.UPLINK_BOOT_FILE);
const dependency = createRequire(path.join(upstream, 'package.json'));
const express = dependency('express');
const { installUplinkPolicy, uplinkActive } = await import(pathToFileURL(path.join(upstream, 'dist/uplinkPolicy.js')));
assert.equal(uplinkActive(), true, 'The observer must exercise delegated policy');
const boot = JSON.parse(readFileSync(process.env.UPLINK_BOOT_FILE, 'utf8'));
const bootstrap = readFileSync(boot.keyFile, 'utf8');
const app = express();
installUplinkPolicy(app);
app.use((req, res) => res.json({
  queryRemoved: !Object.hasOwn(req.query, 'token'),
  headerRemoved: req.headers['x-auth-token'] === undefined,
  keep: req.query.keep,
}));
const server = app.listen(0, '127.0.0.1');
try {
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const query = `?token=${encodeURIComponent(jwt)}&keep=unrelated`;
  const headers = { Authorization: `Bearer ${bootstrap}`, 'x-auth-token': jwt };
  const transport = await fetch(base + '/mcp/alpha' + query, { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(transport.status, 200);
  assert.deepEqual(await transport.json(), { queryRemoved: true, headerRemoved: true, keep: 'unrelated' });
  const management = await fetch(base + '/api/logs/stream' + query, { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(management.status, 200);
  assert.deepEqual(await management.json(), { queryRemoved: false, headerRemoved: false, keep: 'unrelated' });
  const queryOnly = await fetch(base + '/mcp/alpha' + query, { signal: AbortSignal.timeout(5000) });
  assert.equal(queryOnly.status, 401);
  await queryOnly.arrayBuffer();
  console.log('PASS: downstream transport query/header JWTs are stripped; management and unrelated query fields survive');
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
