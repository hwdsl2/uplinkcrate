import assert from 'node:assert/strict';
import { createConnection, isIP } from 'node:net';

const [host, port] = process.argv.slice(2);
assert(isIP(host), 'Expected the disposable gateway container IP');
const address = isIP(host) === 6 ? `[${host}]` : host;
assert.equal((await fetch(`http://${address}:${port}/health`, { signal: AbortSignal.timeout(5000) })).status, 200);
const reachable = await new Promise((resolve) => {
  const socket = createConnection({ host, port: 3001 });
  const finish = (value) => { socket.destroy(); resolve(value); };
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.setTimeout(2000, () => finish(false));
});
assert.equal(reachable, false, 'Raw internal MCPHub port must not be reachable by a peer container');
console.log(`PASS: public gateway reachable and raw MCPHub listener isolated over IPv${isIP(host)}`);
