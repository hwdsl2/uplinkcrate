// Linux CI only. Bounded operations for disposable image fixtures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'linux', 'Image checks require a disposable Linux runner');
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function docker(args, required = true, timeout = 60000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (required) assert.equal(result.status, 0, `docker ${args[0]} failed: ${result.stderr}`);
  return result;
}
export function seed(image, volume) {
  docker(['run', '--rm', '--entrypoint', 'node', '-v', `${root}:/wrapper:ro`,
    '-v', `${volume}:/state`, image,
    '/wrapper/.github/workflows/tests/check_image_volume.mjs', 'seed', 'old']);
}
export function edit(image, volume, program) {
  return docker(['run', '--rm', '--entrypoint', 'node', '-v', `${volume}:/state`,
    image, '-e', `const fs=require('fs'), file='/state/mcp_settings.json'; ${program}`]);
}
export function inspectVolume(image, volume, network, name, operation = 'probe', cleanup = 'normal') {
  docker(['run', '--rm', '--network', network, '--entrypoint', 'node',
    '-v', `${root}:/wrapper:ro`, '-v', `${volume}:/state`, image,
    '/wrapper/.github/workflows/tests/check_image_volume.mjs', operation, 'new', `http://${name}:3000`, cleanup]);
}
export async function waitForStartup(name) {
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(docker(['inspect', '-f', '{{.State.Running}}', name]).stdout.trim(), 'true',
      'Gateway exited before startup completed');
    const logs = docker(['logs', name]);
    if ((logs.stdout + logs.stderr).includes('Setup complete.') &&
        docker(['exec', name, 'curl', '-fsS', '--connect-timeout', '1', '--max-time', '2',
          'http://127.0.0.1:3000/health'], false, 10000).status === 0) return;
    await sleep(1000);
  }
  throw new Error('Gateway did not complete startup within the bounded wait');
}
