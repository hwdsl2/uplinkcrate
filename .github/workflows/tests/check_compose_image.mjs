// Host driver for one isolated Compose project; package code runs in its image.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { docker, root, waitForStartup } from './image_helpers.mjs';

assert.equal(process.arch, 'arm64');
const [image, prefix] = process.argv.slice(2);
assert(image && /^[a-z0-9-]+$/.test(prefix || ''));
docker(['compose', 'version']);
const scratch = path.join(process.env.RUNNER_TEMP || tmpdir(), prefix);
const data = path.join(scratch, 'data'), client = path.join(scratch, 'client');
mkdirSync(scratch, { mode: 0o700 }); mkdirSync(data, { mode: 0o700 }); mkdirSync(client, { mode: 0o700 });
const file = path.join(scratch, 'compose.json'), envFile = path.join(scratch, 'mcp.env');
const consumer = path.join(process.env.RUNNER_TEMP || tmpdir(), 'uplink-consumer-arm64.cjs');
const name = prefix + '-gateway', probe = prefix + '-probe', network = prefix + '-network';
const env = 'MCP_API_KEY=compose-env-bootstrap\nMCP_PORT=3000\nMCP_HOST=fixture.invalid\nMCP_DISABLE_USAGE_COUNTS=1\n';
writeFileSync(envFile, env, { mode: 0o600 });
const bind = (source, target, readOnly = true) => ({ type: 'bind', source, target, read_only: readOnly,
  bind: { create_host_path: false } });
writeFileSync(file, JSON.stringify({ services: { gateway: {
  image, pull_policy: 'never', container_name: name,
  environment: { MCP_API_KEY: 'stale-container-fixture', MCP_PORT: '3200' },
  volumes: [bind(data, '/var/lib/mcp', false), bind(envFile, '/mcp.env'), bind(root, '/wrapper')],
} }, networks: { default: { name: network } } }), { mode: 0o600 });
const composeArgs = (...args) => ['compose', '--project-name', prefix, '--project-directory', scratch, '-f', file, ...args];
const compose = (...args) => docker(composeArgs(...args));
const helper = '/wrapper/.github/workflows/tests/check_compose_client.mjs';
function runProbe(phase) {
  docker(['run', '--rm', '--name', probe, '--network', network, '--entrypoint', 'node',
    '--mount', `type=bind,src=${root},dst=/wrapper,readonly`,
    '--mount', `type=bind,src=${data},dst=/state,readonly`,
    '--mount', `type=bind,src=${client},dst=/client`,
    '--mount', `type=bind,src=${consumer},dst=/fixtures/anythingllm-hypervisor.cjs,readonly`,
    '--mount', `type=bind,src=${consumer}.LICENSE,dst=/fixtures/anythingllm-LICENSE,readonly`,
    image, helper, phase, `http://${name}:3000`], true, 180000);
}
let failure, failed = false;
try {
  const expected = docker(['image', 'inspect', '-f', '{{.Id}}', image]).stdout.trim();
  assert.equal(docker(['image', 'inspect', '-f', '{{.Architecture}}', image]).stdout.trim(), 'arm64');
  docker(['run', '--rm', '--name', probe, '--entrypoint', 'node',
    '--mount', `type=bind,src=${root},dst=/wrapper,readonly`,
    '--mount', `type=bind,src=${data},dst=/state`, image, helper, 'seed']);
  for (const phase of ['initial', 'restart']) {
    compose('up', '-d', '--no-build', '--pull', 'never', ...(phase === 'restart' ? ['--force-recreate'] : []));
    await waitForStartup(name);
    assert.equal(docker(['inspect', '-f', '{{.Image}}', name]).stdout.trim(), expected);
    assert(docker(['exec', name, 'mcp_manage', '--status']).stdout.includes('Authentication: delegated'));
    assert.equal(docker(['exec', name, 'mcp_manage', '--getkey']).stdout.trim(), 'compose-env-bootstrap');
    runProbe(phase);
    assert.equal(readFileSync(envFile, 'utf8'), env, 'The read-only env source changed');
  }
} catch (error) {
  failure = error;
  failed = true;
} finally {
  docker(['rm', '-f', probe], false);
  // Attempt every owned resource even if Compose teardown fails. Preserve the
  // original test error; the workflow retries cleanup after driver interruption.
  const down = docker(composeArgs('down', '--volumes', '--remove-orphans'), false);
  docker(['rm', '-f', name], false);
  docker(['network', 'rm', network], false);
  const scrub = docker(['run', '--rm', '--entrypoint', 'node',
    '--mount', `type=bind,src=${scratch},dst=/cleanup`, image, '-e',
    "const fs=require('fs'); for(const name of ['data','client']) fs.rmSync('/cleanup/'+name,{recursive:true,force:true});"], false);
  let removalError;
  try { rmSync(scratch, { recursive: true, force: true }); }
  catch (error) { removalError = error; }
  if (down.status !== 0 || scrub.status !== 0 || removalError) {
    console.error('Owned Compose fixture cleanup failed; the workflow fallback will retry.');
    if (!failed) { failure = removalError || new Error('Owned Compose fixture cleanup failed'); failed = true; }
  }
}
if (failed) throw failure;
