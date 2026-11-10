// Harmless local MCP fixture. No network, filesystem or external service tools.
import { createInterface } from 'node:readline';

const name = process.argv[2] || 'fixture';
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (!Object.hasOwn(request, 'id')) continue;
  let result;
  if (request.method === 'initialize') {
    result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } };
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'echo', description: `Echo from ${name}`, inputSchema: {
      type: 'object', properties: { text: { type: 'string' } }, required: ['text'],
    } }] };
  } else if (request.method === 'tools/call' && request.params?.name === 'echo') {
    result = { content: [{ type: 'text', text: `${name}:${request.params.arguments?.text || ''}` }] };
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
