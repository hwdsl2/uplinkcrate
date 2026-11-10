// Linux CI only. Exercise normal entrypoints against one disposable data volume.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [candidate, previous, prefix, network] = process.argv.slice(2);
assert(candidate && previous === 'mcp-gateway-previous-test');
assert(/^[a-z0-9-]+$/.test(prefix || '') && /^[a-z0-9-]+$/.test(network || ''));
assert.equal(process.platform, 'linux', 'Image checks belong on a disposable Linux runner');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const name = `${prefix}-gateway`, volume = `${prefix}-data`;
const script = '/wrapper/.github/workflows/tests/check_image_volume.mjs';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function docker(args, required = true) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  if (required) assert.equal(result.status, 0, `docker ${args[0]} failed: ${result.stderr}`);
  return result;
}
function inspect(mode, phase) {
  console.log(`Upgrade fixture: ${phase} / ${mode}`);
  docker(['run', '--rm', '--network', network, '--entrypoint', 'node',
    '-v', `${root}:/wrapper:ro`, '-v', `${volume}:/state`, candidate,
    script, mode, phase, `http://${name}:3000`]);
}
async function start(image) {
  docker(['run', '-d', '--name', name, '--network', network,
    '-e', 'MCP_DISABLE_USAGE_COUNTS=1', '-e', 'MCP_HOST=fixture.invalid', '-e', 'MCP_SERVERS=alpha',
    '-v', `${root}:/wrapper:ro`, '-v', `${volume}:/var/lib/mcp`, image]);
  await waitForStartup();
}
async function waitForStartup(since) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const logs = docker(['logs', ...(since ? ['--since', since] : []), name]);
    if ((logs.stdout + logs.stderr).includes('Setup complete.') &&
        docker(['exec', name, 'curl', '-fsS', '--connect-timeout', '1', '--max-time', '2',
          'http://127.0.0.1:3000/health'], false).status === 0) return;
    const running = docker(['inspect', '-f', '{{.State.Running}}', name]).stdout.trim();
    assert.equal(running, 'true', 'Gateway exited before readiness');
    await sleep(1000);
  }
  throw new Error('Gateway did not become ready');
}

try {
  docker(['image', 'inspect', previous]);
  docker(['volume', 'create', volume]);
  inspect('seed', 'old');
  for (const [image, phase] of [[previous, 'old'], [candidate, 'new']]) {
    await start(image);
    inspect('check', phase);
    inspect('probe', phase);
    if (phase === 'new') {
      console.log('Upgrade fixture: new / restart');
      docker(['restart', name]);
      const since = docker(['inspect', '-f', '{{.State.StartedAt}}', name]).stdout.trim();
      await waitForStartup(since);
      inspect('check', phase);
      inspect('probe', phase);
    }
    docker(['rm', '-f', name]);
  }
  console.log('PASS: old-version upgrade and candidate restart preserve credentials and retained state');
} catch (error) {
  // Fixtures contain synthetic credentials only. Do not upload data volumes.
  const logs = docker(['logs', '--tail', '100', name], false);
  console.error(logs.stdout + logs.stderr);
  throw error;
} finally {
  docker(['rm', '-f', name], false);
  docker(['volume', 'rm', volume], false);
}
