// Extract only pure helpers. Never execute the container startup script on a host.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateToken } from '../../../policy/security.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manage = readFileSync(path.join(root, 'manage.sh'), 'utf8');
const startup = readFileSync(path.join(root, 'run.sh'), 'utf8');
const workflow = readFileSync(path.join(root, '.github/workflows/mcp_gateway_test.yml'), 'utf8');
function block(text, name) {
  const match = text.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert(match, `Missing shell helper ${name}`);
  return match[0];
}
function bash(source, args = [], extra = {}) {
  return spawnSync('/bin/bash', ['-c', source, 'fixture', ...args], {
    encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', ...extra },
  });
}

test('workflow output checks drain producers and preserve failures under pipefail', () => {
  const consumers = [...workflow.matchAll(/docker exec "\$TEST_ID" mcp_manage --(?:status|list) \| ([^\n]+)/g)]
    .map((match) => match[1].replace(/\s*\\\s*$/, '').replace(/;\s*then\s*$/, '').trim());
  assert(consumers.length > 0, 'Workflow status/list output checks must be exercised');
  const producer = `set -o pipefail
producer() {
  if [ "$1" = match ]; then
    printf '%s\\n' 'Authentication: delegated' 'MCPHub:  running' 'Caddy:   running' 'Enabled MCP servers: fetch,memory'
  fi
  for ((i=0; i<4096; i++)); do printf '%s\\n' 'remaining producer output'; done
  return "$2"
}
`;
  for (const consumer of consumers) {
    for (const [match, status, expected] of [['match', 0, 0], ['miss', 0, 1], ['match', 7, 7]]) {
      const result = bash(producer + `producer ${match} ${status} | ${consumer}`);
      assert.equal(result.status, expected, `${consumer}: ${result.stderr}`);
    }
  }
});

const config = `MCP_DATA="$1"; API_KEY_FILE="$MCP_DATA/.api_key"; PORT_FILE="$MCP_DATA/.port"; SERVERS_FILE="$MCP_DATA/.servers";\n${block(manage, 'load_config')}\nload_config\n`;

test('persisted effective key and port override stale helper environment', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uplink-helper-config-'));
  try {
    writeFileSync(path.join(directory, '.api_key'), 'custom_key_without_generated_prefix');
    writeFileSync(path.join(directory, '.port'), '3100');
    writeFileSync(path.join(directory, '.servers'), 'alpha,beta');
    const result = bash(config + 'printf "%s\\n%s\\n%s" "$MCP_PORT" "$MCP_API_KEY" "$ENABLED_SERVERS"', [directory], {
      MCP_PORT: '3200', MCP_API_KEY: 'stale-key',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '3100\ncustom_key_without_generated_prefix\nalpha,beta');
    const key = bash(config + block(manage, 'do_get_key') + '\ndo_get_key', [directory], { MCP_API_KEY: '' });
    assert.equal(key.stdout, 'custom_key_without_generated_prefix');
    assert.equal(key.status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing helper state keeps default port and returns failure for missing key', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'uplink-helper-empty-'));
  try {
    const result = bash(config + 'printf "%s|%s" "$MCP_PORT" "$ENABLED_SERVERS"', [directory]);
    assert.equal(result.stdout, '3000|fetch');
    const key = bash(config + block(manage, 'do_get_key') + '\ndo_get_key', [directory]);
    assert.equal(key.status, 1);
    assert.equal(key.stdout, '');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing --test argument exits promptly with a useful error', () => {
  const result = bash(block(manage, 'show_usage') + '\n' + block(manage, 'parse_args') + '\nparse_args --test');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing server name/);
});

test('--test dispatcher preserves probe failure instead of returning false success', () => {
  const dispatch = manage.match(/if \[ "\$test_server" = 1 \]; then[\s\S]*?\nfi/);
  assert(dispatch);
  for (const expected of [0, 1]) {
    const result = bash(`ENABLED_SERVERS=fetch; server_arg=fetch; test_server=1;\nnode() { return ${expected}; }\n` +
      block(manage, 'do_test_server') + '\n' + dispatch[0]);
    assert.equal(result.status, expected, result.stderr);
  }
});

test('environment control characters fail before legacy trimming; normal quote/space handling remains', () => {
  const begin = startup.indexOf('# Read and sanitize environment variables');
  const end = startup.indexOf('MCP_PORT=$(nospaces', begin);
  assert(begin >= 0 && end > begin);
  const oneLine = (name) => startup.match(new RegExp(`^${name}\\(\\) \\{.*$`, 'm'))[0];
  const source = 'exiterr() { echo "$1" >&2; exit 1; }\n' + oneLine('nospaces') + '\n' + oneLine('noquotes') + '\n' +
    startup.slice(begin, end) + '\nprintf "%s" "$MCP_API_KEY"';
  for (const [input, expected] of [['custom-key', 'custom-key'], [' "custom-key" ', 'custom-key'], ['', ''], [' "" ', '']]) {
    const result = bash(source, [], { MCP_API_KEY: input });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    if (expected) validateToken(result.stdout);
  }
  for (const value of ['key\n', '\nkey', 'key\r', 'key\t', 'key\nother', 'key\x7f']) {
    const result = bash(source, [], { MCP_API_KEY: value });
    assert.equal(result.status, 1);
    assert(!result.stderr.includes(value));
  }
});

test('public ports keep decimal leading-zero compatibility and reserve the internal port', () => {
  const begin = startup.indexOf('# Validate port');
  const end = startup.indexOf('# Validate server hostname/IP', begin);
  assert(begin >= 0 && end > begin);
  const source = 'exiterr() { echo "$1" >&2; exit 1; }\nMCP_INTERNAL_PORT=3001;\n' +
    block(startup, 'check_port') + '\n' + startup.slice(begin, end) + '\nprintf "%s" "$MCP_PORT"';
  for (const [input, expected] of [['3000', '3000'], ['03000', '3000'], ['00080', '80'], ['65535', '65535']]) {
    const result = bash(source, [], { MCP_PORT: input });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
  for (const input of ['0', '65536', '3001', '03001', '1\n2', 'abc', '9'.repeat(50)]) {
    assert.notEqual(bash(source, [], { MCP_PORT: input }).status, 0);
  }
});
