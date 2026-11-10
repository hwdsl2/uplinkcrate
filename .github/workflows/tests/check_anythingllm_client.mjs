// Run the unchanged, checksum-pinned AnythingLLM HTTP client, not a UI simulation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import path from 'node:path';

export async function checkAnythingLLM({ source, upstream, storage, url, bootstrap, dashboard, echoPrefix = 'alpha' }) {
  const bytes = readFileSync(source);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '1dad0616ac697e5671d5b90946b2f4727b28a1f2f35df45608fe3ebcfa2d40c7', 'Unexpected AnythingLLM client source');
  const dependency = createRequire(path.join(upstream, 'package.json'));
  const clientModule = new Module(source);
  clientModule.filename = source;
  clientModule.require = (name) => {
    if (name === '../../http') return { safeJsonParse: (text, fallback) => {
      try { return JSON.parse(text); } catch { return fallback; }
    } };
    if (name === '../../helpers/shell') return { patchShellEnvironmentPath: () => {
      throw new Error('HTTP client test must not invoke stdio shell helpers');
    } };
    // Use the real SDK v1 supplied by MCPHub's frozen devDependency, which is
    // compatible with AnythingLLM's declared ^1.24.3 SDK dependency range.
    if (name.startsWith('@modelcontextprotocol/sdk/')) {
      return dependency(name.replace('@modelcontextprotocol/sdk/', '@modelcontextprotocol/sdk-v1/'));
    }
    if (['path', 'fs'].includes(name)) return dependency(name);
    throw new Error(`Unexpected AnythingLLM dependency: ${name}`);
  };
  clientModule._compile(bytes.toString('utf8'), source);
  const MCPHypervisor = clientModule.exports;
  const savedStorage = process.env.STORAGE_DIR, savedMode = process.env.NODE_ENV;
  let client;
  try {
    process.env.STORAGE_DIR = storage;
    process.env.NODE_ENV = 'production';
    client = new MCPHypervisor();
  } finally {
    if (savedStorage === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = savedStorage;
    if (savedMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedMode;
  }
  client.log = () => {}; // Suppress synthetic traffic; transport behavior is unchanged.
  const writeConfig = (token) => {
    writeFileSync(client.mcpServerJSONPath, JSON.stringify({ mcpServers: {
      uplink: { type: 'streamable', url, headers: { Authorization: `Bearer ${token}` } },
    } }));
    chmodSync(client.mcpServerJSONPath, 0o600);
  };
  try {
    writeConfig(bootstrap);
    await client.bootMCPServers();
    assert.equal(client.mcpLoadingResults.uplink.status, 'success');
    assert((await client.mcps.uplink.listTools()).tools.length > 0);
    // Reproduce the reporter's key replacement and refresh through the actual
    // AnythingLLM hypervisor, including its native SDK initialize exchange.
    writeConfig(dashboard);
    await client.reloadMCPServers();
    assert.equal(client.mcpLoadingResults.uplink.status, 'success');
    const tools = (await client.mcps.uplink.listTools()).tools;
    const echo = tools.find((tool) => tool.name.includes('echo'));
    assert(echo);
    const result = await client.mcps.uplink.callTool({ name: echo.name, arguments: { text: 'anythingllm-proof' } });
    assert(result.content.some((item) => item.text === `${echoPrefix}:anythingllm-proof`));
  } finally {
    await Promise.allSettled(Object.values(client.mcps).map((connection) => connection.close()));
    client.mcps = {};
  }
}
