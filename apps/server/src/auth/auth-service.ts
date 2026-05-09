import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  NodeOAuthClient,
  assertOAuthDiscoverableClientId,
  atprotoLoopbackClientMetadata,
  buildAtprotoLoopbackClientMetadata,
  requestLocalLock,
  type NodeSavedSession,
  type NodeSavedState,
  type OAuthClientMetadataInput,
} from '@atproto/oauth-client-node';
import type { CurrentUser } from '@current/types';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { ServerConfigService } from '../services/server-config-service.js';
import { addHours } from '../utils/time.js';
import { id } from '../utils/id.js';

interface OAuthProfileResponse {
  did?: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
}

const OAUTH_STATE_PREFIX = 'oauth:state:';
const OAUTH_SESSION_PREFIX = 'oauth:session:';
export const LOOPBACK_REMOTE_RETURN_TO_CODE = 'LOOPBACK_REMOTE_RETURN_TO';

export class AuthService {
  private oauthClient: NodeOAuthClient | null = null;
  private oauthClientConfigKey: string | null = null;

  constructor(
    private readonly repos: RepositoryBag,
    private readonly serverConfig: ServerConfigService,
  ) {}

  async startOAuth(input: {
    handle: string;
    returnTo?: string;
    skipLoopbackReturnToGuard?: boolean;
  }): Promise<{ authorizationUrl: string }> {
    const handle = this.normalizeAtprotoIdentity(input.handle);
    const returnTo = this.normalizeReturnTo(input.returnTo);
    if (!input.skipLoopbackReturnToGuard) {
      this.ensureLoopbackModeCanHandleReturnTo(returnTo);
    }
    const client = await this.getOAuthClient();
    const config = this.serverConfig.get();
    const authorizationUrl = await client.authorize(handle, {
      scope: config.auth.scope,
      state: returnTo,
    });
    return {
      authorizationUrl: authorizationUrl.toString(),
    };
  }

  async handleOAuthCallback(
    params: URLSearchParams,
  ): Promise<{ user: CurrentUser; sessionToken: string; returnTo?: string }> {
    const client = await this.getOAuthClient();
    const { session, state } = await client.callback(params);
    const existing = this.repos.users.findByDid(session.did);
    const profile = await this.fetchProfile(session.did);

    const did = profile.did ?? session.did;
    const handle = this.normalizeResolvedHandle(profile.handle) ?? existing?.handle ?? did;
    const displayName = profile.displayName ?? existing?.displayName ?? handle;
    const avatarUrl = profile.avatar ?? existing?.avatarUrl;

    const user = this.ensureDefaultMemberRole(this.repos.users.upsertByDid({
      did,
      handle,
      displayName,
      avatarUrl,
    }));

    const sessionToken = id('sess');
    this.repos.users.setSession(sessionToken, user.id, addHours(24));

    const returnTo = this.normalizeReturnTo(state);
    return {
      user,
      sessionToken,
      returnTo,
    };
  }

  async launcherLogin(input: {
    did: string;
    handle?: string;
    displayName?: string;
    avatar?: string;
  }): Promise<{ user: CurrentUser; sessionToken: string }> {
    const existing = this.repos.users.findByDid(input.did);
    const profile = await this.fetchProfile(input.did);

    const did = profile.did ?? input.did;
    const handle =
      this.normalizeResolvedHandle(profile.handle ?? input.handle) ?? existing?.handle ?? did;
    const displayName =
      profile.displayName ?? input.displayName?.trim() ?? existing?.displayName ?? handle;
    const avatarUrl = profile.avatar ?? input.avatar ?? existing?.avatarUrl;

    const user = this.ensureDefaultMemberRole(this.repos.users.upsertByDid({
      did,
      handle,
      displayName,
      avatarUrl,
    }));

    const sessionToken = id('sess');
    this.repos.users.setSession(sessionToken, user.id, addHours(24));

    return { user, sessionToken };
  }

  async hydrateProfile(user: CurrentUser): Promise<CurrentUser> {
    const profile = await this.fetchProfile(user.did);
    const did = profile.did ?? user.did;
    const handle = this.normalizeResolvedHandle(profile.handle) ?? user.handle;
    const displayName = profile.displayName ?? user.displayName ?? handle;
    const avatarUrl = profile.avatar ?? user.avatarUrl;

    return this.ensureDefaultMemberRole(this.repos.users.upsertByDid({
      did,
      handle,
      displayName,
      avatarUrl,
    }));
  }

  devLogin(input?: { handle?: string; displayName?: string }): { user: CurrentUser; sessionToken: string } {
    const rawHandle = input?.handle?.trim().toLowerCase();
    const handle = rawHandle && rawHandle.length > 0 ? rawHandle : 'local.dev@current';
    const displayName = input?.displayName?.trim() || 'Local Developer';
    const didSuffix = createHash('sha256').update(handle).digest('hex').slice(0, 24);
    const did = `did:current:dev:${didSuffix}`;

    const user = this.ensureDefaultMemberRole(this.repos.users.upsertByDid({
      did,
      handle,
      displayName,
    }));

    const sessionToken = id('sess');
    this.repos.users.setSession(sessionToken, user.id, addHours(24));

    return { user, sessionToken };
  }

  lanLogin(input: { screenName: string }): { user: CurrentUser; sessionToken: string } {
    const screenName = input.screenName.trim().replace(/\s+/g, ' ');
    if (screenName.length < 2) {
      throw new Error('Screen name must be at least 2 characters.');
    }
    if (screenName.length > 80) {
      throw new Error('Screen name must be 80 characters or fewer.');
    }

    const slug = screenName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    if (!slug) {
      throw new Error('Screen name must contain letters or numbers.');
    }

    const handle = `${slug}.lan`;
    const didSuffix = createHash('sha256').update(handle).digest('hex').slice(0, 24);
    const did = `did:current:lan:${didSuffix}`;

    const user = this.ensureDefaultMemberRole(this.repos.users.upsertByDid({
      did,
      handle,
      displayName: screenName,
    }));

    const sessionToken = id('sess');
    this.repos.users.setSession(sessionToken, user.id, addHours(24));

    return { user, sessionToken };
  }

  getUserBySession(sessionToken?: string): CurrentUser | null {
    if (!sessionToken) {
      return null;
    }
    return this.repos.users.findUserBySession(sessionToken);
  }

  private ensureDefaultMemberRole(user: CurrentUser): CurrentUser {
    const server = this.repos.servers.getPrimaryServer();
    if (!server) {
      return user;
    }

    const memberRole = this.repos.roles
      .list(server.id)
      .find((role) => role.name.toLowerCase() === 'member');
    if (!memberRole || user.roleIds.includes(memberRole.id)) {
      return user;
    }

    this.repos.users.addRole(user.id, memberRole.id);
    return this.repos.users.findById(user.id) ?? user;
  }

  logout(sessionToken?: string): void {
    if (!sessionToken) {
      return;
    }
    this.repos.users.clearSession(sessionToken);
  }

  private async getOAuthClient(): Promise<NodeOAuthClient> {
    const config = this.serverConfig.get();
    const oauthConfigKey = [
      config.auth.atprotoClientId.trim(),
      config.auth.redirectUri.trim(),
      config.auth.scope.trim(),
    ].join('|');

    if (this.oauthClient && this.oauthClientConfigKey === oauthConfigKey) {
      return this.oauthClient;
    }

    const metadata = await this.resolveClientMetadata();
    this.oauthClient = new NodeOAuthClient({
      responseMode: 'query',
      requestLock: requestLocalLock,
      clientMetadata: metadata,
      stateStore: {
        get: async (key: string) =>
          this.repos.settings.get<NodeSavedState>(`${OAUTH_STATE_PREFIX}${key}`) ?? undefined,
        set: async (key: string, value: NodeSavedState) => {
          this.repos.settings.set(`${OAUTH_STATE_PREFIX}${key}`, value);
        },
        del: async (key: string) => {
          this.repos.settings.delete(`${OAUTH_STATE_PREFIX}${key}`);
        },
      },
      sessionStore: {
        get: async (key: string) =>
          this.repos.settings.get<NodeSavedSession>(`${OAUTH_SESSION_PREFIX}${key}`) ?? undefined,
        set: async (key: string, value: NodeSavedSession) => {
          this.repos.settings.set(`${OAUTH_SESSION_PREFIX}${key}`, value);
        },
        del: async (key: string) => {
          this.repos.settings.delete(`${OAUTH_SESSION_PREFIX}${key}`);
        },
      },
    });
    this.oauthClientConfigKey = oauthConfigKey;

    return this.oauthClient;
  }

  private async resolveClientMetadata(): Promise<OAuthClientMetadataInput> {
    const config = this.serverConfig.get();
    const explicitClientId = config.auth.atprotoClientId.trim();
    if (explicitClientId) {
      if (explicitClientId.startsWith('http://localhost')) {
        return atprotoLoopbackClientMetadata(explicitClientId);
      }
      assertOAuthDiscoverableClientId(explicitClientId);
      return NodeOAuthClient.fetchMetadata({
        clientId: explicitClientId,
      });
    }

    const derivedDiscoverableClientId = this.deriveDiscoverableClientIdFromPublicUrl(config.server.publicUrl);
    if (derivedDiscoverableClientId) {
      return this.buildDiscoverableClientMetadata({
        clientId: derivedDiscoverableClientId,
        scope: config.auth.scope,
        redirectUri: config.auth.redirectUri,
      });
    }

    return buildAtprotoLoopbackClientMetadata({
      scope: config.auth.scope,
      redirect_uris: [this.normalizeLoopbackRedirectUri(config.auth.redirectUri)],
    });
  }

  private normalizeLoopbackRedirectUri(uri: string): string {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'http:') {
      throw new Error('Loopback OAuth redirect URI must use http://');
    }
    if (!this.isLoopbackHost(parsed.hostname)) {
      throw new Error(
        'Loopback OAuth redirect URI must use localhost, 127.0.0.1, or [::1]. ' +
          'To support remote browser sign-in, configure auth.atprotoClientId with an HTTPS discoverable client ID.',
      );
    }
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1';
    }
    return parsed.toString();
  }

  private ensureLoopbackModeCanHandleReturnTo(returnTo?: string): void {
    const config = this.serverConfig.get();
    const explicitClientId = config.auth.atprotoClientId.trim();
    const isLoopbackClientId = explicitClientId.startsWith('http://localhost');
    const derivedDiscoverableClientId = explicitClientId
      ? null
      : this.deriveDiscoverableClientIdFromPublicUrl(config.server.publicUrl);

    if ((!isLoopbackClientId && (explicitClientId || derivedDiscoverableClientId)) || !returnTo) {
      return;
    }

    try {
      const parsed = new URL(returnTo);
      if (this.isLoopbackHost(parsed.hostname)) {
        return;
      }
    } catch {
      return;
    }

    const error = new Error(
      'This server is using loopback Bluesky OAuth and can only complete sign-in on the host machine. ' +
        'For remote clients, configure auth.atprotoClientId and auth.redirectUri for your public HTTPS domain.',
    ) as Error & { code?: string };
    error.code = LOOPBACK_REMOTE_RETURN_TO_CODE;
    throw error;
  }

  private buildDiscoverableClientMetadata(input: {
    clientId: string;
    scope: string;
    redirectUri: string;
  }): OAuthClientMetadataInput {
    const parsedRedirectUri = new URL(input.redirectUri);
    if (parsedRedirectUri.protocol !== 'https:') {
      throw new Error(
        'Discoverable OAuth redirect URI must use https://. ' +
          'Set auth.redirectUri to your HTTPS callback URL, or use loopback OAuth on the host machine.',
      );
    }

    return {
      client_id: input.clientId,
      scope: input.scope,
      redirect_uris: [parsedRedirectUri.toString()],
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      dpop_bound_access_tokens: true,
    };
  }

  private deriveDiscoverableClientIdFromPublicUrl(publicUrl: string): string | null {
    try {
      const parsed = new URL(publicUrl);
      if (parsed.protocol !== 'https:') {
        return null;
      }
      if (this.isLoopbackHost(parsed.hostname) || isIP(parsed.hostname)) {
        return null;
      }
      if (!parsed.hostname.includes('.') || parsed.hostname.endsWith('.local')) {
        return null;
      }

      const clientId = new URL('/api/v1/auth/client-metadata.json', parsed).toString();
      assertOAuthDiscoverableClientId(clientId);
      return clientId;
    } catch {
      return null;
    }
  }

  private normalizeReturnTo(returnTo?: string | null): string | undefined {
    if (!returnTo) {
      return undefined;
    }
    const trimmed = returnTo.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.startsWith('/')) {
      return trimmed;
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return undefined;
      }

      const allowedHosts = new Set<string>(['127.0.0.1', 'localhost']);
      try {
        allowedHosts.add(new URL(this.serverConfig.get().server.publicUrl).hostname);
      } catch {
        // ignore malformed server.publicUrl in this non-critical path
      }

      if (!allowedHosts.has(parsed.hostname) && !this.isPrivateOrLoopbackHost(parsed.hostname)) {
        return undefined;
      }
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  private normalizeAtprotoIdentity(rawInput: string): string {
    const input = rawInput.trim();
    if (!input) {
      throw new Error('Enter a Bluesky handle/domain, DID, or server host.');
    }

    if (input.startsWith('did:')) {
      return input;
    }

    if (input.startsWith('http://') || input.startsWith('https://')) {
      const parsed = new URL(input);
      if (!parsed.hostname) {
        throw new Error('Invalid server URL.');
      }
      parsed.pathname = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '');
    }

    const handle = input.startsWith('@') ? input.slice(1) : input;
    if (!handle) {
      throw new Error('Enter your Bluesky handle (for example: alice.bsky.social).');
    }

    const normalizedHandle = handle.toLowerCase();
    if (normalizedHandle === 'bsky.social' || normalizedHandle === 'bsky.app') {
      return 'https://bsky.social';
    }

    if (handle.includes('@')) {
      throw new Error('Use your Bluesky handle (alice.bsky.social), not your email address.');
    }

    if (!handle.includes('.')) {
      throw new Error('Handle/domain must look like a domain (for example: alice.bsky.social).');
    }

    const validHandle = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(handle);
    if (!validHandle) {
      throw new Error('Handle contains invalid characters. Use letters, numbers, dots, and hyphens.');
    }

    return normalizedHandle;
  }

  private isPrivateOrLoopbackHost(hostname: string): boolean {
    if (hostname === 'localhost' || hostname === '::1') {
      return true;
    }

    const ipVersion = isIP(hostname);
    if (ipVersion === 4) {
      const parts = hostname.split('.').map((part) => Number(part));
      if (parts.length !== 4 || parts.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
        return false;
      }

      const [a, b] = parts;
      if (a === 127) return true;
      if (a === 10) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      return false;
    }

    if (ipVersion === 6) {
      const lower = hostname.toLowerCase();
      if (lower === '::1') return true;
      if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
      return false;
    }

    return hostname.endsWith('.local');
  }

  private isLoopbackHost(hostname: string): boolean {
    if (hostname === 'localhost' || hostname === '::1') {
      return true;
    }

    if (isIP(hostname) !== 4) {
      return false;
    }

    const [first] = hostname.split('.').map((part) => Number(part));
    return first === 127;
  }

  private normalizeResolvedHandle(handle?: string): string | undefined {
    if (!handle) {
      return undefined;
    }
    const normalized = handle.trim().toLowerCase();
    return normalized.length > 0 ? normalized : undefined;
  }

  private async fetchProfile(actor: string): Promise<OAuthProfileResponse> {
    const fallback: OAuthProfileResponse = {
      did: actor,
    };

    const configuredEndpoint = this.serverConfig.get().auth.profileEndpoint;
    const endpoints = Array.from(
      new Set([
        configuredEndpoint,
        'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile',
        'https://api.bsky.app/xrpc/app.bsky.actor.getProfile',
      ]),
    );

    for (const endpoint of endpoints) {
      try {
        const profileUrl = new URL(endpoint);
        profileUrl.searchParams.set('actor', actor);
        const profileResponse = await fetch(profileUrl);
        if (!profileResponse.ok) {
          continue;
        }

        const payload = (await profileResponse.json()) as OAuthProfileResponse;
        const handle = this.normalizeResolvedHandle(payload.handle);
        const displayName =
          typeof payload.displayName === 'string' && payload.displayName.trim().length > 0
            ? payload.displayName.trim()
            : undefined;
        const avatar =
          typeof payload.avatar === 'string' && payload.avatar.trim().length > 0 ? payload.avatar : undefined;

        return {
          did: payload.did ?? actor,
          handle,
          displayName,
          avatar,
        };
      } catch {
        continue;
      }
    }

    return fallback;
  }
}
