// Bounded, authenticated MCP connectivity check. Never invoke a tool.
import { readFileSync } from 'node:fs';

const [port, server, keyFile] = process.argv.slice(2);
let session;
let headers;
let url;

function parseResponse(text) {
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const message = JSON.parse(line.slice(5).trim());
      if (message.id !== undefined) return message;
    } catch { /* An unrelated SSE event is not an MCP response. */ }
  }
  throw new Error('No JSON-RPC response');
}

async function rpc(method, id) {
  const body = { jsonrpc: '2.0', method, ...(id === undefined ? {} : { id }), params: method === 'initialize'
    ? { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp_manage', version: '1.0' } }
    : {} };
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
}

try {
  if (!/^[1-9][0-9]{0,4}$/.test(port || '') || Number(port) > 65535 || !server || !keyFile) throw new Error();
  const key = readFileSync(keyFile, 'utf8');
  if (key.length > 8192 || /[^\x21-\x7e]/.test(key) || !/^[A-Za-z0-9._~+\/-]+=*$/.test(key)) throw new Error();
  url = `http://127.0.0.1:${port}/mcp/${encodeURIComponent(server)}`;
  headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const initialized = await rpc('initialize', 1);
  if (!initialized.ok || !parseResponse(await initialized.text()).result?.serverInfo) throw new Error();
  session = initialized.headers.get('mcp-session-id');
  if (!session) throw new Error();
  headers['Mcp-Session-Id'] = session;
  headers['MCP-Protocol-Version'] = '2025-03-26';
  const notification = await rpc('notifications/initialized');
  if (!notification.ok) throw new Error();
  await notification.arrayBuffer();
  const listed = await rpc('tools/list', 2);
  if (!listed.ok || !Array.isArray(parseResponse(await listed.text()).result?.tools)) throw new Error();
  console.log(`Server '${server}' is reachable (authenticated initialize and tools/list succeeded).`);
} catch {
  console.error(`Server '${server || '(missing)'}' failed its authenticated MCP check. Check the container logs.`);
  process.exitCode = 1;
} finally {
  if (session && headers && url) {
    try { await (await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(3000) })).arrayBuffer(); } catch { /* best effort */ }
  }
}
