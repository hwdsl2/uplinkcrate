// Linux CI only: preflight preserves exact bytes; recovery is explicit.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { failures } from './image_scenarios.mjs';
import { docker, edit, inspectVolume, root, seed, sleep, waitForStartup } from './image_helpers.mjs';

const [image, prefix, network] = process.argv.slice(2);
assert(image && /^[a-z0-9-]+$/.test(prefix || '') && /^[a-z0-9-]+$/.test(network || ''));
const scratch = path.join(process.env.RUNNER_TEMP || tmpdir(), prefix);
mkdirSync(scratch, { mode: 0o700 });
const badServer = path.join(scratch, 'server.js');
writeFileSync(badServer, 'throw new Error("Obsolete mounted server must never execute");\n');
const bootstrap = 'custom-image-upgrade-bootstrap';
const snapshots = (volume) => JSON.parse(edit(image, volume, [
  "console.log(JSON.stringify(Object.fromEntries(['.api_key','mcp_settings.json','.Caddyfile'].map(name =>",
  "[name,fs.existsSync('/state/'+name)?fs.readFileSync('/state/'+name).toString('base64'):null]))));",
].join('')).stdout);
const cases = [
  { name: 'bad-key', env: ['MCP_API_KEY=DO_NOT_LOG_INVALID_SECRET*'],
    diagnostic: 'API key must be a nonempty', secret: 'DO_NOT_LOG_INVALID_SECRET' },
  { name: 'bad-json', edit: 'fs.writeFileSync(file, \'{"sensitive":"DO_NOT_LOG_JSON_SECRET",\')',
    diagnostic: 'settings are missing, unreadable or invalid', secret: 'DO_NOT_LOG_JSON_SECRET' },
  { name: 'collision', edit: 'const value=JSON.parse(fs.readFileSync(file)); value.bearerKeys.push({...value.bearerKeys[0],id:"duplicate"}); fs.writeFileSync(file,JSON.stringify(value))',
    diagnostic: 'Duplicate native credentials' },
  { name: 'old-code', mounts: ['-v', badServer + ':/app/dist/server.js:ro'],
    diagnostic: 'does not match the built wrapper policy' },
  ...[['saved-lf', '\n'], ['saved-crlf', '\r\n'], ['saved-override', '\n']].map(([name, suffix]) => ({
    name, edit: "fs.writeFileSync('/state/.api_key'," + JSON.stringify(bootstrap + suffix) + ")",
    diagnostic: name === 'saved-override' ? 'API key must be a nonempty' : 'saved API key is invalid',
    ...(name === 'saved-override' ? { env: ['MCP_API_KEY=' + bootstrap], recovery: true } : {}),
    secret: bootstrap,
  })),
  { name: 'bootstrap-collision', env: ['MCP_API_KEY=' + bootstrap],
    edit: "fs.unlinkSync('/state/.api_key'); const value=JSON.parse(fs.readFileSync(file)); value.bearerKeys[0].token=" +
      JSON.stringify(bootstrap) + "; fs.writeFileSync(file,JSON.stringify(value));",
    diagnostic: 'Native key collides', secret: bootstrap },
];
assert.deepEqual(cases.map((value) => value.name), failures);
try {
  for (const scenario of cases) {
    const name = prefix + '-' + scenario.name, volume = name + '-data';
    const launch = () => docker(['run', '-d', '--name', name, '--network', network,
      '-e', 'MCP_DISABLE_USAGE_COUNTS=1', '-e', 'MCP_HOST=fixture.invalid',
      ...(scenario.env || []).flatMap((value) => ['-e', value]),
      '-v', volume + ':/var/lib/mcp', '-v', root + ':/wrapper:ro', ...(scenario.mounts || []), image]);
    try {
      docker(['volume', 'create', volume]); seed(image, volume);
      edit(image, volume, "fs.writeFileSync('/state/.Caddyfile','DO_NOT_LOG_OBSOLETE_SECRET',{mode:0o600});");
      if (scenario.edit) edit(image, volume, scenario.edit);
      const before = snapshots(volume);
      launch();
      let stopped = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (docker(['inspect', '-f', '{{.State.Running}}', name]).stdout.trim() === 'false') { stopped = true; break; }
        await sleep(100);
      }
      assert(stopped, scenario.name + ': unsafe startup did not stop promptly');
      assert.notEqual(docker(['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim(), '0');
      const result = docker(['logs', name]), logs = result.stdout + result.stderr;
      assert(logs.includes(scenario.diagnostic), scenario.name + ': expected a useful diagnostic');
      assert(!logs.includes('Starting MCPHub server...'), 'Preflight must fail before application startup');
      for (const secret of [scenario.secret, 'DO_NOT_LOG_OBSOLETE_SECRET'].filter(Boolean)) {
        assert(!logs.includes(secret), 'Startup diagnostics disclosed a secret');
      }
      assert(!logs.includes('Obsolete mounted server must never execute'));
      assert.deepEqual(snapshots(volume), before, scenario.name + ': preflight changed saved bytes');
      if (scenario.recovery) {
        // Deliberate operator action with the same independently known bootstrap.
        docker(['rm', name]);
        edit(image, volume, "fs.unlinkSync('/state/.api_key');");
        launch(); await waitForStartup(name);
        inspectVolume(image, volume, network, name, 'check');
        inspectVolume(image, volume, network, name);
        edit(image, volume, "const assert=require('assert/strict');" +
          "assert.equal(fs.readFileSync('/state/.api_key','utf8')," + JSON.stringify(bootstrap) + ");" +
          "assert.equal(fs.statSync('/state/.api_key').mode & 0o777,0o600);" +
          "assert(!fs.existsSync('/state/.Caddyfile'));");
      }
    } finally {
      docker(['rm', '-f', name], false); docker(['volume', 'rm', volume], false);
    }
  }
  console.log('PASS: preflight preserves exact bytes, explicit same-key recovery works, and collisions still fail');
} finally { rmSync(scratch, { recursive: true, force: true }); }
