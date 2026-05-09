import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const PanelColorSchema = z
  .string()
  .transform((value) => normalizePanelColor(value))
  .default('');

const CurrentConfigSchema = z.object({
  version: z.literal(1),
  server: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    host: z.string().default('0.0.0.0'),
    port: z.number().int().positive().default(8080),
    publicUrl: z.string().url(),
    registrationMode: z.enum(['invite_only', 'open_signup', 'manual_approval']).default('invite_only'),
    tls: z
      .object({
        enabled: z.boolean().default(false),
        certPath: z.string().default(''),
        keyPath: z.string().default(''),
      })
      .default({
        enabled: false,
        certPath: '',
        keyPath: '',
      }),
  }),
  auth: z.object({
    mode: z.enum(['atproto', 'lan']).default('atproto'),
    atprotoClientId: z.string().default(''),
    redirectUri: z.string().url(),
    lanRedirectBaseUrl: z.union([z.string().url(), z.literal('')]).default(''),
    authorizationEndpoint: z.string().url(),
    tokenEndpoint: z.string().url(),
    profileEndpoint: z.string().url(),
    scope: z.string().default('atproto transition:generic'),
    cookieSecret: z.string().min(24),
    allowDevLogin: z.boolean().default(true),
  }),
  storage: z.object({
    sqlitePath: z.string().default('apps/server/data/current.sqlite'),
    uploadDir: z.string().default('apps/server/uploads'),
    mediaBackend: z.enum(['local', 's3']).default('local'),
    s3: z
      .object({
        endpoint: z.string().url(),
        bucket: z.string().min(1),
        accessKeyId: z.string().min(1),
        secretAccessKey: z.string().min(1),
      })
      .optional(),
  }),
  media: z.object({
    maxAttachmentBytes: z.number().int().positive().default(10 * 1024 * 1024),
    allowedMimePrefixes: z.array(z.string()).default(['image/', 'video/', 'audio/', 'application/pdf']),
    gifProvider: z.enum(['klipy', 'giphy']).default('klipy'),
    gifFallbackProvider: z.enum(['none', 'klipy', 'giphy']).default('none'),
    klipyApiKey: z.string().default(''),
    giphyApiKey: z.string().default(''),
  }),
  appearance: z
    .object({
      backgroundAttachmentId: z.string().default(''),
      panelColor: PanelColorSchema,
      ownMessageColor: PanelColorSchema,
      otherMessageColor: PanelColorSchema,
    })
    .default({
      backgroundAttachmentId: '',
      panelColor: '',
      ownMessageColor: '',
      otherMessageColor: '',
    }),
  moderation: z.object({
    defaultSlowmodeSeconds: z.number().int().min(0).default(0),
    maxMentionsPerMessage: z.number().int().positive().default(8),
    linkPolicy: z.enum(['allow', 'members_only', 'deny']).default('members_only'),
  }),
  rtc: z.object({
    listenIp: z.string().default('0.0.0.0'),
    announcedIp: z.string().default('127.0.0.1'),
    udpMinPort: z.number().int().positive().default(40000),
    udpMaxPort: z.number().int().positive().default(40100),
    workerCount: z.number().int().positive().max(8).default(1),
    sessionTimeoutMs: z.number().int().positive().default(45_000),
    turnUrls: z.array(z.string()).default([]),
    turnUsername: z.string().optional(),
    turnCredential: z.string().optional(),
  }),
  observability: z.object({
    metricsEnabled: z.boolean().default(true),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
});

export type CurrentConfig = z.infer<typeof CurrentConfigSchema>;
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type LegacyCurrentConfig = {
  version?: number;
  media?: {
    tenorApiKey?: string;
    klipyApiKey?: string;
  };
  appearance?: {
    backgroundAttachmentId?: string;
    panelColor?: string;
    ownMessageColor?: string;
    otherMessageColor?: string;
    panelBackgroundAttachmentIds?: {
      channels?: string;
      chatHeader?: string;
      messages?: string;
      members?: string;
    };
  };
};

function normalizePanelColor(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : '';
}

function resolveLegacyBackgroundAttachmentId(appearance: LegacyCurrentConfig['appearance']): string {
  if (!appearance) {
    return '';
  }
  if (typeof appearance.backgroundAttachmentId === 'string') {
    return appearance.backgroundAttachmentId;
  }
  return (
    appearance.panelBackgroundAttachmentIds?.messages ??
    appearance.panelBackgroundAttachmentIds?.channels ??
    appearance.panelBackgroundAttachmentIds?.chatHeader ??
    appearance.panelBackgroundAttachmentIds?.members ??
    ''
  );
}

function normalizeLegacyConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }

  const candidate = raw as LegacyCurrentConfig & Record<string, unknown>;
  const media = candidate.media;
  const appearance = candidate.appearance;
  let next = candidate;

  if (appearance && typeof appearance === 'object' && !Array.isArray(appearance)) {
    const backgroundAttachmentId = resolveLegacyBackgroundAttachmentId(appearance);
    next = {
      ...next,
      appearance: {
        backgroundAttachmentId,
        panelColor: normalizePanelColor(appearance.panelColor),
        ownMessageColor: normalizePanelColor(appearance.ownMessageColor),
        otherMessageColor: normalizePanelColor(appearance.otherMessageColor),
      },
    };
  }

  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    return next;
  }

  const hasKlipy = typeof media.klipyApiKey === 'string';
  const hasLegacyTenor = typeof media.tenorApiKey === 'string';
  if (hasKlipy || !hasLegacyTenor) {
    return next;
  }

  return {
    ...next,
    media: {
      ...(media as Record<string, unknown>),
      klipyApiKey: media.tenorApiKey,
    },
  };
}

export function loadConfig(path: string): CurrentConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return migrateConfig(raw);
}

export function saveConfig(path: string, config: CurrentConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}

export function configExists(path: string): boolean {
  return existsSync(path);
}

export function createDefaultConfig(partial: DeepPartial<CurrentConfig> = {}): CurrentConfig {
  const partialMedia = partial.media as (DeepPartial<CurrentConfig['media']> & { tenorApiKey?: string }) | undefined;
  const partialAppearance = partial.appearance as
    | (DeepPartial<CurrentConfig['appearance']> & LegacyCurrentConfig['appearance'])
    | undefined;

  const merged = {
    version: 1,
    server: {
      name: partial.server?.name ?? 'Current Server',
      slug: partial.server?.slug ?? 'current-server',
      host: partial.server?.host ?? '0.0.0.0',
      port: partial.server?.port ?? 8080,
      publicUrl: partial.server?.publicUrl ?? 'http://localhost:8080',
      registrationMode: partial.server?.registrationMode ?? 'invite_only',
      tls: {
        enabled: partial.server?.tls?.enabled ?? false,
        certPath: partial.server?.tls?.certPath ?? '',
        keyPath: partial.server?.tls?.keyPath ?? '',
      },
    },
    auth: {
      mode: partial.auth?.mode ?? 'atproto',
      atprotoClientId: partial.auth?.atprotoClientId ?? '',
      redirectUri: partial.auth?.redirectUri ?? 'http://localhost:8080/api/v1/auth/oauth/callback',
      lanRedirectBaseUrl: partial.auth?.lanRedirectBaseUrl ?? '',
      authorizationEndpoint:
        partial.auth?.authorizationEndpoint ?? 'https://bsky.social/oauth/authorize',
      tokenEndpoint: partial.auth?.tokenEndpoint ?? 'https://bsky.social/oauth/token',
      profileEndpoint: partial.auth?.profileEndpoint ?? 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile',
      scope: partial.auth?.scope ?? 'atproto transition:generic',
      cookieSecret: partial.auth?.cookieSecret ?? 'change-me-super-secret-cookie-key-please',
      allowDevLogin: partial.auth?.allowDevLogin ?? true,
    },
    storage: {
      sqlitePath: partial.storage?.sqlitePath ?? 'apps/server/data/current.sqlite',
      uploadDir: partial.storage?.uploadDir ?? 'apps/server/uploads',
      mediaBackend: partial.storage?.mediaBackend ?? 'local',
      s3: partial.storage?.s3,
    },
    media: {
      maxAttachmentBytes: partialMedia?.maxAttachmentBytes ?? 10 * 1024 * 1024,
      allowedMimePrefixes: partialMedia?.allowedMimePrefixes ?? ['image/', 'video/', 'audio/', 'application/pdf'],
      gifProvider: partialMedia?.gifProvider ?? 'klipy',
      gifFallbackProvider: partialMedia?.gifFallbackProvider ?? 'none',
      klipyApiKey: partialMedia?.klipyApiKey ?? partialMedia?.tenorApiKey ?? '',
      giphyApiKey: partialMedia?.giphyApiKey ?? '',
    },
    appearance: {
      backgroundAttachmentId: resolveLegacyBackgroundAttachmentId(partialAppearance),
      panelColor: normalizePanelColor(partialAppearance?.panelColor),
      ownMessageColor: normalizePanelColor(partialAppearance?.ownMessageColor),
      otherMessageColor: normalizePanelColor(partialAppearance?.otherMessageColor),
    },
    moderation: {
      defaultSlowmodeSeconds: partial.moderation?.defaultSlowmodeSeconds ?? 0,
      maxMentionsPerMessage: partial.moderation?.maxMentionsPerMessage ?? 8,
      linkPolicy: partial.moderation?.linkPolicy ?? 'members_only',
    },
    rtc: {
      listenIp: partial.rtc?.listenIp ?? '0.0.0.0',
      announcedIp: partial.rtc?.announcedIp ?? '127.0.0.1',
      udpMinPort: partial.rtc?.udpMinPort ?? 40000,
      udpMaxPort: partial.rtc?.udpMaxPort ?? 40100,
      workerCount: partial.rtc?.workerCount ?? 1,
      sessionTimeoutMs: partial.rtc?.sessionTimeoutMs ?? 45_000,
      turnUrls: partial.rtc?.turnUrls ?? [],
      turnUsername: partial.rtc?.turnUsername,
      turnCredential: partial.rtc?.turnCredential,
    },
    observability: {
      metricsEnabled: partial.observability?.metricsEnabled ?? true,
      logLevel: partial.observability?.logLevel ?? 'info',
    },
  } as CurrentConfig;

  return CurrentConfigSchema.parse(merged);
}

export function migrateConfig(raw: unknown): CurrentConfig {
  const normalized = normalizeLegacyConfig(raw);
  const parsed = normalized as { version?: number };
  if (!parsed.version || parsed.version < 1) {
    const migrated = createDefaultConfig(normalized as DeepPartial<CurrentConfig>);
    return migrated;
  }
  return CurrentConfigSchema.parse(normalized);
}
