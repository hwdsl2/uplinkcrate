import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execPath } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const candidate = readFileSync(path.join(root, 'run.sh'), 'utf8');
const legacy = readFileSync(path.join(root, '.github/workflows/tests/fixtures/legacy-key-selection.sh'), 'utf8');

function fixture(source, values = {}, saved = 'synthetic-saved-key') {
  const directory = mkdtempSync(path.join(tmpdir(), 'uplink-secret-test-'));
  try {
    const keyFile = path.join(directory, '.api_key');
    const runtime = path.join(directory, 'runtime');
    const external = path.join(directory, 'secret with spaces');
    const config = path.join(directory, 'mcp.env');
    const validator = path.join(directory, 'validator.mjs');
    mkdirSync(runtime);
    if (saved !== null) writeFileSync(keyFile, saved);
    writeFileSync(external, 'synthetic-file-key\r\n\n');
    writeFileSync(config, '');
    // Invoke the actual strict saved-key validator with its unmodified bytes.
    writeFileSync(validator, `import {readFileSync} from 'node:fs';
      import {validateToken} from ${JSON.stringify(pathToFileURL(path.join(root, 'policy/security.ts')).href)};
      try { validateToken(readFileSync(0, 'utf8')); } catch { process.exit(1); }`);
    const prefix = source.split('# Apply defaults')[0]
      .replaceAll('/mcp.env', config);
    const block = source.split('# Generate or load API key')[1].split('# Determine server address')[0];
    const script = prefix + `
      node() { "$TEST_NODE" --experimental-strip-types "$@"; }
      API_KEY_FILE="$TEST_SAVED"
      POLICY_RUNTIME="$TEST_RUNTIME"
      POLICY_CLI="$TEST_VALIDATOR"
      ${block}
      printf '%s' "$api_key"`;
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        KUBERNETES_SERVICE_HOST: 'fixture', TEST_NODE: execPath,
        TEST_SAVED: keyFile, TEST_RUNTIME: runtime, TEST_VALIDATOR: validator,
        ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === '@file' ? external : v])) },
    });
    return { ...result, saved: saved === null ? null : readFileSync(keyFile, 'utf8') };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('candidate without file inputs matches the recorded launcher selection', () => {
  for (const values of [{}, { MCP_API_KEY: '' }, { MCP_API_KEY: '  "synthetic-direct-key"  ' }]) {
    const before = fixture(legacy, values), after = fixture(candidate, values);
    assert.equal(after.status, before.status);
    assert.equal(after.stdout, before.stdout);
    assert.equal(after.saved, before.saved);
  }
  const fresh = fixture(candidate, {}, null);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /^mcp-[a-f0-9]{48}$/);
});

test('external files override saved keys while invalid sources preserve saved bytes', () => {
  const valid = fixture(candidate, { MCP_API_KEY_FILE: '@file' });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, 'synthetic-file-key');
  // Persistence remains after the later policy preflight in the real launcher.
  assert.equal(valid.saved, 'synthetic-saved-key');
  for (const values of [{ MCP_API_KEY_FILE: '' },
    { MCP_API_KEY_FILE: '/missing/secret' }, { MCP_API_KEY: '', MCP_API_KEY_FILE: '@file' }]) {
    const result = fixture(candidate, values);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MCP_API_KEY_FILE/);
    assert.equal(result.saved, 'synthetic-saved-key');
  }
});

test('legacy saved-key validation still rejects terminal newlines without repair', () => {
  for (const source of [legacy, candidate]) {
    const result = fixture(source, {}, 'synthetic-saved-key\n');
    assert.notEqual(result.status, 0);
    assert.equal(result.saved, 'synthetic-saved-key\n');
    assert.equal(result.stdout, '');
  }
});
