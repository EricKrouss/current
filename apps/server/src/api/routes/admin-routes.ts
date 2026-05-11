import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CurrentConfig, DeepPartial } from '@current/config';
import { GatewayEvents } from '@current/protocol';
import type { Permission, RegistrationMode, Role } from '@current/types';
import { requireAuth } from '../auth-guard.js';
import { denyForbidden, hasServerPermission } from '../permission-guard.js';
import { hasPermission, resolvePermissions } from '../../moderation/permissions.js';
import { buildPublicAppearance, buildPublicServerPayload } from './server-payload.js';

const PermissionSchema = z.enum([
  'ADMINISTRATOR',
  'MANAGE_SERVER',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'MODERATE_MEMBERS',
  'MANAGE_MESSAGES',
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'CONNECT_VOICE',
  'SPEAK_VOICE',
  'ATTACH_FILES',
  'USE_GIFS',
]);

const PanelColorSchema = z.union([
  z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  z.literal(''),
]);

const RestartRequiredFieldPaths = [
  'server.host',
  'server.port',
  'server.tls',
  'storage.sqlitePath',
  'storage.uploadDir',
  'storage.mediaBackend',
  'storage.s3',
  'rtc.listenIp',
  'rtc.announcedIp',
  'rtc.udpMinPort',
  'rtc.udpMaxPort',
  'rtc.workerCount',
  'rtc.sessionTimeoutMs',
  'rtc.turnUrls',
  'rtc.turnUsername',
  'rtc.turnCredential',
  'observability.logLevel',
];

const AdminSettingsPatchSchema = z
  .object({
    registrationMode: z.enum(['invite_only', 'open_signup', 'manual_approval']).optional(),
    authMode: z.enum(['atproto', 'lan']).optional(),
    klipyApiKey: z.string().max(512).optional(),
    giphyApiKey: z.string().max(512).optional(),
    tenorApiKey: z.string().max(512).optional(),
    lanRedirectBaseUrl: z.string().trim().max(1024).optional(),
    server: z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        slug: z.string().trim().min(1).max(80).optional(),
        host: z.string().trim().min(1).max(255).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        publicUrl: z.string().url().optional(),
        registrationMode: z.enum(['invite_only', 'open_signup', 'manual_approval']).optional(),
        iconAttachmentId: z.string().trim().min(1).nullable().optional(),
        bannerAttachmentId: z.string().trim().min(1).nullable().optional(),
        tls: z
          .object({
            enabled: z.boolean().optional(),
            certPath: z.string().trim().max(2048).optional(),
            keyPath: z.string().trim().max(2048).optional(),
          })
          .optional(),
      })
      .optional(),
    auth: z
      .object({
        mode: z.enum(['atproto', 'lan']).optional(),
        atprotoClientId: z.string().max(2048).optional(),
        redirectUri: z.string().url().optional(),
        lanRedirectBaseUrl: z.string().trim().max(1024).optional(),
        authorizationEndpoint: z.string().url().optional(),
        tokenEndpoint: z.string().url().optional(),
        profileEndpoint: z.string().url().optional(),
        scope: z.string().trim().min(1).max(2048).optional(),
        cookieSecret: z.string().min(24).max(4096).optional(),
        allowDevLogin: z.boolean().optional(),
      })
      .optional(),
    storage: z
      .object({
        sqlitePath: z.string().trim().min(1).max(2048).optional(),
        uploadDir: z.string().trim().min(1).max(2048).optional(),
        mediaBackend: z.enum(['local', 's3']).optional(),
        s3: z
          .object({
            endpoint: z.string().url().optional(),
            bucket: z.string().trim().min(1).max(255).optional(),
            accessKeyId: z.string().max(4096).optional(),
            clearAccessKeyId: z.boolean().optional(),
            secretAccessKey: z.string().max(4096).optional(),
            clearSecretAccessKey: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    media: z
      .object({
        maxAttachmentBytes: z.number().int().positive().max(1024 * 1024 * 1024).optional(),
        allowedMimePrefixes: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
        gifProvider: z.enum(['klipy', 'giphy']).optional(),
        gifFallbackProvider: z.enum(['none', 'klipy', 'giphy']).optional(),
        klipyApiKey: z.string().max(512).optional(),
        clearKlipyApiKey: z.boolean().optional(),
        giphyApiKey: z.string().max(512).optional(),
        clearGiphyApiKey: z.boolean().optional(),
      })
      .optional(),
    appearance: z
      .object({
        backgroundAttachmentId: z.string().trim().min(1).nullable().optional(),
        panelColor: PanelColorSchema.nullable().optional(),
        ownMessageColor: PanelColorSchema.nullable().optional(),
        otherMessageColor: PanelColorSchema.nullable().optional(),
      })
      .optional(),
    moderation: z
      .object({
        defaultSlowmodeSeconds: z.number().int().min(0).max(86_400).optional(),
        maxMentionsPerMessage: z.number().int().min(1).max(500).optional(),
        linkPolicy: z.enum(['allow', 'members_only', 'deny']).optional(),
      })
      .optional(),
    rtc: z
      .object({
        listenIp: z.string().trim().min(1).max(255).optional(),
        announcedIp: z.string().trim().min(1).max(255).optional(),
        udpMinPort: z.number().int().min(1).max(65535).optional(),
        udpMaxPort: z.number().int().min(1).max(65535).optional(),
        workerCount: z.number().int().min(0).max(8).optional(),
        sessionTimeoutMs: z.number().int().min(5_000).max(600_000).optional(),
        turnUrls: z.array(z.string().trim().min(1).max(2048)).max(32).optional(),
        turnUsername: z.string().max(4096).optional(),
        clearTurnUsername: z.boolean().optional(),
        turnCredential: z.string().max(4096).optional(),
        clearTurnCredential: z.boolean().optional(),
      })
      .optional(),
    observability: z
      .object({
        metricsEnabled: z.boolean().optional(),
        logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.registrationMode !== undefined ||
      value.authMode !== undefined ||
      value.klipyApiKey !== undefined ||
      value.giphyApiKey !== undefined ||
      value.tenorApiKey !== undefined ||
      value.lanRedirectBaseUrl !== undefined ||
      value.server !== undefined ||
      value.auth !== undefined ||
      value.storage !== undefined ||
      value.media !== undefined ||
      value.appearance !== undefined ||
      value.moderation !== undefined ||
      value.rtc !== undefined ||
      value.observability !== undefined,
    {
      message: 'At least one setting must be provided.',
    },
  );

const OwnershipTransferSchema = z.object({
  targetUserId: z.string().min(1),
});

const MemberRolesPatchSchema = z.object({
  roleIds: z.array(z.string().min(1)).max(64),
});

const ChannelOverwriteSchema = z
  .object({
    targetType: z.enum(['role', 'user']),
    targetId: z.string().min(1),
    allow: z.array(PermissionSchema).default([]),
    deny: z.array(PermissionSchema).default([]),
  })
  .superRefine((value, context) => {
    const deny = new Set(value.deny);
    for (const permission of value.allow) {
      if (deny.has(permission)) {
        context.addIssue({
          code: 'custom',
          path: ['allow'],
          message: `${permission} cannot be both allowed and denied.`,
        });
      }
    }
  });

const ChannelOverwritesPutSchema = z.object({
  overwrites: z.array(ChannelOverwriteSchema).max(128),
});

const FACTORY_RESET_CONFIRMATION = 'RESET CURRENT SERVER';

const FactoryResetSchema = z.object({
  confirmation: z.literal(FACTORY_RESET_CONFIRMATION),
});

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

function ensureManageServerPermission(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  serverId: string,
): boolean {
  if (!request.currentUser) {
    reply.code(401).send({ error: 'Unauthorized.' });
    return false;
  }

  if (!hasServerPermission(app.appContext, {
    serverId,
    user: request.currentUser,
    permission: 'MANAGE_SERVER',
  })) {
    denyForbidden(reply, 'MANAGE_SERVER');
    return false;
  }

  return true;
}

function moderationSummary(type: string, targetUserId: string, reason?: string): string {
  const verbMap: Record<string, string> = {
    ban: 'Banned',
    mute: 'Muted',
    timeout: 'Timed out',
    kick: 'Kicked',
    warn: 'Warned',
  };
  const verb = verbMap[type] ?? type;
  return `${verb} ${targetUserId}${reason ? ` (${reason})` : ''}`;
}

function normalizeRegistrationMode(mode: string): RegistrationMode {
  if (mode === 'open_signup' || mode === 'manual_approval') {
    return mode;
  }
  return 'invite_only';
}

function isValidLanRedirectBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getByPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function changedRestartFields(before: CurrentConfig, after: CurrentConfig): string[] {
  return RestartRequiredFieldPaths.filter((path) => {
    return JSON.stringify(getByPath(before, path)) !== JSON.stringify(getByPath(after, path));
  });
}

function roleIdsGrantPermission(roles: Role[], roleIds: string[], permission: Permission): boolean {
  const permissions = resolvePermissions({
    roleIds,
    roles,
    channelOverwrites: [],
    userId: 'permission-preview',
  });
  return hasPermission(permissions, permission);
}

function buildRedactedConfig(app: FastifyInstance, config: CurrentConfig) {
  return {
    server: config.server,
    auth: {
      mode: config.auth.mode,
      atprotoClientId: config.auth.atprotoClientId,
      redirectUri: config.auth.redirectUri,
      lanRedirectBaseUrl: config.auth.lanRedirectBaseUrl,
      authorizationEndpoint: config.auth.authorizationEndpoint,
      tokenEndpoint: config.auth.tokenEndpoint,
      profileEndpoint: config.auth.profileEndpoint,
      scope: config.auth.scope,
      allowDevLogin: config.auth.allowDevLogin,
      cookieSecretConfigured: config.auth.cookieSecret.trim().length > 0,
    },
    storage: {
      sqlitePath: config.storage.sqlitePath,
      uploadDir: config.storage.uploadDir,
      mediaBackend: config.storage.mediaBackend,
      s3: config.storage.s3
        ? {
            endpoint: config.storage.s3.endpoint,
            bucket: config.storage.s3.bucket,
            accessKeyIdConfigured: config.storage.s3.accessKeyId.trim().length > 0,
            secretAccessKeyConfigured: config.storage.s3.secretAccessKey.trim().length > 0,
          }
        : undefined,
    },
    media: {
      maxAttachmentBytes: config.media.maxAttachmentBytes,
      allowedMimePrefixes: config.media.allowedMimePrefixes,
      gifProvider: config.media.gifProvider,
      gifFallbackProvider: config.media.gifFallbackProvider,
      klipyApiKeyConfigured: config.media.klipyApiKey.trim().length > 0,
      giphyApiKeyConfigured: config.media.giphyApiKey.trim().length > 0,
    },
    appearance: buildPublicAppearance(app, config),
    moderation: config.moderation,
    rtc: {
      listenIp: config.rtc.listenIp,
      announcedIp: config.rtc.announcedIp,
      udpMinPort: config.rtc.udpMinPort,
      udpMaxPort: config.rtc.udpMaxPort,
      workerCount: config.rtc.workerCount,
      sessionTimeoutMs: config.rtc.sessionTimeoutMs,
      turnUrls: config.rtc.turnUrls,
      turnUsernameConfigured: Boolean(config.rtc.turnUsername?.trim()),
      turnCredentialConfigured: Boolean(config.rtc.turnCredential?.trim()),
    },
    observability: config.observability,
  };
}

function buildSettingsPayload(app: FastifyInstance, restartRequiredFields: string[] = []) {
  const config = app.appContext.serverConfig.get();
  const serverRecord = app.appContext.repos.servers.getPrimaryServer();
  const ownerUserId = app.appContext.setup.getOwnerUserId() ?? undefined;
  const appearance = buildPublicAppearance(app, config);
  const server = {
    id: serverRecord?.id,
    name: config.server.name,
    slug: config.server.slug,
    host: config.server.host,
    port: config.server.port,
    publicUrl: config.server.publicUrl,
    registrationMode: normalizeRegistrationMode(config.server.registrationMode),
    iconAttachmentId: serverRecord?.iconAttachmentId,
    bannerAttachmentId: serverRecord?.bannerAttachmentId,
    iconUrl: serverRecord?.iconUrl,
    bannerUrl: serverRecord?.bannerUrl,
    appearance,
  };

  return {
    server,
    config: buildRedactedConfig(app, config),
    auth: {
      mode: config.auth.mode,
      lanRedirectBaseUrl: config.auth.lanRedirectBaseUrl,
    },
    media: {
      gifProvider: config.media.gifProvider,
      gifFallbackProvider: config.media.gifFallbackProvider,
      klipyApiKeyConfigured: config.media.klipyApiKey.trim().length > 0,
      giphyApiKeyConfigured: config.media.giphyApiKey.trim().length > 0,
    },
    secrets: {
      klipyApiKeyConfigured: config.media.klipyApiKey.trim().length > 0,
      giphyApiKeyConfigured: config.media.giphyApiKey.trim().length > 0,
      cookieSecretConfigured: config.auth.cookieSecret.trim().length > 0,
      s3AccessKeyIdConfigured: Boolean(config.storage.s3?.accessKeyId.trim()),
      s3SecretAccessKeyConfigured: Boolean(config.storage.s3?.secretAccessKey.trim()),
      turnUsernameConfigured: Boolean(config.rtc.turnUsername?.trim()),
      turnCredentialConfigured: Boolean(config.rtc.turnCredential?.trim()),
    },
    capabilities: {
      canManageServer: true,
      canManageRoles: true,
      canManageChannels: true,
      canModerateMembers: true,
    },
    restartRequiredFieldPaths: RestartRequiredFieldPaths,
    restartRequiredFields,
    restartRequired: restartRequiredFields.length > 0,
    ownership: {
      ownerUserId,
    },
  };
}

function buildConfigPatch(
  body: z.infer<typeof AdminSettingsPatchSchema>,
  current: CurrentConfig,
): DeepPartial<CurrentConfig> {
  const patch: DeepPartial<CurrentConfig> = {};
  const server = body.server ?? {};
  const auth = body.auth ?? {};
  const media = body.media ?? {};
  const appearance = body.appearance;

  if (
    body.registrationMode !== undefined ||
    server.registrationMode !== undefined ||
    server.name !== undefined ||
    server.slug !== undefined ||
    server.host !== undefined ||
    server.port !== undefined ||
    server.publicUrl !== undefined ||
    server.tls !== undefined
  ) {
    patch.server = {
      name: server.name,
      slug: server.slug,
      host: server.host,
      port: server.port,
      publicUrl: server.publicUrl,
      registrationMode: server.registrationMode ?? body.registrationMode,
      tls: server.tls
        ? {
            enabled: server.tls.enabled,
            certPath: server.tls.certPath,
            keyPath: server.tls.keyPath,
          }
        : undefined,
    };
  }

  if (
    body.authMode !== undefined ||
    body.lanRedirectBaseUrl !== undefined ||
    Object.keys(auth).length > 0
  ) {
    patch.auth = {
      mode: auth.mode ?? body.authMode,
      atprotoClientId: auth.atprotoClientId,
      redirectUri: auth.redirectUri,
      lanRedirectBaseUrl: auth.lanRedirectBaseUrl ?? body.lanRedirectBaseUrl,
      authorizationEndpoint: auth.authorizationEndpoint,
      tokenEndpoint: auth.tokenEndpoint,
      profileEndpoint: auth.profileEndpoint,
      scope: auth.scope,
      allowDevLogin: auth.allowDevLogin,
      cookieSecret: auth.cookieSecret,
    };
  }

  if (body.storage) {
    patch.storage = {
      sqlitePath: body.storage.sqlitePath,
      uploadDir: body.storage.uploadDir,
      mediaBackend: body.storage.mediaBackend,
      s3: body.storage.s3
        ? {
            endpoint: body.storage.s3.endpoint ?? current.storage.s3?.endpoint ?? 'https://example.invalid',
            bucket: body.storage.s3.bucket ?? current.storage.s3?.bucket ?? 'current',
            accessKeyId: body.storage.s3.clearAccessKeyId
              ? 'cleared'
              : body.storage.s3.accessKeyId ?? current.storage.s3?.accessKeyId ?? 'unset',
            secretAccessKey: body.storage.s3.clearSecretAccessKey
              ? 'cleared'
              : body.storage.s3.secretAccessKey ?? current.storage.s3?.secretAccessKey ?? 'unset',
          }
        : undefined,
    };
  }

  if (
    body.klipyApiKey !== undefined ||
    body.giphyApiKey !== undefined ||
    body.tenorApiKey !== undefined ||
    Object.keys(media).length > 0
  ) {
    patch.media = {
      maxAttachmentBytes: media.maxAttachmentBytes,
      allowedMimePrefixes: media.allowedMimePrefixes,
      gifProvider: media.gifProvider,
      gifFallbackProvider: media.gifFallbackProvider,
      klipyApiKey: media.clearKlipyApiKey
        ? ''
        : media.klipyApiKey ?? body.klipyApiKey ?? body.tenorApiKey,
      giphyApiKey: media.clearGiphyApiKey
        ? ''
        : media.giphyApiKey ?? body.giphyApiKey,
    };
  }

  if (appearance) {
    patch.appearance = {
      backgroundAttachmentId:
        appearance.backgroundAttachmentId === undefined
          ? current.appearance.backgroundAttachmentId
          : appearance.backgroundAttachmentId ?? '',
      panelColor:
        appearance.panelColor === undefined
          ? current.appearance.panelColor
          : (appearance.panelColor ?? '').toLowerCase(),
      ownMessageColor:
        appearance.ownMessageColor === undefined
          ? current.appearance.ownMessageColor
          : (appearance.ownMessageColor ?? '').toLowerCase(),
      otherMessageColor:
        appearance.otherMessageColor === undefined
          ? current.appearance.otherMessageColor
          : (appearance.otherMessageColor ?? '').toLowerCase(),
    };
  }

  if (body.moderation) {
    patch.moderation = body.moderation;
  }

  if (body.rtc) {
    patch.rtc = {
      listenIp: body.rtc.listenIp,
      announcedIp: body.rtc.announcedIp,
      udpMinPort: body.rtc.udpMinPort,
      udpMaxPort: body.rtc.udpMaxPort,
      workerCount: body.rtc.workerCount,
      sessionTimeoutMs: body.rtc.sessionTimeoutMs,
      turnUrls: body.rtc.turnUrls,
      turnUsername: body.rtc.clearTurnUsername
        ? ''
        : body.rtc.turnUsername ?? current.rtc.turnUsername,
      turnCredential: body.rtc.clearTurnCredential
        ? ''
        : body.rtc.turnCredential ?? current.rtc.turnCredential,
    };
  }

  if (body.observability) {
    patch.observability = body.observability;
  }

  return patch;
}

function validateAssetBelongsToUpload(app: FastifyInstance, attachmentId: string | null | undefined): boolean {
  if (!attachmentId) {
    return true;
  }
  return Boolean(app.appContext.chat.getAttachment(attachmentId));
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/settings', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    reply.send(buildSettingsPayload(app));
  });

  app.patch('/admin/settings', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const body = AdminSettingsPatchSchema.safeParse(request.body);

    if (!status.serverId || !request.currentUser || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    const requestedLanRedirectBaseUrl = body.data.auth?.lanRedirectBaseUrl ?? body.data.lanRedirectBaseUrl;
    if (requestedLanRedirectBaseUrl !== undefined && !isValidLanRedirectBaseUrl(requestedLanRedirectBaseUrl)) {
      reply.code(400).send({
        error: 'LAN redirect base URL must be empty or a valid http(s) URL.',
      });
      return;
    }

    if (!validateAssetBelongsToUpload(app, body.data.server?.iconAttachmentId)) {
      reply.code(400).send({ error: 'Icon asset was not found.' });
      return;
    }
    if (!validateAssetBelongsToUpload(app, body.data.server?.bannerAttachmentId)) {
      reply.code(400).send({ error: 'Banner asset was not found.' });
      return;
    }
    const before = app.appContext.serverConfig.get();
    const appearanceAttachmentId = body.data.appearance?.backgroundAttachmentId;
    const isExistingBackgroundReference = appearanceAttachmentId === before.appearance.backgroundAttachmentId;
    if (!isExistingBackgroundReference && !validateAssetBelongsToUpload(app, appearanceAttachmentId)) {
      reply.code(400).send({ error: 'Background asset was not found.' });
      return;
    }

    try {
      const patch = buildConfigPatch(body.data, before);
      if (
        patch.appearance?.backgroundAttachmentId &&
        !validateAssetBelongsToUpload(app, patch.appearance.backgroundAttachmentId)
      ) {
        patch.appearance.backgroundAttachmentId = '';
      }
      const next = app.appContext.serverConfig.patchFullAdminSettings(patch);
      app.appContext.repos.servers.update(status.serverId, {
        name: body.data.server?.name ?? next.server.name,
        slug: body.data.server?.slug ?? next.server.slug,
        registrationMode: body.data.server?.registrationMode ?? body.data.registrationMode ?? next.server.registrationMode,
        iconAttachmentId: body.data.server?.iconAttachmentId,
        bannerAttachmentId: body.data.server?.bannerAttachmentId,
      });

      const payload = buildSettingsPayload(app, changedRestartFields(before, next));
      app.appContext.gateway.broadcast(GatewayEvents.SERVER_UPDATE, {
        server: buildPublicServerPayload(app),
      });
      reply.send(payload);
    } catch (error) {
      reply.code(400).send({
        error: error instanceof Error ? error.message : 'Invalid server settings.',
      });
    }
  });

  app.post('/admin/settings/factory-reset', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const body = FactoryResetSchema.safeParse(request.body);
    if (!status.serverId || !request.currentUser || !body.success) {
      reply.code(400).send({ error: 'Invalid factory reset confirmation.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    try {
      const result = app.appContext.setup.factoryReset();
      app.appContext.gateway.disconnectAll('Server factory reset');
      reply.clearCookie('current_session', {
        path: '/',
      });
      reply.send({
        configured: false,
        ...result,
      });
    } catch (error) {
      reply.code(500).send({
        error: error instanceof Error ? error.message : 'Factory reset failed.',
      });
    }
  });

  app.post('/admin/server-assets', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const query = z.object({ kind: z.enum(['icon', 'banner', 'background']) }).safeParse(request.query);
    if (!status.serverId || !request.currentUser || !query.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    const file = await request.file();
    if (!file) {
      reply.code(400).send({ error: 'No file uploaded.' });
      return;
    }

    if (!file.mimetype.startsWith('image/')) {
      reply.code(400).send({ error: 'Server look assets must be images.' });
      return;
    }

    const bytes = await file.toBuffer();
    try {
      const attachment = app.appContext.chat.saveAttachment({
        fileName: `${query.data.kind}-${file.filename}`,
        mimeType: file.mimetype,
        bytes,
        ownerUserId: request.currentUser.id,
      });
      reply.code(201).send({
        ...attachment,
        kind: query.data.kind,
        url: `/api/v1/media/attachments/${attachment.id}`,
      });
    } catch (error) {
      reply.code(400).send({
        error: error instanceof Error ? error.message : 'Asset upload failed.',
      });
    }
  });

  app.patch('/admin/members/:userId/roles', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const params = z.object({ userId: z.string().min(1) }).safeParse(request.params);
    const body = MemberRolesPatchSchema.safeParse(request.body);
    if (!status.serverId || !request.currentUser || !params.success || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_ROLES',
    })) {
      denyForbidden(reply, 'MANAGE_ROLES');
      return;
    }

    const roles = app.appContext.moderation.listRoles(status.serverId);
    const roleIds = new Set(roles.map((role) => role.id));
    if (body.data.roleIds.some((roleId) => !roleIds.has(roleId))) {
      reply.code(400).send({ error: 'One or more roles do not exist on this server.' });
      return;
    }

    const target = app.appContext.repos.users.findById(params.data.userId);
    if (!target) {
      reply.code(404).send({ error: 'Member not found.' });
      return;
    }

    if (
      target.id === request.currentUser.id &&
      !roleIdsGrantPermission(roles, body.data.roleIds, 'MANAGE_ROLES')
    ) {
      reply.code(400).send({ error: 'You cannot remove your own role-management access.' });
      return;
    }

    const ownerUserId = app.appContext.setup.getOwnerUserId();
    if (
      target.id === ownerUserId &&
      !roleIdsGrantPermission(roles, body.data.roleIds, 'MANAGE_SERVER')
    ) {
      reply.code(400).send({ error: 'The server owner must keep manage-server access.' });
      return;
    }

    const member = app.appContext.moderation.setMemberRoles({
      serverId: status.serverId,
      actorId: request.currentUser.id,
      targetUserId: target.id,
      roleIds: [...new Set(body.data.roleIds)],
    });

    reply.send(member);
  });

  app.get('/admin/channels/:channelId/overwrites', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const params = z.object({ channelId: z.string().min(1) }).safeParse(request.params);
    if (!status.serverId || !request.currentUser || !params.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_CHANNELS',
    })) {
      denyForbidden(reply, 'MANAGE_CHANNELS');
      return;
    }

    const channel = app.appContext.chat.getChannelById(params.data.channelId);
    if (!channel || channel.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    reply.send(app.appContext.repos.channels.listOverwrites(channel.id));
  });

  app.put('/admin/channels/:channelId/overwrites', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const params = z.object({ channelId: z.string().min(1) }).safeParse(request.params);
    const body = ChannelOverwritesPutSchema.safeParse(request.body);
    if (!status.serverId || !request.currentUser || !params.success || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_CHANNELS',
    })) {
      denyForbidden(reply, 'MANAGE_CHANNELS');
      return;
    }

    const channel = app.appContext.chat.getChannelById(params.data.channelId);
    if (!channel || channel.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    const roles = new Set(app.appContext.moderation.listRoles(status.serverId).map((role) => role.id));
    for (const overwrite of body.data.overwrites) {
      if (overwrite.targetType === 'role' && !roles.has(overwrite.targetId)) {
        reply.code(400).send({ error: 'Role overwrite target does not exist.' });
        return;
      }
      if (overwrite.targetType === 'user' && !app.appContext.repos.users.findById(overwrite.targetId)) {
        reply.code(400).send({ error: 'User overwrite target does not exist.' });
        return;
      }
    }

    const overwrites = app.appContext.moderation.replaceChannelOverwrites({
      serverId: status.serverId,
      actorId: request.currentUser.id,
      channelId: channel.id,
      overwrites: body.data.overwrites,
    });

    reply.send(overwrites);
  });

  app.delete('/admin/channels/:channelId/overwrites/:overwriteId', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const params = z
      .object({
        channelId: z.string().min(1),
        overwriteId: z.string().min(1),
      })
      .safeParse(request.params);
    if (!status.serverId || !request.currentUser || !params.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_CHANNELS',
    })) {
      denyForbidden(reply, 'MANAGE_CHANNELS');
      return;
    }

    const channel = app.appContext.chat.getChannelById(params.data.channelId);
    if (!channel || channel.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    app.appContext.moderation.deleteChannelOverwrite({
      serverId: status.serverId,
      actorId: request.currentUser.id,
      channelId: channel.id,
      overwriteId: params.data.overwriteId,
    });

    reply.code(204).send();
  });

  app.post('/admin/ownership/transfer', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const body = OwnershipTransferSchema.safeParse(request.body);
    if (!status.serverId || !request.currentUser || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    try {
      const owner = app.appContext.setup.transferOwnership({
        serverId: status.serverId,
        actorId: request.currentUser.id,
        targetUserId: body.data.targetUserId,
      });
      reply.send({
        ownerUserId: owner.id,
      });
    } catch (error) {
      reply.code(400).send({
        error: error instanceof Error ? error.message : 'Ownership transfer failed.',
      });
    }
  });

  app.post('/admin/ownership/claim-host', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!isRequestFromHostMachine(request)) {
      reply.code(403).send({
        error: {
          code: 'HOST_ONLY',
          message: 'Ownership claim is only allowed from the host machine.',
        },
      });
      return;
    }

    try {
      const owner = app.appContext.setup.transferOwnership({
        serverId: status.serverId,
        actorId: request.currentUser.id,
        targetUserId: request.currentUser.id,
      });
      reply.send({
        ownerUserId: owner.id,
      });
    } catch (error) {
      reply.code(400).send({
        error: error instanceof Error ? error.message : 'Ownership claim failed.',
      });
    }
  });

  app.get('/admin/moderation/logs', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).safeParse(request.query);
    if (!status.serverId || !request.currentUser || !query.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    const limit = query.data.limit ?? 150;
    const modActions = app.appContext.moderation.listActions(status.serverId).map((action) => ({
      id: `mod:${action.id}`,
      source: 'moderation' as const,
      action: action.type,
      actorId: action.actorId,
      targetId: action.targetUserId,
      createdAt: action.createdAt,
      summary: moderationSummary(action.type, action.targetUserId, action.reason),
      payload: {
        reason: action.reason,
        expiresAt: action.expiresAt,
      },
    }));

    const auditLogs = app.appContext.moderation.listAuditLogs(status.serverId, Math.max(limit * 2, 300)).map((log) => ({
      id: `audit:${log.id}`,
      source: 'audit' as const,
      action: log.action,
      actorId: log.actorId,
      targetId: log.targetId,
      createdAt: log.createdAt,
      summary: log.action,
      payload: log.payload,
    }));

    const feed = [...modActions, ...auditLogs]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);

    reply.send(feed);
  });

  app.get('/admin/shared-ips', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!ensureManageServerPermission(app, request, reply, status.serverId)) {
      return;
    }

    reply.send(app.appContext.members.listSharedIpGroups());
  });
}
