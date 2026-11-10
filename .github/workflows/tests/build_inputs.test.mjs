import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');

test('Caddy retains latest-release discovery and verifies the matching release checksum', () => {
  assert(dockerfile.includes('https://api.github.com/repos/caddyserver/caddy/releases/latest'));
  assert(!/CADDY_VER=\d/.test(dockerfile), 'Caddy must not have a fixed version');
  assert(dockerfile.includes('caddy_${CADDY_VER}_checksums.txt'));
  const verify = dockerfile.indexOf('sha512sum -c -');
  const extract = dockerfile.indexOf('tar -xzf /tmp/caddy.tar.gz');
  assert(verify > 0 && extract > verify, 'Verify before archive extraction');
  const program = dockerfile.match(/'(\$2 == archive[^']+)' \/tmp\/caddy-checksums\.txt/)[1];
  // Published amd64/arm64 entries, not just synthetic digests. Caddy uses SHA-512:
  // https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_checksums.txt
  const published = [
    '0e85544340290a16ce4bfb76fe7d65e9de1bf3a6e67f5ccfff30b30d27ea4c73e078077b7bf3e58ae60b6b12e44327705287059c775bca5782e8ee85ea7edd75  caddy_2.11.9_linux_amd64.tar.gz',
    '9e5e76d7888542924de2c25353ae87c5f77e2a22c5b1198633cae13688922282e05383d142599205c88d8d80eee5e967d291214d7abce4835329a191b20dd6e0  caddy_2.11.9_linux_arm64.tar.gz',
  ].join('\n') + '\n';
  const expected = {
    amd64: '0e85544340290a16ce4bfb76fe7d65e9de1bf3a6e67f5ccfff30b30d27ea4c73e078077b7bf3e58ae60b6b12e44327705287059c775bca5782e8ee85ea7edd75',
    arm64: '9e5e76d7888542924de2c25353ae87c5f77e2a22c5b1198633cae13688922282e05383d142599205c88d8d80eee5e967d291214d7abce4835329a191b20dd6e0',
  };
  const good = 'a'.repeat(128), other = 'b'.repeat(128);
  for (const arch of ['amd64', 'arm64']) {
    const real = spawnSync('awk', ['-v', `archive=caddy_2.11.9_linux_${arch}.tar.gz`, program],
      { input: published, encoding: 'utf8' });
    assert.equal(real.status, 0, real.stderr);
    assert.equal(real.stdout, expected[arch] + '\n');
    const archive = `caddy_9.8.7_linux_${arch}.tar.gz`;
    for (const [input, success] of [
      [`${good}  ${archive}\n${other}  unrelated.tar.gz\n`, true],
      [`${good}  unrelated.tar.gz\n`, false],
      [`${good}  ${archive}\n${other}  ${archive}\n`, false],
      [`not-a-checksum  ${archive}\n`, false],
      [`${'a'.repeat(64)}  ${archive}\n`, false],
      [`${'a'.repeat(127)}  ${archive}\n`, false],
      [`${'a'.repeat(129)}  ${archive}\n`, false],
      [`${'g'.repeat(128)}  ${archive}\n`, false],
      ['', false],
    ]) {
      const result = spawnSync('awk', ['-v', `archive=${archive}`, program], { input, encoding: 'utf8' });
      assert.equal(result.status === 0, success, result.stderr);
      if (success) assert.equal(result.stdout, good + '\n');
    }
  }
});

test('MCPHub remains explicitly digest-pinned and the canonical backend is rebuilt', () => {
  assert.match(dockerfile, /^FROM samanhappy\/mcphub:1\.2\.2@sha256:[0-9a-f]{64}$/m);
  assert(dockerfile.includes('node /opt/src/policy/apply.mjs /app'));
  assert(dockerfile.includes('pnpm backend:build'));
  assert(dockerfile.includes('--manifest > /opt/src/policy/integrity.json'));
  assert(dockerfile.includes("date -u -d '7 days ago'"));
  assert(dockerfile.includes('npm install -g --before="$NPM_BEFORE"'));
});
