// Exercise actual Linux mount-point unlink failure, not simulated file modes.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanups } from './image_scenarios.mjs';
import { docker, edit, inspectVolume, root, seed, waitForStartup } from './image_helpers.mjs';

const [image, prefix, network] = process.argv.slice(2);
assert(image && /^[a-z0-9-]+$/.test(prefix || '') && /^[a-z0-9-]+$/.test(network || ''));
const scratch = path.join(process.env.RUNNER_TEMP || tmpdir(), prefix);
mkdirSync(scratch, { mode: 0o700 });
const mounted = path.join(scratch, 'Caddyfile');
const obsolete = 'DO_NOT_LOG_OBSOLETE_SECRET';
writeFileSync(mounted, obsolete, { mode: 0o600 });
try {
  for (const scenario of cleanups) {
    const name = `${prefix}-${scenario}`, volume = `${name}-data`;
    try {
      docker(['volume', 'create', volume]); seed(image, volume);
      if (scenario === 'file') edit(image, volume,
        `fs.writeFileSync('/state/.Caddyfile',${JSON.stringify(obsolete)},{mode:0o600});`);
      if (scenario === 'symlink') edit(image, volume, `
        fs.writeFileSync('/state/keep-target',${JSON.stringify(obsolete)},{mode:0o600});
        fs.symlinkSync('/var/lib/mcp/keep-target','/state/.Caddyfile');`);
      if (scenario === 'directory') edit(image, volume, "fs.mkdirSync('/state/.Caddyfile');");
      docker(['run', '-d', '--name', name, '--network', network,
        '-e', 'MCP_DISABLE_USAGE_COUNTS=1', '-e', 'MCP_HOST=fixture.invalid',
        '-v', `${root}:/wrapper:ro`, '-v', `${volume}:/var/lib/mcp`,
        ...(scenario === 'bind' ? ['--mount', `type=bind,src=${mounted},dst=/var/lib/mcp/.Caddyfile,readonly`] : []), image]);
      await waitForStartup(name);
      inspectVolume(image, volume, network, name, 'check', 'boundary');
      inspectVolume(image, volume, network, name);
      const result = docker(['logs', name]), logs = result.stdout + result.stderr;
      const warnings = logs.split(/\r?\n/).filter((line) => line.includes('Could not remove obsolete proxy configuration'));
      assert.equal(warnings.length, ['directory', 'bind'].includes(scenario) ? 1 : 0);
      assert(!logs.includes(obsolete), 'Cleanup disclosed obsolete secret material');
      edit(image, volume, `const assert=require('assert/strict');
        ${scenario === 'directory' ? "assert(fs.statSync('/state/.Caddyfile').isDirectory());" : ''}
        ${['missing', 'file', 'symlink'].includes(scenario) ? "assert(!fs.existsSync('/state/.Caddyfile')); assert.throws(()=>fs.lstatSync('/state/.Caddyfile'));" : ''}
        ${scenario === 'symlink' ? `assert.equal(fs.readFileSync('/state/keep-target','utf8'),${JSON.stringify(obsolete)});` : ''}`);
      if (scenario === 'bind') {
        const mounts = JSON.parse(docker(['inspect', '-f', '{{json .Mounts}}', name]).stdout);
        assert(mounts.some((mount) => mount.Type === 'bind' && mount.Destination === '/var/lib/mcp/.Caddyfile' && !mount.RW));
        assert.equal(readFileSync(mounted, 'utf8'), obsolete);
      }
    } finally { docker(['rm', '-f', name], false); docker(['volume', 'rm', volume], false); }
  }
  console.log('PASS: obsolete-file cleanup is narrow, symlink-safe and nonfatal for directories/file binds');
} finally { rmSync(scratch, { recursive: true, force: true }); }
