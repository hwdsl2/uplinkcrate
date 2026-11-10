// Apply only to the exact published MCPHub v1.2.2 source. No fuzzy patches.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2] || '/app');
const here = path.dirname(fileURLToPath(import.meta.url));
const sources = {
  'src/server.ts': 'efa88e5654704336115a4ab3fc7a73a776333b48f91d33806341150e0f709ac9',
  'src/services/sseService.ts': '9c7b3aed68683a5f65030723641a7746f2f3b0a674b81777a1ef5dd0af096de8',
  'src/middlewares/userContext.ts': '4904d79bf58585cd982bd8fca88c05bd672a6b9b70d9bf53c4ff1c0066e0d7c2',
  'src/config/index.ts': 'a3082fb1cc8d4c91e7da4e7bbc0ade09ca0d1df8d4e0e7130fd7e44bf4517444',
  'src/dao/base/JsonFileBaseDao.ts': 'bc26559422c1136138f89c8a359bd62ebdf06bd7d4c1d7a60af548fb4e9a7703',
  'src/dao/SystemConfigDao.ts': 'be6c55bb8b7eb70be037a565048530ee5026e86990a6086f6c0212f85c35b491',
};

if (process.argv[3] === '--manifest') {
  const files = {};
  function collect(relative = '') {
    for (const entry of readdirSync(path.join(root, 'dist', relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collect(name);
      else if (entry.isFile() && name.endsWith('.js')) {
        files[name] = createHash('sha256').update(readFileSync(path.join(root, 'dist', name))).digest('hex');
      }
    }
  }
  collect();
  process.stdout.write(JSON.stringify({ version: 'uplinkcrate-auth-v1', upstream: '1.2.2', files }) + '\n');
  process.exit(0);
}

const contents = {};
for (const [relative, expected] of Object.entries(sources)) {
  const bytes = readFileSync(path.join(root, relative));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`Unsupported upstream source: ${relative}`);
  }
  contents[relative] = bytes.toString('utf8');
}

function replace(file, before, after, expected = 1) {
  const count = contents[file].split(before).length - 1;
  if (count !== expected) throw new Error(`Unexpected patch context in ${file}: expected ${expected}, got ${count}`);
  contents[file] = contents[file].split(before).join(after);
}

const server = 'src/server.ts';
contents[server] = "import { installUplinkPolicy, installUplinkSettingsPolicy, signalUplinkReady } from './uplinkPolicy.js';\n" + contents[server];
replace(server, '    this.app = express();', '    this.app = express();\n    installUplinkPolicy(this.app);');
replace(server, '      initMiddlewares(this.app);', '      initMiddlewares(this.app);\n      installUplinkSettingsPolicy(this.app);');
replace(server, '    this.server = this.app.listen(this.port, () => {', "    this.server = this.app.listen(Number(this.port), '127.0.0.1', () => {");
replace(server, '          await startReplicaSync(reconcileReplicaServers);', '          await startReplicaSync(reconcileReplicaServers);\n          signalUplinkReady();');

const context = 'src/middlewares/userContext.ts';
contents[context] = "import { uplinkActive } from '../uplinkPolicy.js';\n" + contents[context];
replace(context, '    const username = req.params.user;', `    if (uplinkActive()) {
      await userContextService.runWithContext(async () => { next(); });
      return;
    }
    const username = req.params.user;`);

const dao = 'src/dao/base/JsonFileBaseDao.ts';
contents[dao] = "import { uplinkActive } from '../../uplinkPolicy.js';\n" + contents[dao];
replace(dao, '        this.settingsCache &&', '        !uplinkActive() && this.settingsCache &&');
replace(dao, '      if (failClosed) throw error;', "      if (uplinkActive()) throw new Error('Settings unavailable; refusing default recovery');\n      if (failClosed) throw error;");

const config = 'src/config/index.ts';
contents[config] = "import { uplinkActive } from '../uplinkPolicy.js';\n" + contents[config];
replace(config, '  if (settingsCache) {', '  if (settingsCache && !uplinkActive()) {');
replace(config, '  if (!fs.existsSync(settingsPath)) {', "  if (!fs.existsSync(settingsPath)) {\n    if (uplinkActive()) throw new Error('Settings file unavailable; refusing default recovery');");
replace(config, '    throw new Error(`Failed to load settings from ${settingsPath}: ${error}`, { cause: error });', "    if (uplinkActive()) throw new Error('Settings invalid; refusing default recovery');\n    throw new Error(`Failed to load settings from ${settingsPath}: ${error}`, { cause: error });");

const system = 'src/dao/SystemConfigDao.ts';
contents[system] = "import { uplinkCheckConfig, uplinkProjectConfig } from '../uplinkPolicy.js';\n" + contents[system];
replace(system, '      return config;', '      return uplinkProjectConfig(config);');
replace(system, '    return migratedConfig;', '    return uplinkProjectConfig(migratedConfig);');
replace(system, '    settings.systemConfig = updatedConfig;', '    uplinkCheckConfig(updatedConfig);\n    settings.systemConfig = updatedConfig;');
replace(system, '    settings.systemConfig = defaultConfig;', '    uplinkCheckConfig(defaultConfig);\n    settings.systemConfig = defaultConfig;');
replace(system, '    return updatedConfig;', '    return uplinkProjectConfig(updatedConfig);');
replace(system, '    return defaultConfig;', '    return uplinkProjectConfig(defaultConfig);');

const sse = 'src/services/sseService.ts';
contents[sse] = "import { uplinkActive, uplinkBootstrap, uplinkIdentity, uplinkToken, uplinkStateScope, uplinkAuthorizeSession } from '../uplinkPolicy.js';\n" + contents[sse];
replace(sse, 'export interface SessionContext {', 'export interface SessionContext {\n  uplinkIdentity?: string;');
replace(sse, '  const enableBearerAuth = systemConfig?.routing?.enableBearerAuth ?? true;', '  const enableBearerAuth = uplinkActive() || (systemConfig?.routing?.enableBearerAuth ?? true);');
replace(sse, '  const bearerKeyDao = getBearerKeyDao();', `  if (uplinkActive() && uplinkBootstrap(req)) {
    return { valid: true, keyId: 'uplink-bootstrap', keyName: 'Bootstrap', kind: 'system' };
  }
  const bearerKeyDao = getBearerKeyDao();`);
replace(sse, '  const session = sessionId ? transports[sessionId] : undefined;', '  const session = sessionId ? transports[sessionId] : undefined;\n  if (sessionId && !uplinkAuthorizeSession(req, res, session)) return false;');
replace(sse, '  transports[transport.sessionId] = {\n    transport,', '  transports[transport.sessionId] = {\n    uplinkIdentity: uplinkIdentity(req),\n    transport,');
replace(sse, `async function createNewSession(
  group: string,
  username?: string,
  hostedAuth?: HostedAuthContext,`, `async function createNewSession(
  group: string,
  username?: string,
  hostedAuth?: HostedAuthContext,
  uplinkIdentity?: string,`);
// Only new sessions acquire an identity. Unknown/rebuilt sessions fail closed.
const newSessionStart = contents[sse].indexOf('async function createNewSession(');
const newSessionEnd = contents[sse].indexOf('export const handleMcpPostRequest', newSessionStart);
if (newSessionStart < 0 || newSessionEnd < 0) throw new Error('New session function not found');
const newSession = contents[sse].slice(newSessionStart, newSessionEnd);
if (newSession.split('transports[sessionId] = { transport, group, hostedAuth };').length !== 2) throw new Error('Unexpected session initialization');
contents[sse] = contents[sse].slice(0, newSessionStart) + newSession.replace(
  'transports[sessionId] = { transport, group, hostedAuth };',
  'transports[sessionId] = { transport, group, hostedAuth, uplinkIdentity };',
) + contents[sse].slice(newSessionEnd);
replace(sse, 'createNewSession(group, username, bearerAuthResult.hostedAuth)', 'createNewSession(group, username, bearerAuthResult.hostedAuth, uplinkIdentity(req))');
replace(sse, `        bearerAuthResult.keyName === FORWARD_AUTH_METHOD_LABEL
          ? getForwardAuthTokenFromHeaders(req.headers, systemConfig)
          : getBearerTokenFromHeaders(req.headers, systemConfig);`, `        uplinkToken(req) ?? (bearerAuthResult.keyName === FORWARD_AUTH_METHOD_LABEL
          ? getForwardAuthTokenFromHeaders(req.headers, systemConfig)
          : getBearerTokenFromHeaders(req.headers, systemConfig));`);
replace(sse, '      if (token && (systemConfig?.routing?.enableBearerAuth ?? true)) {', '      if (token && (uplinkActive() || (systemConfig?.routing?.enableBearerAuth ?? true))) {');
replace(sse, `        context.clientStateScope = createHash('sha256')
          .update(JSON.stringify([token, username || '', group || '']))
          .digest('hex');`, `        context.clientStateScope = uplinkStateScope(req, username, group) ?? createHash('sha256')
          .update(JSON.stringify([token, username || '', group || '']))
          .digest('hex');`);

// All contexts and hashes have been verified before any source is overwritten.
for (const [relative, content] of Object.entries(contents)) writeFileSync(path.join(root, relative), content);
copyFileSync(path.join(here, 'security.ts'), path.join(root, 'src/uplinkSecurity.ts'));
copyFileSync(path.join(here, 'uplink-policy.ts'), path.join(root, 'src/uplinkPolicy.ts'));
console.log('Applied reviewed UplinkCrate policy to MCPHub v1.2.2 source.');
