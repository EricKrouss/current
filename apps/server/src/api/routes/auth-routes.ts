import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  calculateJwkThumbprint,
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from 'jose';
import { z } from 'zod';
import { GatewayEvents } from '@current/protocol';
import type { CurrentUser, ServerAccessRequestSource } from '@current/types';
import { buildRemovalError, requireAuth } from '../auth-guard.js';
import {
  grantDefaultMemberRole,
  resolveServerAccess,
  userHasServerRole,
} from '../../services/access-control.js';
import { LOOPBACK_REMOTE_RETURN_TO_CODE } from '../../auth/auth-service.js';
import { id } from '../../utils/id.js';
import { buildPublicServerPayload } from './server-payload.js';
import { isSafeAuthRedirectTarget } from '../origin-guard.js';

const OAuthStartSchema = z.object({
  handle: z.string().trim().min(3).max(256),
  returnTo: z.string().trim().min(1).max(1024).optional(),
});

const DevLoginSchema = z.object({
  handle: z.string().trim().min(1).max(64).optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
});

const LanLoginSchema = z.object({
  screenName: z.string().trim().min(2).max(80),
});

const AuthExchangeSchema = z.object({
  ticket: z.string().trim().min(1).max(128),
});

const WaitlistSchema = z.object({
  notificationsEnabled: z.boolean().optional(),
  source: z.enum(['browser', 'gaia_launcher', 'unknown']).optional(),
});

const WaitlistNotificationsSchema = z.object({
  notificationsEnabled: z.boolean(),
});

const InviteClaimSchema = z.object({
  code: z.string().trim().min(1).max(128),
});

const LauncherAuthProfileSchema = z.object({
  did: z.string().trim().min(1).max(256),
  handle: z.string().trim().min(1).max(256).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  avatar: z.string().trim().url().max(2048).optional(),
  description: z.string().trim().max(512).optional(),
});

const LauncherAuthSchema = z.object({
  profile: LauncherAuthProfileSchema,
  token: z
    .object({
      issuer: z.string().trim().url().max(512).optional(),
      audience: z.string().trim().url().max(512).optional(),
      scope: z.string().trim().min(1).max(1024).optional(),
      expiresAt: z.string().trim().datetime().optional(),
    })
    .optional(),
  resourceProof: z
    .object({
      method: z.literal('GET'),
      url: z.string().trim().url().max(2048),
      dpopProof: z.string().trim().min(1).max(4096),
    })
    .optional(),
});

const LanHandoffParamsSchema = z.object({
  handoffId: z.string().trim().min(1).max(128),
});

const LanHandoffQuerySchema = z.object({
  claimToken: z.string().trim().min(1).max(128),
});

const LanHandoffClaimSchema = z.object({
  claimToken: z.string().trim().min(1).max(128),
});

const LAN_HANDOFF_PREFIX = 'auth:lan_handoff:';
const LAN_HANDOFF_TTL_MS = 10 * 60 * 1000;
const LAUNCHER_DPOP_MAX_AGE_MS = 2 * 60 * 1000;
const LAUNCHER_DPOP_FUTURE_SKEW_MS = 30 * 1000;
const LAUNCHER_DPOP_REPLAY_TTL_MS = 5 * 60 * 1000;
const OAUTH_METADATA_CACHE_TTL_MS = 10 * 60 * 1000;

const launcherDpopJtis = new Map<string, number>();
const oauthMetadataCache = new Map<string, { metadata: OAuthServerMetadata; expiresAt: number }>();
const remoteJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

type OAuthServerMetadata = {
  issuer: string;
  jwksUri: string;
};

type VerifiedLauncherToken = {
  did: string;
  issuer: string;
  audience?: string;
  scope?: string;
  expiresAt?: string;
};

type LanHandoffState = {
  id: string;
  handle: string;
  returnTo: string;
  claimToken: string;
  status: 'pending' | 'completed' | 'claimed';
  authTicket?: string;
  createdAt: number;
  expiresAt: number;
};

function broadcastMemberJoined(
  app: FastifyInstance,
  result: { user: CurrentUser; isNewUser?: boolean },
): void {
  if (!result.isNewUser) {
    return;
  }

  const serverId = app.appContext.setup.status().serverId;
  if (serverId && !userHasServerRole(app.appContext.repos, { serverId, user: result.user })) {
    return;
  }

  app.appContext.gateway.broadcast(GatewayEvents.MEMBER_UPDATE, {
    action: 'join',
    userId: result.user.id,
    member: result.user,
  });
}

function getSignedInAccessUser(
  request: FastifyRequest,
  reply: FastifyReply,
): CurrentUser | null {
  if (!request.currentUser) {
    reply.code(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
      },
    });
    return null;
  }

  if (request.serverRemoval) {
    reply.code(403).send({
      error: buildRemovalError(request.serverRemoval),
    });
    return null;
  }

  return request.currentUser;
}

function readLanHandoff(app: FastifyInstance, handoffId: string): LanHandoffState | null {
  const key = `${LAN_HANDOFF_PREFIX}${handoffId}`;
  const row = app.appContext.db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value?: string } | undefined;
  if (!row?.value) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.value) as Partial<LanHandoffState>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.handle !== 'string' ||
      typeof parsed.returnTo !== 'string' ||
      typeof parsed.claimToken !== 'string' ||
      typeof parsed.status !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    return {
      id: parsed.id,
      handle: parsed.handle,
      returnTo: parsed.returnTo,
      claimToken: parsed.claimToken,
      status:
        parsed.status === 'pending' || parsed.status === 'completed' || parsed.status === 'claimed'
          ? parsed.status
          : 'pending',
      authTicket: typeof parsed.authTicket === 'string' ? parsed.authTicket : undefined,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function writeLanHandoff(app: FastifyInstance, state: LanHandoffState): void {
  const key = `${LAN_HANDOFF_PREFIX}${state.id}`;
  app.appContext.db
    .prepare(
      `
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
    )
    .run(key, JSON.stringify(state));
}

function deleteLanHandoff(app: FastifyInstance, handoffId: string): void {
  const key = `${LAN_HANDOFF_PREFIX}${handoffId}`;
  app.appContext.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

function isLanHandoffExpired(state: LanHandoffState): boolean {
  return Date.now() > state.expiresAt;
}

function deriveDiscoverableClientIdFromPublicUrl(publicUrl: string): string | null {
  try {
    const parsed = new URL(publicUrl);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.hostname === 'localhost' || parsed.hostname === '::1') {
      return null;
    }
    if (isIP(parsed.hostname)) {
      return null;
    }
    if (!parsed.hostname.includes('.') || parsed.hostname.endsWith('.local')) {
      return null;
    }
    return new URL('/api/v1/auth/client-metadata.json', parsed).toString();
  } catch {
    return null;
  }
}

function toSearchParams(raw: unknown): URLSearchParams {
  const params = new URLSearchParams();
  if (!raw || typeof raw !== 'object') {
    return params;
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      params.append(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') {
          params.append(key, entry);
        }
      }
    }
  }

  return params;
}

function buildLanHandoffPage(input: { title: string; message: string }): string {
  const title = escapeHtml(input.title);
  const message = escapeHtml(input.message);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Current OAuth Handoff</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif;
        color: #e9f4ff;
        background:
          radial-gradient(circle at 15% 20%, rgba(48, 180, 255, 0.2), transparent 36%),
          radial-gradient(circle at 82% 16%, rgba(110, 255, 191, 0.17), transparent 30%),
          linear-gradient(160deg, #04070f 0%, #0a101a 48%, #0d1523 100%);
      }
      .card {
        width: min(580px, calc(100vw - 32px));
        border: 1px solid rgba(183, 215, 242, 0.2);
        border-radius: 16px;
        padding: 22px;
        background: linear-gradient(170deg, rgba(18, 29, 43, 0.92), rgba(9, 14, 22, 0.96));
      }
      h1 {
        margin: 0 0 10px;
        font-size: 1.24rem;
      }
      p {
        margin: 0;
        color: #b8d0e5;
        line-height: 1.45;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1') {
    return true;
  }
  const ipVersion = isIP(hostname);
  if (ipVersion !== 4) {
    return false;
  }
  const [firstOctet] = hostname.split('.').map((segment) => Number(segment));
  return firstOctet === 127;
}

function normalizeIpAddress(value: string): string {
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

function normalizeIpCandidate(value: string): string {
  let candidate = value.trim();
  if (!candidate) {
    return candidate;
  }

  if (candidate.startsWith('"') && candidate.endsWith('"') && candidate.length >= 2) {
    candidate = candidate.slice(1, -1);
  }

  if (candidate.startsWith('[')) {
    const endBracket = candidate.indexOf(']');
    if (endBracket > 1) {
      candidate = candidate.slice(1, endBracket);
      return normalizeIpAddress(candidate);
    }
  }

  if (candidate.includes(':') && isIP(candidate) !== 6) {
    const ipv4WithPortMatch = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
    if (ipv4WithPortMatch) {
      candidate = ipv4WithPortMatch[1];
    }
  }

  return normalizeIpAddress(candidate);
}

function isLoopbackIpAddress(value: string): boolean {
  const normalized = normalizeIpAddress(value);
  if (normalized === '::1' || normalized === '127.0.0.1') {
    return true;
  }
  if (isIP(normalized) !== 4) {
    return false;
  }
  const [firstOctet] = normalized.split('.').map((segment) => Number(segment));
  return firstOctet === 127;
}

function collectHostIps(): Set<string> {
  const ips = new Set<string>();
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      ips.add(normalizeIpAddress(entry.address));
    }
  }
  return ips;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry.trim().length > 0) {
        return entry;
      }
    }
  }
  return undefined;
}

function resolveOriginatingRequestIp(request: FastifyRequest): string {
  const normalizedRemote = normalizeIpAddress(request.ip);
  const trustProxySetting = (request.server as { initialConfig?: { trustProxy?: unknown } }).initialConfig?.trustProxy;
  const trustProxyEnabled = Boolean(trustProxySetting);
  const trustProxyViaLoopback = isLoopbackIpAddress(normalizedRemote);
  const shouldTrustForwardedHeaders = trustProxyEnabled || trustProxyViaLoopback;

  if (shouldTrustForwardedHeaders) {
    const forwardedFor = firstHeaderValue(request.headers['x-forwarded-for']);
    if (forwardedFor) {
      const [firstHop] = forwardedFor.split(',');
      const normalizedForwarded = normalizeIpCandidate(firstHop ?? '');
      if (normalizedForwarded && normalizedForwarded.toLowerCase() !== 'unknown') {
        return normalizedForwarded;
      }
    }

    const realIp = firstHeaderValue(request.headers['x-real-ip']);
    if (realIp) {
      const normalizedRealIp = normalizeIpCandidate(realIp);
      if (normalizedRealIp && normalizedRealIp.toLowerCase() !== 'unknown') {
        return normalizedRealIp;
      }
    }
  }

  return normalizedRemote;
}

function isRequestFromHostMachine(request: FastifyRequest): boolean {
  const normalizedRemote = resolveOriginatingRequestIp(request);
  if (isLoopbackIpAddress(normalizedRemote)) {
    return true;
  }

  const hostIps = collectHostIps();
  return hostIps.has(normalizedRemote);
}

function base64UrlSha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function isAtprotoDid(value: string): boolean {
  return value.startsWith('did:plc:') || value.startsWith('did:web:');
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.local')) {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const [a, b] = hostname.split('.').map((part) => Number(part));
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  if (ipVersion === 6) {
    const lower = hostname.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
  }

  return false;
}

function assertPublicHttpsUrl(url: URL, label: string): void {
  if (url.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS.`);
  }
  if (isPrivateOrLoopbackHost(url.hostname) || isIP(url.hostname)) {
    throw new Error(`${label} must use a public host.`);
  }
}

function sameIssuer(left: string, right: string): boolean {
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
}

function didWebDocumentUrl(did: string): URL {
  const raw = did.slice('did:web:'.length);
  const parts = raw.split(':').map((part) => decodeURIComponent(part));
  const hostname = parts.shift();
  if (!hostname) {
    throw new Error('Invalid did:web identifier.');
  }

  const url = new URL(`https://${hostname}`);
  assertPublicHttpsUrl(url, 'Launcher DID document URL');
  if (parts.length === 0) {
    url.pathname = '/.well-known/did.json';
    return url;
  }

  url.pathname = `/${parts.map((part) => encodeURIComponent(part)).join('/')}/did.json`;
  return url;
}

function extractAtprotoPdsOrigin(didDocument: unknown): string {
  const services = (didDocument as { service?: unknown } | null)?.service;
  if (!Array.isArray(services)) {
    throw new Error('Launcher DID document does not advertise a PDS.');
  }

  for (const service of services) {
    if (!service || typeof service !== 'object') {
      continue;
    }
    const record = service as { id?: unknown; type?: unknown; serviceEndpoint?: unknown };
    const serviceType = typeof record.type === 'string' ? record.type : '';
    const serviceId = typeof record.id === 'string' ? record.id : '';
    if (serviceType !== 'AtprotoPersonalDataServer' && !serviceId.endsWith('#atproto_pds')) {
      continue;
    }
    if (typeof record.serviceEndpoint !== 'string') {
      continue;
    }

    const endpoint = new URL(record.serviceEndpoint);
    assertPublicHttpsUrl(endpoint, 'Launcher PDS endpoint');
    endpoint.pathname = '';
    endpoint.search = '';
    endpoint.hash = '';
    return endpoint.origin;
  }

  throw new Error('Launcher DID document does not advertise a usable PDS.');
}

async function resolveAtprotoPdsOrigin(did: string): Promise<string> {
  let didDocumentUrl: URL;
  if (did.startsWith('did:plc:')) {
    didDocumentUrl = new URL(`https://plc.directory/${did}`);
  } else if (did.startsWith('did:web:')) {
    didDocumentUrl = didWebDocumentUrl(did);
  } else {
    throw new Error('Launcher profile DID is not supported for resource proof fallback.');
  }

  const response = await fetch(didDocumentUrl, {
    headers: {
      accept: 'application/did+ld+json, application/json',
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error('Could not resolve the launcher profile DID document.');
  }

  return extractAtprotoPdsOrigin(await response.json());
}

function firstCsvHeaderValue(value: string | string[] | undefined): string | undefined {
  const first = firstHeaderValue(value);
  return first?.split(',')[0]?.trim() || undefined;
}

function resolveDpopHtu(request: FastifyRequest): string {
  const forwardedProto = firstCsvHeaderValue(request.headers['x-forwarded-proto'])?.toLowerCase();
  const protocol =
    forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : request.protocol;
  const host =
    firstCsvHeaderValue(request.headers['x-forwarded-host']) ?? request.headers.host ?? '127.0.0.1';
  const url = new URL(request.raw.url ?? request.url, `${protocol}://${host}`);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function readDpopAuthorization(request: FastifyRequest): string | null {
  const authorization = firstHeaderValue(request.headers.authorization);
  const match = authorization?.match(/^DPoP\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function readDpopProof(request: FastifyRequest): string | null {
  return firstHeaderValue(request.headers.dpop)?.trim() || null;
}

function oauthMetadataUrls(issuer: string): string[] {
  const parsed = new URL(issuer);
  const issuerPath = parsed.pathname.replace(/\/+$/, '');
  const candidates = [`${parsed.origin}/.well-known/oauth-authorization-server${issuerPath}`];
  if (issuerPath) {
    candidates.push(`${parsed.origin}${issuerPath}/.well-known/oauth-authorization-server`);
  }
  return Array.from(new Set(candidates));
}

async function resolveOAuthServerMetadata(issuer: string): Promise<OAuthServerMetadata> {
  const cached = oauthMetadataCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.metadata;
  }

  for (const metadataUrl of oauthMetadataUrls(issuer)) {
    try {
      const response = await fetch(metadataUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
      if (typeof payload.issuer !== 'string' || !sameIssuer(payload.issuer, issuer)) {
        continue;
      }
      if (typeof payload.jwks_uri !== 'string') {
        continue;
      }

      const metadata = {
        issuer: payload.issuer,
        jwksUri: payload.jwks_uri,
      };
      oauthMetadataCache.set(issuer, {
        metadata,
        expiresAt: Date.now() + OAUTH_METADATA_CACHE_TTL_MS,
      });
      return metadata;
    } catch {
      continue;
    }
  }

  throw new Error('Could not verify the launcher token issuer.');
}

function remoteJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = remoteJwksCache.get(jwksUri);
  if (cached) {
    return cached;
  }
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  remoteJwksCache.set(jwksUri, jwks);
  return jwks;
}

function payloadAudience(payload: JWTPayload): string[] {
  if (typeof payload.aud === 'string') {
    return [payload.aud];
  }
  return Array.isArray(payload.aud)
    ? payload.aud.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function pruneLauncherDpopReplayCache(now = Date.now()): void {
  for (const [key, expiresAt] of launcherDpopJtis) {
    if (expiresAt <= now) {
      launcherDpopJtis.delete(key);
    }
  }
}

function rememberLauncherDpopJti(did: string, jti: string): void {
  const now = Date.now();
  pruneLauncherDpopReplayCache(now);
  const key = `${did}:${jti}`;
  if (launcherDpopJtis.has(key)) {
    throw new Error('Launcher auth proof was already used.');
  }
  launcherDpopJtis.set(key, now + LAUNCHER_DPOP_REPLAY_TTL_MS);
}

async function verifyLauncherDpopProof(input: {
  accessToken: string;
  dpopProof: string;
  htu: string;
}): Promise<{ jwk: JWK; jti: string }> {
  const header = decodeProtectedHeader(input.dpopProof);
  if (header.typ?.toLowerCase() !== 'dpop+jwt') {
    throw new Error('Launcher DPoP proof has the wrong type.');
  }
  if (!header.alg || header.alg === 'none') {
    throw new Error('Launcher DPoP proof is missing a signing algorithm.');
  }
  if (!header.jwk || typeof header.jwk !== 'object') {
    throw new Error('Launcher DPoP proof is missing its public key.');
  }

  const jwk = header.jwk as JWK;
  if ('d' in jwk || 'k' in jwk) {
    throw new Error('Launcher DPoP proof included a private key.');
  }

  const key = await importJWK(jwk, header.alg);
  const { payload } = await jwtVerify(input.dpopProof, key, {
    clockTolerance: '10s',
  });

  if (payload.htm !== 'POST') {
    throw new Error('Launcher DPoP proof was not created for this request method.');
  }
  if (payload.htu !== input.htu) {
    throw new Error('Launcher DPoP proof was not created for this server endpoint.');
  }
  if (payload.ath !== base64UrlSha256(input.accessToken)) {
    throw new Error('Launcher DPoP proof does not match the access token.');
  }
  if (
    typeof payload.jti !== 'string' ||
    payload.jti.trim().length === 0 ||
    payload.jti.length > 256
  ) {
    throw new Error('Launcher DPoP proof is missing its replay id.');
  }
  if (typeof payload.iat !== 'number') {
    throw new Error('Launcher DPoP proof is missing its issue time.');
  }

  const ageMs = Date.now() - payload.iat * 1000;
  if (ageMs > LAUNCHER_DPOP_MAX_AGE_MS || ageMs < -LAUNCHER_DPOP_FUTURE_SKEW_MS) {
    throw new Error('Launcher DPoP proof expired.');
  }

  return {
    jwk,
    jti: payload.jti,
  };
}

async function verifyLauncherAccessToken(input: {
  accessToken: string;
  dpopJwk: JWK;
  expectedIssuer?: string;
  expectedAudience?: string;
}): Promise<VerifiedLauncherToken> {
  let unverified: JWTPayload;
  try {
    unverified = decodeJwt(input.accessToken);
  } catch {
    throw new Error('Launcher access token is not a signed JWT.');
  }

  const issuer = typeof unverified.iss === 'string' ? unverified.iss : input.expectedIssuer;
  if (!issuer) {
    throw new Error('Launcher access token is missing its issuer.');
  }
  if (input.expectedIssuer && !sameIssuer(input.expectedIssuer, issuer)) {
    throw new Error('Launcher access token issuer mismatch.');
  }

  const metadata = await resolveOAuthServerMetadata(issuer);
  const { payload } = await jwtVerify(input.accessToken, remoteJwks(metadata.jwksUri), {
    clockTolerance: '30s',
  });

  if (typeof payload.iss !== 'string' || !sameIssuer(payload.iss, metadata.issuer)) {
    throw new Error('Launcher access token issuer could not be verified.');
  }

  const did = typeof payload.sub === 'string' ? payload.sub : '';
  if (!isAtprotoDid(did)) {
    throw new Error('Launcher access token is not for an atproto account.');
  }

  const audiences = payloadAudience(payload);
  if (audiences.length === 0) {
    throw new Error('Launcher access token is missing its audience.');
  }
  if (
    input.expectedAudience &&
    !audiences.some((audience) => sameIssuer(audience, input.expectedAudience!))
  ) {
    throw new Error('Launcher access token audience mismatch.');
  }

  const scope = typeof payload.scope === 'string' ? payload.scope : undefined;
  if (!scope?.split(/\s+/).includes('atproto')) {
    throw new Error('Launcher access token does not include atproto scope.');
  }

  const cnf = payload.cnf;
  const tokenJkt =
    cnf && typeof cnf === 'object' && typeof (cnf as { jkt?: unknown }).jkt === 'string'
      ? (cnf as { jkt: string }).jkt
      : undefined;
  if (!tokenJkt) {
    throw new Error('Launcher access token is not DPoP-bound.');
  }

  const proofJkt = await calculateJwkThumbprint(input.dpopJwk);
  if (tokenJkt !== proofJkt) {
    throw new Error('Launcher DPoP key does not match the access token.');
  }

  if (typeof payload.exp !== 'number') {
    throw new Error('Launcher access token is missing its expiration.');
  }

  return {
    did,
    issuer: metadata.issuer,
    audience: audiences[0],
    scope,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

async function verifyLauncherAccessTokenWithResource(input: {
  accessToken: string;
  resourceProof: {
    method: 'GET';
    url: string;
    dpopProof: string;
  };
  expectedDid: string;
  expectedIssuer?: string;
  expectedAudience?: string;
  expectedScope?: string;
  expectedExpiresAt?: string;
}): Promise<VerifiedLauncherToken> {
  const resourceUrl = new URL(input.resourceProof.url);
  assertPublicHttpsUrl(resourceUrl, 'Launcher token resource proof URL');
  if (resourceUrl.pathname !== '/xrpc/com.atproto.server.getSession') {
    throw new Error('Launcher token resource proof used an unexpected endpoint.');
  }
  if (resourceUrl.search || resourceUrl.hash) {
    throw new Error('Launcher token resource proof URL must not include query data.');
  }
  if (
    input.expectedAudience &&
    !sameIssuer(resourceUrl.origin, input.expectedAudience)
  ) {
    throw new Error('Launcher token resource proof audience mismatch.');
  }
  const expectedPdsOrigin = await resolveAtprotoPdsOrigin(input.expectedDid);
  if (!sameIssuer(resourceUrl.origin, expectedPdsOrigin)) {
    throw new Error('Launcher token resource proof was not created for the profile PDS.');
  }

  const response = await fetch(resourceUrl, {
    headers: {
      accept: 'application/json',
      authorization: `DPoP ${input.accessToken}`,
      dpop: input.resourceProof.dpopProof,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error('The Bluesky server rejected the launcher token proof.');
  }

  const payload = (await response.json()) as { did?: unknown };
  const did = typeof payload.did === 'string' ? payload.did : '';
  if (!isAtprotoDid(did) || did !== input.expectedDid) {
    throw new Error('Launcher resource proof did not match the Gaia profile.');
  }

  return {
    did,
    issuer: input.expectedIssuer ?? resourceUrl.origin,
    audience: input.expectedAudience ?? resourceUrl.origin,
    scope: input.expectedScope,
    expiresAt: input.expectedExpiresAt,
  };
}

function resolveServerOrigin(app: FastifyInstance, returnTo?: string): URL {
  const lanRedirectBaseUrl = app.appContext.serverConfig.get().auth.lanRedirectBaseUrl.trim();
  if (lanRedirectBaseUrl) {
    try {
      const configuredLanOrigin = new URL(lanRedirectBaseUrl);
      if (configuredLanOrigin.protocol === 'http:' || configuredLanOrigin.protocol === 'https:') {
        configuredLanOrigin.pathname = '';
        configuredLanOrigin.search = '';
        configuredLanOrigin.hash = '';
        return configuredLanOrigin;
      }
    } catch {
      // ignore invalid configured value and continue with dynamic detection
    }
  }

  try {
    const configured = new URL(app.appContext.serverConfig.get().server.publicUrl);
    if (!isLoopbackHost(configured.hostname)) {
      return configured;
    }
  } catch {
    // fallback below
  }

  if (returnTo) {
    try {
      const parsedReturnTo = new URL(returnTo);
      if (parsedReturnTo.protocol === 'http:' || parsedReturnTo.protocol === 'https:') {
        const port = app.appContext.serverConfig.get().server.port;
        parsedReturnTo.port = String(port);
        parsedReturnTo.pathname = '';
        parsedReturnTo.search = '';
        parsedReturnTo.hash = '';
        return parsedReturnTo;
      }
    } catch {
      // continue to hard fallback
    }
  }

  return new URL(`http://127.0.0.1:${app.appContext.serverConfig.get().server.port}`);
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const ensureAtprotoMode = (reply: FastifyReply): boolean => {
    if (app.appContext.serverConfig.get().auth.mode === 'atproto') {
      return true;
    }

    reply.code(409).send({
      error: {
        code: 'ATPROTO_AUTH_DISABLED',
        message: 'Bluesky OAuth is disabled for this instance. Use LAN screen-name sign-in.',
      },
    });
    return false;
  };

  app.get('/auth/client-metadata.json', async (_request, reply) => {
    if (!ensureAtprotoMode(reply)) {
      return;
    }

    const config = app.appContext.serverConfig.get();
    const explicitClientId = config.auth.atprotoClientId.trim();
    const discoveredClientId = deriveDiscoverableClientIdFromPublicUrl(config.server.publicUrl);
    const clientId =
      explicitClientId && !explicitClientId.startsWith('http://localhost')
        ? explicitClientId
        : discoveredClientId;

    if (!clientId) {
      reply.code(404).send({
        error: {
          code: 'CLIENT_METADATA_UNAVAILABLE',
          message:
            'Discoverable OAuth metadata is only available when server.publicUrl is an HTTPS domain.',
        },
      });
      return;
    }

    const redirectUri = config.auth.redirectUri.trim();
    if (!redirectUri.startsWith('https://')) {
      reply.code(409).send({
        error: {
          code: 'CLIENT_METADATA_INVALID',
          message: 'auth.redirectUri must be an HTTPS URL for discoverable OAuth metadata.',
        },
      });
      return;
    }

    reply.send({
      client_id: clientId,
      scope: config.auth.scope,
      redirect_uris: [redirectUri],
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      dpop_bound_access_tokens: true,
    });
  });

  app.get('/auth/oauth/start', async (request, reply) => {
    if (!ensureAtprotoMode(reply)) {
      return;
    }

    const parsed = OAuthStartSchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    try {
      const start = await app.appContext.auth.startOAuth(parsed.data);
      reply.send(start);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === LOOPBACK_REMOTE_RETURN_TO_CODE && parsed.data.returnTo) {
        if (isRequestFromHostMachine(request)) {
          try {
            const start = await app.appContext.auth.startOAuth({
              ...parsed.data,
              skipLoopbackReturnToGuard: true,
            });
            reply.send(start);
            return;
          } catch {
            // fall through to LAN handoff flow
          }
        }

        const now = Date.now();
        const state: LanHandoffState = {
          id: id('oauth_handoff'),
          handle: parsed.data.handle,
          returnTo: parsed.data.returnTo,
          claimToken: id('handoff_claim'),
          status: 'pending',
          createdAt: now,
          expiresAt: now + LAN_HANDOFF_TTL_MS,
        };
        writeLanHandoff(app, state);

        const hostAuthUrl = new URL(
          `/api/v1/auth/lan/handoffs/${state.id}/start`,
          resolveServerOrigin(app, parsed.data.returnTo),
        ).toString();
        reply.send({
          lanHandoff: {
            handoffId: state.id,
            claimToken: state.claimToken,
            hostAuthUrl,
            expiresAt: new Date(state.expiresAt).toISOString(),
            message:
              'Complete Bluesky sign-in on the host machine to finish login on this LAN client.',
          },
        });
        return;
      }

      reply.code(400).send({
        error: {
          code: 'OAUTH_START_FAILED',
          message: error instanceof Error ? error.message : 'Failed to start OAuth login.',
        },
      });
    }
  });

  app.get('/auth/lan/handoffs/:handoffId/start', async (request, reply) => {
    if (!ensureAtprotoMode(reply)) {
      return;
    }

    const parsed = LanHandoffParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply
        .code(400)
        .type('text/html')
        .send(
          buildLanHandoffPage({
            title: 'Invalid Handoff Link',
            message: 'This login handoff link is malformed.',
          }),
        );
      return;
    }

    const state = readLanHandoff(app, parsed.data.handoffId);
    if (!state) {
      reply
        .code(404)
        .type('text/html')
        .send(
          buildLanHandoffPage({
            title: 'Handoff Not Found',
            message: 'This LAN login handoff has expired or has already been removed.',
          }),
        );
      return;
    }

    if (isLanHandoffExpired(state)) {
      deleteLanHandoff(app, state.id);
      reply
        .code(410)
        .type('text/html')
        .send(
          buildLanHandoffPage({
            title: 'Handoff Expired',
            message: 'Start a new sign-in from your LAN device.',
          }),
        );
      return;
    }

    if (state.status === 'completed' || state.status === 'claimed') {
      reply.type('text/html').send(
        buildLanHandoffPage({
          title: 'Handoff Already Completed',
          message: 'Return to your LAN device. The login is ready to finish there.',
        }),
      );
      return;
    }

    try {
      const start = await app.appContext.auth.startOAuth({
        handle: state.handle,
        returnTo: `/api/v1/auth/lan/handoffs/${state.id}/complete`,
      });
      reply.redirect(start.authorizationUrl);
    } catch (error) {
      reply
        .code(400)
        .type('text/html')
        .send(
          buildLanHandoffPage({
            title: 'Sign-In Could Not Start',
            message:
              error instanceof Error ? error.message : 'Unable to start Bluesky sign-in right now.',
          }),
        );
    }
  });

  app.get('/auth/lan/handoffs/:handoffId/complete', async (request, reply) => {
    if (!ensureAtprotoMode(reply)) {
      return;
    }

    const parsed = LanHandoffParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      reply
        .code(400)
        .type('text/html')
        .send(
          buildLanHandoffPage({
            title: 'Invalid Handoff',
            message: 'This callback link is malformed.',
          }),
        );
      return;
    }

    const state = readLanHandoff(app, parsed.data.handoffId);
    if (!state) {
      reply
        .code(404)
        .type('text/html')
        .send(
          buildLanHandoffPage({
            title: 'Handoff Not Found',
            message: 'This login handoff was not found. Start a new sign-in from your LAN client.',
          }),
        );
      return;
    }

    if (isLanHandoffExpired(state)) {
      deleteLanHandoff(app, state.id);
      reply
        .code(410)
        .type('text/html')
        .send(
          buildLanHandoffPage({
            title: 'Handoff Expired',
            message: 'Start a new sign-in from your LAN client.',
          }),
        );
      return;
    }

    const query = request.query as Record<string, string | string[] | undefined>;
    const rawTicket = Array.isArray(query.current_auth_ticket)
      ? query.current_auth_ticket[0]
      : query.current_auth_ticket;

    if (!rawTicket || rawTicket.trim().length === 0) {
      reply
        .code(400)
        .type('text/html')
        .send(
          buildLanHandoffPage({
            title: 'Missing Auth Ticket',
            message: 'OAuth callback did not include the required login ticket.',
          }),
        );
      return;
    }

    state.status = 'completed';
    state.authTicket = rawTicket.trim();
    writeLanHandoff(app, state);

    reply.type('text/html').send(
      buildLanHandoffPage({
        title: 'LAN Login Ready',
        message:
          'Sign-in completed on this host machine. Go back to your LAN device to finish login.',
      }),
    );
  });

  app.get('/auth/lan/handoffs/:handoffId', async (request, reply) => {
    if (!ensureAtprotoMode(reply)) {
      return;
    }

    const parsed = LanHandoffParamsSchema.safeParse(request.params);
    const query = LanHandoffQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }
    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    const state = readLanHandoff(app, parsed.data.handoffId);
    if (!state) {
      reply.code(404).send({
        error: {
          code: 'LAN_HANDOFF_NOT_FOUND',
          message: 'LAN login handoff not found.',
        },
      });
      return;
    }

    if (state.claimToken !== query.data.claimToken) {
      reply.code(403).send({
        error: {
          code: 'LAN_HANDOFF_TOKEN_MISMATCH',
          message: 'LAN login handoff token does not match this browser.',
        },
      });
      return;
    }

    if (isLanHandoffExpired(state)) {
      deleteLanHandoff(app, state.id);
      reply.send({
        status: 'expired',
      });
      return;
    }

    if (state.status === 'completed') {
      reply.send({
        status: 'ready',
        expiresAt: new Date(state.expiresAt).toISOString(),
      });
      return;
    }

    if (state.status === 'claimed') {
      reply.send({
        status: 'claimed',
      });
      return;
    }

    reply.send({
      status: 'pending',
      expiresAt: new Date(state.expiresAt).toISOString(),
    });
  });

  app.post('/auth/lan/handoffs/:handoffId/claim', async (request, reply) => {
    if (!ensureAtprotoMode(reply)) {
      return;
    }

    const parsed = LanHandoffParamsSchema.safeParse(request.params);
    const body = LanHandoffClaimSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }
    if (!body.success) {
      reply.code(400).send({ error: body.error.flatten() });
      return;
    }

    const state = readLanHandoff(app, parsed.data.handoffId);
    if (!state) {
      reply.code(404).send({
        error: {
          code: 'LAN_HANDOFF_NOT_FOUND',
          message: 'LAN login handoff not found.',
        },
      });
      return;
    }

    if (state.claimToken !== body.data.claimToken) {
      reply.code(403).send({
        error: {
          code: 'LAN_HANDOFF_TOKEN_MISMATCH',
          message: 'LAN login handoff token does not match this browser.',
        },
      });
      return;
    }

    if (isLanHandoffExpired(state)) {
      deleteLanHandoff(app, state.id);
      reply.code(410).send({
        error: {
          code: 'LAN_HANDOFF_EXPIRED',
          message: 'LAN login handoff expired. Start sign-in again.',
        },
      });
      return;
    }

    if (state.status !== 'completed' || !state.authTicket) {
      reply.code(409).send({
        error: {
          code: 'LAN_HANDOFF_NOT_READY',
          message: 'LAN login handoff is not ready yet.',
        },
      });
      return;
    }

    const ticket = state.authTicket;
    state.status = 'claimed';
    state.authTicket = undefined;
    writeLanHandoff(app, state);
    reply.send({
      ticket,
    });
  });

  app.get('/auth/oauth/callback', async (request, reply) => {
    if (!ensureAtprotoMode(reply)) {
      return;
    }

    try {
      const result = await app.appContext.auth.handleOAuthCallback(toSearchParams(request.query));
      broadcastMemberJoined(app, result);
      const response = reply.setCookie('current_session', result.sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
        maxAge: 60 * 60 * 24,
      });

      if (result.returnTo) {
        const ticket = id('auth_ticket');
        app.appContext.db
          .prepare(
            `
          INSERT INTO settings (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
          )
          .run(
            `auth:ticket:${ticket}`,
            JSON.stringify({
              sessionToken: result.sessionToken,
              createdAt: Date.now(),
            }),
          );

        const redirectTo = result.returnTo.startsWith('/')
          ? new URL(
              result.returnTo,
              `${request.protocol}://${
                request.headers.host ?? `127.0.0.1:${app.appContext.serverConfig.get().server.port}`
              }`,
            )
          : new URL(result.returnTo);
        if (!isSafeAuthRedirectTarget({
          target: redirectTo,
          requestHost: request.headers.host,
          config: app.appContext.serverConfig.get(),
        })) {
          response.redirect('/');
          return;
        }
        redirectTo.searchParams.set('current_auth_ticket', ticket);
        response.redirect(redirectTo.toString());
        return;
      }

      response.send({
        user: result.user,
        sessionToken: result.sessionToken,
      });
    } catch (error) {
      reply.code(401).send({
        error: {
          code: 'AUTH_FAILED',
          message: error instanceof Error ? error.message : 'OAuth callback failed.',
        },
      });
    }
  });

  app.get('/auth/session', async (request, reply) => {
    if (!request.currentUser) {
      reply.code(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required.',
        },
      });
      return;
    }

    if (request.serverRemoval) {
      reply.code(403).send({
        error: buildRemovalError(request.serverRemoval),
      });
      return;
    }

    const allowLanOwnershipRecovery =
      app.appContext.serverConfig.get().auth.mode === 'lan' && isRequestFromHostMachine(request);
    let user = app.appContext.setup.ensureOwnerForUser(request.currentUser, {
      allowLanOwnershipRecovery,
    });

    const status = app.appContext.setup.status();
    const registrationMode = app.appContext.serverConfig.get().server.registrationMode;
    let access = resolveServerAccess(app.appContext.repos, {
      serverId: status.serverId,
      user,
      registrationMode,
    });

    if (access.state === 'approved' && status.serverId && !userHasServerRole(app.appContext.repos, { serverId: status.serverId, user })) {
      user = grantDefaultMemberRole(app.appContext.repos, {
        serverId: status.serverId,
        userId: user.id,
      }).user ?? user;
      access = resolveServerAccess(app.appContext.repos, {
        serverId: status.serverId,
        user,
        registrationMode,
      });
    }

    if (access.state !== 'approved') {
      return {
        user,
        server: buildPublicServerPayload(app),
        authMode: app.appContext.serverConfig.get().auth.mode,
        access,
        ownership: {
          ownerUserId: app.appContext.setup.getOwnerUserId() ?? undefined,
        },
      };
    }

    const looksLikeAtprotoDid = user.did.startsWith('did:plc:') || user.did.startsWith('did:web:');
    const needsHydration =
      looksLikeAtprotoDid &&
      (!user.avatarUrl ||
        user.bio === undefined ||
        user.handle.startsWith('did:') ||
        user.displayName.trim().length === 0 ||
        user.displayName === user.handle);

    if (needsHydration) {
      try {
        user = await app.appContext.auth.hydrateProfile(user);
        access = resolveServerAccess(app.appContext.repos, {
          serverId: status.serverId,
          user,
          registrationMode,
        });
      } catch {
        user = app.appContext.repos.users.findById(user.id) ?? user;
      }
    }

    return {
      user,
      server: buildPublicServerPayload(app),
      authMode: app.appContext.serverConfig.get().auth.mode,
      access,
      ownership: {
        ownerUserId: app.appContext.setup.getOwnerUserId() ?? undefined,
      },
    };
  });

  app.post('/auth/waitlist', async (request, reply) => {
    const user = getSignedInAccessUser(request, reply);
    if (!user) {
      return;
    }

    const parsed = WaitlistSchema.safeParse(request.body ?? {});
    const status = app.appContext.setup.status();
    const registrationMode = app.appContext.serverConfig.get().server.registrationMode;
    if (!parsed.success || !status.serverId) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const existingAccess = resolveServerAccess(app.appContext.repos, {
      serverId: status.serverId,
      user,
      registrationMode,
    });
    if (existingAccess.state === 'approved' || existingAccess.state === 'denied') {
      reply.send({
        access: existingAccess,
      });
      return;
    }

    if (registrationMode !== 'manual_approval') {
      reply.code(409).send({
        error: {
          code: 'WAITLIST_DISABLED',
          message: 'Manual approval is not enabled for this server.',
        },
      });
      return;
    }

    const source: ServerAccessRequestSource = parsed.data.source ?? 'browser';
    const accessRequest = app.appContext.repos.accessRequests.upsertPending({
      serverId: status.serverId,
      userId: user.id,
      notificationsEnabled: parsed.data.notificationsEnabled ?? false,
      source,
    });

    reply.code(existingAccess.state === 'pending' ? 200 : 201).send({
      access: {
        state: accessRequest.status,
        registrationMode,
        request: accessRequest,
      },
    });
  });

  app.patch('/auth/waitlist/notifications', async (request, reply) => {
    const user = getSignedInAccessUser(request, reply);
    if (!user) {
      return;
    }

    const parsed = WaitlistNotificationsSchema.safeParse(request.body ?? {});
    const status = app.appContext.setup.status();
    const registrationMode = app.appContext.serverConfig.get().server.registrationMode;
    if (!parsed.success || !status.serverId) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const accessRequest = app.appContext.repos.accessRequests.setNotifications({
      serverId: status.serverId,
      userId: user.id,
      notificationsEnabled: parsed.data.notificationsEnabled,
    });
    if (!accessRequest) {
      reply.code(404).send({
        error: {
          code: 'WAITLIST_REQUEST_NOT_FOUND',
          message: 'Join request not found.',
        },
      });
      return;
    }

    reply.send({
      access: {
        state: accessRequest.status,
        registrationMode,
        request: accessRequest,
      },
    });
  });

  app.post('/auth/invite/claim', async (request, reply) => {
    const user = getSignedInAccessUser(request, reply);
    if (!user) {
      return;
    }

    const parsed = InviteClaimSchema.safeParse(request.body ?? {});
    const status = app.appContext.setup.status();
    const registrationMode = app.appContext.serverConfig.get().server.registrationMode;
    if (!parsed.success || !status.serverId) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (registrationMode !== 'invite_only') {
      reply.code(409).send({
        error: {
          code: 'INVITE_CLAIM_DISABLED',
          message: 'Invite codes are not required for this server.',
        },
      });
      return;
    }

    const validation = app.appContext.invites.validate(parsed.data.code);
    if (!validation.valid || !validation.invite || validation.invite.serverId !== status.serverId) {
      reply.code(400).send({
        error: {
          code: 'INVALID_INVITE',
          message: validation.reason ?? 'Invite code is invalid.',
        },
      });
      return;
    }

    app.appContext.repos.invites.consume(validation.invite.code);
    const accessRequest = app.appContext.repos.accessRequests.setStatus({
      serverId: status.serverId,
      userId: user.id,
      status: 'approved',
      reviewedBy: user.id,
      source: 'unknown',
      notificationsEnabled: false,
    });
    const granted = grantDefaultMemberRole(app.appContext.repos, {
      serverId: status.serverId,
      userId: user.id,
    });
    const member = granted.user ?? app.appContext.repos.users.findById(user.id) ?? user;

    if (granted.granted) {
      app.appContext.gateway.broadcast(GatewayEvents.MEMBER_UPDATE, {
        action: 'join',
        userId: member.id,
        member,
      });
    }

    reply.send({
      user: member,
      access: {
        state: 'approved',
        registrationMode,
        request: accessRequest,
      },
    });
  });

  app.post('/auth/launcher', async (request, reply) => {
    if (!ensureAtprotoMode(reply)) {
      return;
    }

    const parsed = LauncherAuthSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const accessToken = readDpopAuthorization(request);
    const dpopProof = readDpopProof(request);
    if (!accessToken || !dpopProof) {
      reply.code(401).send({
        error: {
          code: 'MISSING_LAUNCHER_TOKEN',
          message: 'Gaia Launcher did not provide its Bluesky auth token.',
        },
      });
      return;
    }

    try {
      const dpop = await verifyLauncherDpopProof({
        accessToken,
        dpopProof,
        htu: resolveDpopHtu(request),
      });
      let verified: VerifiedLauncherToken;
      try {
        verified = await verifyLauncherAccessToken({
          accessToken,
          dpopJwk: dpop.jwk,
          expectedIssuer: parsed.data.token?.issuer,
          expectedAudience: parsed.data.token?.audience,
        });
      } catch (error) {
        if (!parsed.data.resourceProof) {
          throw error;
        }
        verified = await verifyLauncherAccessTokenWithResource({
          accessToken,
          resourceProof: parsed.data.resourceProof,
          expectedDid: parsed.data.profile.did,
          expectedIssuer: parsed.data.token?.issuer,
          expectedAudience: parsed.data.token?.audience,
          expectedScope: parsed.data.token?.scope,
          expectedExpiresAt: parsed.data.token?.expiresAt,
        });
      }
      rememberLauncherDpopJti(verified.did, dpop.jti);

      if (parsed.data.profile.did !== verified.did) {
        reply.code(401).send({
          error: {
            code: 'LAUNCHER_PROFILE_MISMATCH',
            message: 'Gaia Launcher profile does not match its Bluesky token.',
          },
        });
        return;
      }

      const result = await app.appContext.auth.launcherLogin({
        did: verified.did,
        handle: parsed.data.profile.handle,
        displayName: parsed.data.profile.displayName,
        avatar: parsed.data.profile.avatar,
        bio: parsed.data.profile.description,
      });
      broadcastMemberJoined(app, result);

      reply
        .setCookie('current_session', result.sessionToken, {
          httpOnly: true,
          sameSite: 'lax',
          secure: false,
          path: '/',
          maxAge: 60 * 60 * 24,
        })
        .send({
          user: result.user,
          token: {
            issuer: verified.issuer,
            audience: verified.audience,
            scope: verified.scope,
            expiresAt: verified.expiresAt,
          },
        });
    } catch (error) {
      reply.code(401).send({
        error: {
          code: 'LAUNCHER_AUTH_FAILED',
          message:
            error instanceof Error ? error.message : 'Gaia Launcher token could not be verified.',
        },
      });
    }
  });

  app.post('/auth/lan-login', async (request, reply) => {
    const config = app.appContext.serverConfig.get();
    if (config.auth.mode !== 'lan') {
      reply.code(409).send({
        error: {
          code: 'LAN_LOGIN_DISABLED',
          message: 'LAN screen-name sign-in is disabled for this instance.',
        },
      });
      return;
    }

    const parsed = LanLoginSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    try {
      const result = app.appContext.auth.lanLogin(parsed.data);
      const user = app.appContext.setup.ensureOwnerForUser(result.user, {
        allowLanOwnershipRecovery: isRequestFromHostMachine(request),
      });
      broadcastMemberJoined(app, { ...result, user });
      reply
        .setCookie('current_session', result.sessionToken, {
          httpOnly: true,
          sameSite: 'lax',
          secure: false,
          path: '/',
          maxAge: 60 * 60 * 24,
        })
        .send({
          user,
        });
    } catch (error) {
      reply.code(400).send({
        error: {
          code: 'LAN_LOGIN_FAILED',
          message:
            error instanceof Error ? error.message : 'Unable to sign in with this screen name.',
        },
      });
    }
  });

  app.post('/auth/dev-login', async (request, reply) => {
    const config = app.appContext.serverConfig.get();
    if (!config.auth.allowDevLogin) {
      reply.code(403).send({
        error: {
          code: 'DEV_LOGIN_DISABLED',
          message: 'Local dev login is disabled by server config.',
        },
      });
      return;
    }
    if (!isRequestFromHostMachine(request)) {
      reply.code(403).send({
        error: {
          code: 'DEV_LOGIN_HOST_ONLY',
          message: 'Local dev login is only available from the host machine.',
        },
      });
      return;
    }

    const parsed = DevLoginSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const result = app.appContext.auth.devLogin(parsed.data);
    const user = app.appContext.setup.ensureOwnerForUser(result.user, {
      allowLanOwnershipRecovery: isRequestFromHostMachine(request),
    });
    broadcastMemberJoined(app, { ...result, user });
    reply
      .setCookie('current_session', result.sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
        maxAge: 60 * 60 * 24,
      })
      .send({
        user,
      });
  });

  app.post('/auth/exchange', async (request, reply) => {
    if (!ensureAtprotoMode(reply)) {
      return;
    }

    const parsed = AuthExchangeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const key = `auth:ticket:${parsed.data.ticket}`;
    const ticket = app.appContext.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;

    if (!ticket) {
      reply.code(400).send({
        error: {
          code: 'INVALID_AUTH_TICKET',
          message: 'Auth ticket is invalid or already used.',
        },
      });
      return;
    }

    app.appContext.db.prepare('DELETE FROM settings WHERE key = ?').run(key);

    let payload: { sessionToken?: string; createdAt?: number } = {};
    try {
      payload = JSON.parse(ticket.value) as { sessionToken?: string; createdAt?: number };
    } catch {
      payload = {};
    }

    const maxAgeMs = 5 * 60 * 1000;
    if (!payload.sessionToken || !payload.createdAt || Date.now() - payload.createdAt > maxAgeMs) {
      reply.code(400).send({
        error: {
          code: 'EXPIRED_AUTH_TICKET',
          message: 'Auth ticket expired. Please try signing in again.',
        },
      });
      return;
    }

    reply.setCookie('current_session', payload.sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
      maxAge: 60 * 60 * 24,
    });

    reply.code(204).send();
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies.current_session;
    app.appContext.auth.logout(token);
    if (token) {
      app.appContext.gateway.disconnectSession(token, 'Logged out');
    }

    reply.clearCookie('current_session', {
      path: '/',
    });

    reply.code(204).send();
  });
}
