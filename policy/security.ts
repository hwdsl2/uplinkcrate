// UplinkCrate's wrapper boundary. Native MCPHub remains responsible for scopes.
// This module has no startup side effects and never writes application settings.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type RecordValue = Record<string, unknown>;
export type PolicyMode = { mode: 'delegated' | 'legacy'; reason: string };
export interface ModeEnvironment {
  database: boolean;
  hosted: boolean;
  customBasePath: boolean;
  replica: boolean;
  advancedAuth: boolean;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const hashToken = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const sameToken = (left: string, right: string): boolean =>
  timingSafeEqual(Buffer.from(hashToken(left), 'hex'), Buffer.from(hashToken(right), 'hex'));

export const clientStateScope = (identity: string, username?: string, group?: string): string =>
  hashToken(JSON.stringify([identity, username || '', group || '']));

export function validateToken(token: unknown): asserts token is string {
  // RFC 6750 b64token. In particular, never treat a Caddy wildcard as a secret.
  if (typeof token !== 'string' || token.length > 8192 ||
      /[^\x21-\x7e]/.test(token) ||
      !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) {
    throw new PolicyError('API key must be a nonempty, single HTTP bearer token of at most 8192 ASCII characters.');
  }
}

export function readSettings(file: string): RecordValue {
  try {
    const settings: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!isRecord(settings) || !isRecord(settings.mcpServers)) throw new Error();
    if (settings.systemConfig !== undefined && !isRecord(settings.systemConfig)) throw new Error();
    if (settings.bearerKeys !== undefined && !Array.isArray(settings.bearerKeys)) throw new Error();
    if (settings.users !== undefined && !Array.isArray(settings.users)) throw new Error();
    if (Array.isArray(settings.users)) {
      for (const user of settings.users) {
        if (!isRecord(user) || typeof user.username !== 'string' || !user.username ||
            (user.isAdmin !== undefined && typeof user.isAdmin !== 'boolean') ||
            (user.userGroups !== undefined && (!Array.isArray(user.userGroups) ||
              !user.userGroups.every((group) => typeof group === 'string')))) throw new Error();
      }
    }
    return settings;
  } catch {
    // A parser's exception can include source text and therefore credentials.
    throw new PolicyError('MCPHub settings are missing, unreadable or invalid; restore the settings file.');
  }
}

export const systemConfigOf = (settings: RecordValue): RecordValue => {
  if (settings.systemConfig === undefined) return {};
  if (!isRecord(settings.systemConfig)) throw new PolicyError('Invalid system configuration.');
  return settings.systemConfig;
};

export const routingOf = (system: RecordValue): RecordValue => {
  if (system.routing === undefined) return {};
  if (!isRecord(system.routing)) throw new PolicyError('Invalid routing configuration.');
  return system.routing;
};

export function nativeHeader(system: RecordValue): string {
  const value = routingOf(system).bearerAuthHeaderName;
  if (value !== undefined && typeof value !== 'string') {
    throw new PolicyError('Invalid native bearer header name.');
  }
  const header = (value?.trim() || 'Authorization').toLowerCase();
  const reserved = new Set([
    'host', 'cookie', 'set-cookie', 'origin', 'referer', 'accept', 'content-type',
    'content-length', 'content-encoding', 'connection', 'upgrade', 'te', 'trailer',
    'transfer-encoding', 'keep-alive', 'x-auth-token', 'last-event-id',
    'mcp-session-id', 'mcp-protocol-version', 'forwarded', 'via',
  ]);
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header) || reserved.has(header) ||
      /^(?:x-forwarded-|proxy-|sec-|mcp-|x-mcphub-)/.test(header)) {
    throw new PolicyError('Native bearer header conflicts with HTTP, proxy or dashboard authentication.');
  }
  return header;
}

export function modeEnvironment(env: NodeJS.ProcessEnv): ModeEnvironment {
  // Keep only mode decisions, never database URLs or identity-provider secrets.
  // Upstream normalizes '/' and repeated trailing slashes to the root path.
  const basePath = env.BASE_PATH?.trim().replace(/\/+$/, '') || '';
  return {
    database: env.USE_DB !== undefined ? env.USE_DB === 'true' : Boolean(env.DB_URL),
    hosted: env.HUB_MODE === 'hosted',
    customBasePath: Boolean(basePath),
    replica: env.MCPHUB_REPLICA_MODE === 'true',
    advancedAuth: Boolean((env.FORWARD_AUTH_ENABLED && env.FORWARD_AUTH_ENABLED !== 'false') ||
      (env.BETTER_AUTH_ENABLED && env.BETTER_AUTH_ENABLED !== 'false')),
  };
}

export function modeForSettings(settings: RecordValue, env: ModeEnvironment): PolicyMode {
  if (env.database) return { mode: 'legacy', reason: 'database storage' };
  if (env.hosted) return { mode: 'legacy', reason: 'hosted mode' };
  if (env.customBasePath) return { mode: 'legacy', reason: 'custom base path' };
  if (env.replica) return { mode: 'legacy', reason: 'replica mode' };
  const system = systemConfigOf(settings);
  const routing = routingOf(system);
  if (routing.skipAuth) return { mode: 'legacy', reason: 'dashboard skipAuth' };
  const auth = isRecord(system.auth) ? system.auth : {};
  const forward = isRecord(auth.forwardAuth) ? auth.forwardAuth : {};
  const better = isRecord(auth.betterAuth) ? auth.betterAuth : {};
  if (forward.enabled || better.enabled || env.advancedAuth) {
    return { mode: 'legacy', reason: 'advanced identity provider' };
  }
  try {
    nativeHeader(system);
  } catch {
    return { mode: 'legacy', reason: 'reserved or invalid bearer header' };
  }
  return { mode: 'delegated', reason: 'mandatory wrapper transport authentication' };
}

export const selectMode = (settings: RecordValue, env: NodeJS.ProcessEnv): PolicyMode =>
  modeForSettings(settings, modeEnvironment(env));

export function tokenHashOf(key: RecordValue): string | undefined {
  const raw = key.token;
  const stored = key.tokenHash;
  if (raw !== undefined && typeof raw !== 'string') throw new PolicyError('Invalid native key.');
  if (stored !== undefined && (typeof stored !== 'string' || stored.length !== 64 || !/^[0-9a-f]{64}$/.test(stored))) {
    throw new PolicyError('Invalid native key hash.');
  }
  if (raw && stored && hashToken(raw) !== stored) {
    throw new PolicyError('Native key has conflicting raw and hashed credentials.');
  }
  return typeof stored === 'string' ? stored : (raw ? hashToken(raw) : undefined);
}

export function validateKeyState(settings: RecordValue, bootstrap: string, retired: string[] = []): void {
  validateToken(bootstrap);
  const forbidden = new Set([hashToken(bootstrap), ...retired]);
  const seen = new Set<string>();
  let keys: unknown[];
  if (Array.isArray(settings.bearerKeys)) {
    keys = settings.bearerKeys;
  } else {
    const legacy = routingOf(systemConfigOf(settings)).bearerAuthKey;
    if (legacy !== undefined && typeof legacy !== 'string') throw new PolicyError('Invalid legacy key.');
    keys = legacy ? [{ token: legacy }] : [];
  }
  for (const key of keys) {
    if (!isRecord(key)) throw new PolicyError('Invalid native key record.');
    if ((key.enabled !== undefined && typeof key.enabled !== 'boolean') ||
        (key.kind !== undefined && !['system', 'user'].includes(String(key.kind))) ||
        (key.accessType !== undefined && !['all', 'groups', 'servers', 'custom', 'exclude'].includes(String(key.accessType))) ||
        (key.owner !== undefined && typeof key.owner !== 'string')) {
      throw new PolicyError('Invalid native key authentication state.');
    }
    for (const field of ['allowedGroups', 'allowedServers', 'excludedGroups', 'excludedServers']) {
      if (key[field] !== undefined && (!Array.isArray(key[field]) ||
          !(key[field] as unknown[]).every((value) => typeof value === 'string'))) {
        throw new PolicyError('Native key scopes must be string arrays.');
      }
    }
    const hash = tokenHashOf(key);
    if (!hash) continue;
    if (forbidden.has(hash)) {
      throw new PolicyError('Native key collides with a current or retired bootstrap key; choose distinct credentials.');
    }
    if (seen.has(hash)) throw new PolicyError('Duplicate native credentials require operator correction.');
    seen.add(hash);
  }
}

export type HeaderValues = Record<string, string | string[] | undefined>;

export function singleHeader(headers: HeaderValues, rawHeaders: string[], name: string): string | undefined {
  const normalized = name.toLowerCase();
  const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === normalized);
  let occurrences = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === normalized) occurrences++;
  }
  if (occurrences > 1 || values.length > 1 || (values[0] && Array.isArray(values[0][1]))) {
    throw new PolicyError('Duplicate authentication headers are not accepted.');
  }
  const value = values[0]?.[1];
  if (value !== undefined && (typeof value !== 'string' || /[\x00-\x1f\x7f,]/.test(value))) {
    throw new PolicyError('Malformed authentication header.');
  }
  return value as string | undefined;
}

function bearer(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^Bearer +([A-Za-z0-9._~+\/-]+=*) *$/i.exec(value);
  if (!match) throw new PolicyError('A single Bearer credential is required.');
  return match[1];
}

export function resolveCredential(
  headers: HeaderValues, rawHeaders: string[], header: string, bootstrap: string,
): { token: string; bootstrap: boolean } {
  const standard = bearer(singleHeader(headers, rawHeaders, 'authorization'));
  const custom = header === 'authorization' ? standard : bearer(singleHeader(headers, rawHeaders, header));
  if (standard && custom && !sameToken(standard, custom)) {
    throw new PolicyError('Conflicting authentication headers are not accepted.');
  }
  if (standard && sameToken(standard, bootstrap)) return { token: standard, bootstrap: true };
  if (!custom) throw new PolicyError('A Bearer credential in the configured header is required.');
  return { token: custom, bootstrap: sameToken(custom, bootstrap) };
}

export function classifyPath(url: string): 'health' | 'management' | 'transport' | 'other' {
  const rawPath = url.split('?', 1)[0];
  if (!rawPath.startsWith('/') || /[\\\x00-\x20\x7f]/.test(rawPath) || rawPath.includes('//')) {
    throw new PolicyError('Ambiguous request path is not supported.');
  }
  let segments: string[];
  try { segments = rawPath.split('/').map((segment) => decodeURIComponent(segment)); }
  catch { throw new PolicyError('Invalid encoded request path.'); }
  if (segments.some((segment) => segment === '.' || segment === '..' ||
      /[/\\\x00-\x1f\x7f]/.test(segment) || /%[0-9a-f]{2}/i.test(segment))) {
    throw new PolicyError('Ambiguous encoded request path is not supported.');
  }
  const decodedPath = segments.join('/');
  if (rawPath === '/health') return 'health';
  if (/^\/api(?:\/|$)/i.test(decodedPath)) return 'management';
  if (/^\/(?:[^/]+\/)?(?:mcp(?:\/.*)?|sse(?:\/.*)?|messages)$/i.test(decodedPath)) return 'transport';
  return 'other';
}

export function credentialIdentity(settings: RecordValue, token: string, bootstrap: boolean): string {
  const tokenHash = hashToken(token);
  if (bootstrap) return `bootstrap:${tokenHash}`;
  const keys = Array.isArray(settings.bearerKeys) ? settings.bearerKeys : [];
  const key = keys.find((candidate) => isRecord(candidate) && tokenHashOf(candidate) === tokenHash);
  if (!isRecord(key)) throw new PolicyError('No native credential identity is available.');
  const users = Array.isArray(settings.users) ? settings.users : [];
  const owner = key.kind === 'user'
    ? users.find((user) => isRecord(user) && user.username === key.owner)
    : undefined;
  // Scope/role edits invalidate cached session capabilities, even if the token
  // remains valid. Actual permission decisions still belong to MCPHub's DAO.
  return hashToken(JSON.stringify([
    tokenHash, key.id, key.kind, key.owner, key.enabled, key.accessType,
    key.allowedGroups, key.allowedServers, key.excludedGroups, key.excludedServers,
    isRecord(owner) ? [owner.username, owner.isAdmin, owner.userGroups] : null,
  ]));
}
