// Compiled into MCPHub from reviewed source, never loaded through a runtime hook.
import type { Application, NextFunction, Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { getCurrentModuleDir } from './utils/moduleDir.js';
import { resolveCorsOrigin } from './utils/corsOrigin.js';
import {
  classifyPath, clientStateScope, credentialIdentity, hashToken, isRecord, modeEnvironment,
  modeForSettings, nativeHeader, PolicyError,
  readSettings, resolveCredential, routingOf, sameToken, systemConfigOf,
  validateKeyState, validateToken,
} from './uplinkSecurity.js';
import type { ModeEnvironment, RecordValue } from './uplinkSecurity.js';

export const POLICY_VERSION = 'uplinkcrate-auth-v1';

interface BootPolicy {
  version: string;
  nonce: string;
  mode: 'delegated' | 'legacy';
  reason: string;
  keyFile: string;
  settingsFile: string;
  statusFile: string;
  integrityFile: string;
  retired: string[];
  environment: ModeEnvironment;
}

interface Credential {
  token: string;
  bootstrap: boolean;
  identity: string;
}

let boot: BootPolicy | undefined;
let bootstrap: string | undefined;
const credentials = new WeakMap<Request, Credential>();

function getBoot(): BootPolicy | undefined {
  if (boot) return boot;
  const file = process.env.UPLINK_BOOT_FILE;
  if (!file) return undefined; // Unmodified upstream test and nonwrapper use.
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(value) || value.version !== POLICY_VERSION ||
      typeof value.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(value.nonce) ||
      !['delegated', 'legacy'].includes(String(value.mode)) ||
      !['keyFile', 'settingsFile', 'statusFile', 'integrityFile', 'reason'].every(
        (key) => typeof value[key] === 'string',
      ) || !isRecord(value.environment) ||
      !['database', 'hosted', 'customBasePath', 'replica', 'advancedAuth'].every(
        (key) => typeof (value.environment as RecordValue)[key] === 'boolean',
      ) || !Array.isArray(value.retired) ||
      !value.retired.every((hash: unknown) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))) {
    throw new PolicyError('Invalid wrapper startup policy.');
  }
  boot = value as unknown as BootPolicy;
  bootstrap = readFileSync(boot.keyFile, 'utf8');
  validateToken(bootstrap);
  return boot;
}

export const uplinkActive = (): boolean => getBoot()?.mode === 'delegated';
export const uplinkBootstrap = (req: Request): boolean => credentials.get(req)?.bootstrap === true;
export const uplinkIdentity = (req: Request): string | undefined => credentials.get(req)?.identity;
export const uplinkToken = (req: Request): string | undefined => credentials.get(req)?.token;
export function uplinkStateScope(req: Request, username?: string, group?: string): string | undefined {
  const credential = credentials.get(req);
  if (!credential) {
    if (uplinkActive()) throw new PolicyError('No authenticated application-state identity.');
    return undefined;
  }
  return clientStateScope(credential.identity, username, group);
}

function healthySettings(): RecordValue {
  const policy = getBoot();
  if (!policy || !bootstrap) throw new PolicyError('Wrapper startup policy is unavailable.');
  const settings = readSettings(policy.settingsFile);
  validateKeyState(settings, bootstrap, policy.retired);
  if (modeForSettings(settings, policy.environment).mode !== 'delegated') {
    throw new PolicyError('Settings no longer support delegated authentication; correct them or restart.');
  }
  return settings;
}

export function uplinkProjectConfig<T extends object>(system: T): T {
  if (!uplinkActive()) return system;
  return { ...system, routing: { ...routingOf(system as RecordValue), enableBearerAuth: true } };
}

export function uplinkCheckConfig(system: object): void {
  if (!uplinkActive()) return;
  if (routingOf(system as RecordValue).enableBearerAuth === false) {
    throw new PolicyError('UplinkCrate requires transport authentication; it cannot be disabled.');
  }
  const original = healthySettings();
  const settings = { ...original, systemConfig: system };
  if (modeForSettings(settings, getBoot()!.environment).mode !== 'delegated') {
    throw new PolicyError('This authentication setting requires a controlled restart in legacy mode.');
  }
  nativeHeader(system as RecordValue);
  // Settings handlers save a full projected object. Do not persist the
  // effective true flag over a legacy false/absent value during other edits.
  const stored = routingOf(systemConfigOf(original));
  const updated = routingOf(system as RecordValue);
  if (Object.prototype.hasOwnProperty.call(stored, 'enableBearerAuth')) {
    updated.enableBearerAuth = stored.enableBearerAuth;
    (system as RecordValue).routing = updated;
  } else delete updated.enableBearerAuth;
}

export function installUplinkSettingsPolicy(app: Application): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Installed after native JSON parsing and dashboard authentication.
    if (uplinkActive() && req.method === 'PUT' && /^\/api\/system-config\/?$/i.test(req.path) && isRecord(req.body)) {
      try {
        if (isRecord(req.body.routing) && req.body.routing.enableBearerAuth === false) {
          throw new PolicyError('UplinkCrate requires transport authentication; it cannot be disabled.');
        }
        const current = healthySettings();
        const system = systemConfigOf(current);
        const candidate = { ...system };
        if (isRecord(req.body.routing)) candidate.routing = { ...routingOf(system), ...req.body.routing };
        if (isRecord(req.body.auth)) candidate.auth = {
          ...(isRecord(system.auth) ? system.auth : {}), ...req.body.auth,
        };
        if (modeForSettings({ ...current, systemConfig: candidate }, getBoot()!.environment).mode !== 'delegated') {
          throw new PolicyError('This authentication setting requires a controlled restart in legacy mode.');
        }
        nativeHeader(candidate);
      } catch (error) {
        res.status(400).json({ success: false, message: error instanceof PolicyError
          ? error.message : 'Invalid authentication configuration.' });
        return;
      }
    }
    next();
  });
}

function checkIntegrity(policy: Pick<BootPolicy, 'integrityFile'>): void {
  const manifest: unknown = JSON.parse(readFileSync(policy.integrityFile, 'utf8'));
  if (!isRecord(manifest) || manifest.version !== POLICY_VERSION || !isRecord(manifest.files)) {
    throw new PolicyError('Wrapper integrity manifest is missing or invalid.');
  }
  const root = path.resolve(getCurrentModuleDir(), '..');
  for (const [relative, expected] of Object.entries(manifest.files)) {
    if (!/^[A-Za-z0-9_./-]+\.js$/.test(relative) || relative.split('/').includes('..')) {
      throw new PolicyError('Invalid wrapper integrity path.');
    }
    const actual = createHash('sha256').update(readFileSync(path.join(root, relative))).digest('hex');
    if (actual !== expected) throw new PolicyError('MCPHub code does not match the built wrapper policy.');
  }
  for (const required of ['server.js', 'uplinkPolicy.js', 'uplinkSecurity.js', 'services/sseService.js',
    'middlewares/userContext.js', 'dao/base/JsonFileBaseDao.js', 'dao/SystemConfigDao.js', 'config/index.js']) {
    if (typeof manifest.files[required] !== 'string') throw new PolicyError('Incomplete wrapper integrity manifest.');
  }
}

export function installUplinkPolicy(app: Application): void {
  const policy = getBoot();
  if (!policy) return;
  checkIntegrity(policy);
  if (!uplinkActive()) return;
  healthySettings(); // Before native initialization can migrate or write data.
  app.use((req: Request, res: Response, next: NextFunction) => {
    let family: ReturnType<typeof classifyPath>;
    try {
      family = classifyPath(req.originalUrl);
    } catch {
      res.status(400).json({ error: 'Ambiguous request path' });
      return;
    }
    if (family === 'health') { next(); return; }
    let settings: RecordValue;
    try {
      settings = healthySettings();
    } catch {
      res.status(503).json({ error: 'Authentication state unavailable; correct the settings or restart' });
      return;
    }
    const header = nativeHeader(systemConfigOf(settings));
    if (family === 'transport' && req.headers.origin) {
      const origin = resolveCorsOrigin(req.headers.origin, req.headers.host, process.env.ALLOWED_ORIGINS);
      if (origin === false) {
        res.status(403).json({ error: 'Origin not allowed' });
        return;
      }
      // Let allowed browser clients read authentication failures too, not just
      // responses that eventually reach native CORS middleware.
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.vary('Origin');
    }
    if (family === 'transport' && req.method === 'OPTIONS') {
      const method = req.headers['access-control-request-method'];
      const requested = req.headers['access-control-request-headers'];
      const names = typeof requested === 'string' ? requested.split(',').map((name) => name.trim().toLowerCase()) : [];
      const headerCount = req.rawHeaders.filter((name, index) => index % 2 === 0 &&
        name.toLowerCase() === 'access-control-request-headers').length;
      if (!req.headers.origin || typeof method !== 'string' ||
          !['GET', 'POST', 'DELETE'].includes(method) ||
          headerCount > 1 || new Set(names).size !== names.length ||
          (requested !== undefined && (typeof requested !== 'string' ||
            names.some((name) => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))))) {
        res.status(405).end();
        return;
      }
      // Preflight carries protocol metadata only. Actual operations below
      // still require native/bootstrap authentication and scope enforcement.
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      if (requested) {
        res.setHeader('Access-Control-Allow-Headers', requested);
        res.vary('Access-Control-Request-Headers');
      }
      res.status(204).end();
      return;
    }
    let credential: ReturnType<typeof resolveCredential>;
    try {
      credential = resolveCredential(req.headers, req.rawHeaders, header, bootstrap!);
    } catch {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'A single valid Bearer credential is required' });
      return;
    }
    if (family !== 'transport') {
      // The public proxy enforces this too. Do not turn its bearer into an
      // upstream system/all management login. JWT and query tokens are retained.
      const standard = req.headers.authorization;
      if (!credential.bootstrap || typeof standard !== 'string' ||
          !sameToken(standard, `Bearer ${bootstrap!}`)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.status(401).json({ error: 'Bootstrap authorization required' });
        return;
      }
      delete req.headers.authorization;
      delete req.headers[header];
      next();
      return;
    }
    try {
      credentials.set(req, {
        ...credential,
        identity: credentialIdentity(settings, credential.token, credential.bootstrap),
      });
    } catch {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Invalid bearer credential' });
      return;
    }
    // Native bearer validation supplies its own owner context. A simultaneous
    // dashboard JWT must not silently choose another transport identity.
    delete req.headers['x-auth-token'];
    // The pinned Express 4 query object is mutable. Recheck downstream
    // stripping when upgrading: Express 5 exposes req.query through a getter.
    delete req.query.token;
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
      res.status(405).end();
      return;
    }
    next();
  });
}

export function uplinkAuthorizeSession(
  req: Request, res: Response, session: { uplinkIdentity?: string } | undefined,
): boolean {
  if (!uplinkActive()) return true;
  if (!session) {
    res.status(404).json({ jsonrpc: '2.0', id: null, error: {
      code: -32001, message: 'Session not found. Please reinitialize the session.',
    } });
    return false;
  }
  if (!session.uplinkIdentity || session.uplinkIdentity !== uplinkIdentity(req)) {
    res.status(403).json({ error: 'Session belongs to another credential or permission state; reinitialize' });
    return false;
  }
  return true;
}

function atomicJson(file: string, value: object): void {
  const temporary = `${file}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function signalUplinkReady(): void {
  const policy = getBoot();
  if (!policy) return;
  if (uplinkActive()) healthySettings();
  atomicJson(policy.statusFile, {
    version: POLICY_VERSION, nonce: policy.nonce, pid: process.pid,
    mode: policy.mode, reason: policy.reason,
  });
  console.log(`UplinkCrate authentication: ${policy.mode} (${policy.reason}).`);
}

export function caddyConfig(key: string, port: string, internalPort: string, delegated: boolean): object {
  validateToken(key);
  for (const value of [port, internalPort]) {
    if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) throw new PolicyError('Invalid proxy port.');
  }
  if (port === internalPort) throw new PolicyError('Public and internal ports must differ.');
  const upstream = { handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${internalPort}` }],
    headers: { request: { delete: ['X-Forwarded-For'] } } };
  const authenticated = { header: { Authorization: [`Bearer ${key}`] } };
  const denied = { not: [authenticated] };
  const reject = [{ handler: 'static_response', status_code: 401, body: 'Unauthorized' }];
  const management = { path_regexp: { pattern: '(?i)^/api(?:/|$)' } };
  const routes: object[] = [
    { match: [{ path: ['/health'] }], handle: [upstream], terminal: true },
  ];
  if (delegated) routes.push(
    { match: [{ ...management, ...denied }], handle: reject, terminal: true },
    { match: [management], handle: [upstream], terminal: true },
    { match: [{ path_regexp: { pattern: '(?i)^/(?:[^/]+/)?(?:mcp(?:/.*)?|sse(?:/.*)?|messages)$' } }], handle: [upstream], terminal: true },
  );
  routes.push({ match: [denied], handle: reject, terminal: true }, { handle: [upstream], terminal: true });
  return { admin: { disabled: true }, apps: { http: { servers: {
    uplink: { listen: [`:${port}`], routes },
  } } } };
}

async function cli(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'validate-key') {
    validateToken(readFileSync(0, 'utf8'));
    return;
  }
  if (command === 'prepare') {
    // Match config/index.ts: .env is loaded from the actual /app cwd and does
    // not override exported environment. Do not export plain shell assignments.
    const dotenv = await import('dotenv');
    dotenv.config({ quiet: true });
    const [keyFile, settingsFile, runtimeDirectory, integrityFile, previousKeyFile] = args;
    if (!keyFile || !settingsFile || !runtimeDirectory || !integrityFile) throw new PolicyError('Missing startup arguments.');
    // Check before spawning the application too: an old mounted server may not
    // execute our in-process hook and must never briefly open a raw listener.
    checkIntegrity({ integrityFile });
    const key = readFileSync(keyFile, 'utf8');
    validateToken(key);
    const settings = readSettings(settingsFile);
    const retired: string[] = [];
    if (previousKeyFile) {
      const previous = readFileSync(previousKeyFile, 'utf8');
      validateToken(previous);
      if (!sameToken(previous, key)) retired.push(hashToken(previous));
    }
    const environment = modeEnvironment(process.env);
    const mode = modeForSettings(settings, environment);
    if (mode.mode === 'delegated') validateKeyState(settings, key, retired);
    mkdirSync(runtimeDirectory, { mode: 0o700, recursive: true });
    chmodSync(runtimeDirectory, 0o700);
    const statusFile = path.join(runtimeDirectory, 'status.json');
    rmSync(statusFile, { force: true });
    atomicJson(path.join(runtimeDirectory, 'boot.json'), {
      version: POLICY_VERSION, nonce: randomBytes(32).toString('hex'),
      ...mode, keyFile, settingsFile, statusFile, integrityFile, retired, environment,
    });
    console.log(`Prepared ${mode.mode} authentication (${mode.reason}).`);
    return;
  }
  if (command === 'verify-ready') {
    const policy = getBoot();
    if (!policy) throw new PolicyError('Missing startup policy.');
    const ready: unknown = JSON.parse(readFileSync(policy.statusFile, 'utf8'));
    if (!isRecord(ready) || ready.version !== POLICY_VERSION || ready.nonce !== policy.nonce ||
        ready.mode !== policy.mode || ready.pid !== Number(args[0])) {
      throw new PolicyError('Running MCPHub did not confirm the expected wrapper policy.');
    }
    return;
  }
  if (command === 'proxy') {
    const policy = getBoot();
    if (!policy || !bootstrap) throw new PolicyError('Missing startup policy.');
    process.stdout.write(JSON.stringify(caddyConfig(bootstrap, args[0], args[1], policy.mode === 'delegated')) + '\n');
    return;
  }
  if (command === 'status') {
    const policy = getBoot();
    if (!policy) throw new PolicyError('Missing startup policy.');
    if (uplinkActive()) healthySettings();
    console.log(`Authentication: ${policy.mode} (${policy.reason})`);
    return;
  }
  throw new PolicyError('Unknown wrapper policy command.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(getCurrentModuleDir(), '..', 'uplinkPolicy.js')) {
  cli().catch((error: unknown) => {
    console.error(error instanceof PolicyError ? `Error: ${error.message}`
      : 'Error: wrapper policy preparation or verification failed. Check configuration and image integrity.');
    process.exitCode = 1;
  });
}
