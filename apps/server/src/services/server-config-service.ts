import { isIP } from 'node:net';
import {
  createDefaultConfig,
  loadConfig,
  saveConfig,
  type CurrentConfig,
  type DeepPartial,
} from '@current/config';
import type { RegistrationMode } from '@current/types';

function mergeDefined<T>(base: T, patch: DeepPartial<T>): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return base;
  }

  const next = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) {
      continue;
    }
    const existing = next[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      next[key] = mergeDefined(existing, value as DeepPartial<typeof existing>);
    } else {
      next[key] = value;
    }
  }

  return next as T;
}

export class ServerConfigService {
  private config: CurrentConfig;

  constructor(private readonly configPath: string, initialConfig?: CurrentConfig) {
    this.config = initialConfig ?? loadConfig(configPath);
  }

  get(): CurrentConfig {
    return this.config;
  }

  set(config: CurrentConfig): void {
    this.config = config;
    saveConfig(this.configPath, config);
  }

  patchFromSetup(input: {
    serverName: string;
    slug: string;
    publicUrl: string;
    registrationMode: RegistrationMode;
    media?: {
      gifProvider?: CurrentConfig['media']['gifProvider'];
      gifFallbackProvider?: CurrentConfig['media']['gifFallbackProvider'];
      klipyApiKey?: string;
      giphyApiKey?: string;
      maxAttachmentBytes?: number;
      allowedMimePrefixes?: string[];
    };
    moderation?: {
      defaultSlowmodeSeconds?: number;
      maxMentionsPerMessage?: number;
      linkPolicy?: CurrentConfig['moderation']['linkPolicy'];
    };
  }): CurrentConfig {
    const merged = createDefaultConfig(this.config);
    const hadExplicitClientId = merged.auth.atprotoClientId.trim().length > 0;
    merged.server.name = input.serverName;
    merged.server.slug = input.slug;
    merged.server.publicUrl = input.publicUrl;
    merged.server.registrationMode = input.registrationMode;
    if (input.media?.gifProvider) {
      merged.media.gifProvider = input.media.gifProvider;
    }
    if (input.media?.gifFallbackProvider) {
      merged.media.gifFallbackProvider =
        input.media.gifFallbackProvider === merged.media.gifProvider ? 'none' : input.media.gifFallbackProvider;
    } else if (merged.media.gifFallbackProvider === merged.media.gifProvider) {
      merged.media.gifFallbackProvider = 'none';
    }
    if (input.media?.klipyApiKey !== undefined) {
      merged.media.klipyApiKey = input.media.klipyApiKey.trim();
    }
    if (input.media?.giphyApiKey !== undefined) {
      merged.media.giphyApiKey = input.media.giphyApiKey.trim();
    }
    if (input.media?.maxAttachmentBytes !== undefined) {
      merged.media.maxAttachmentBytes = input.media.maxAttachmentBytes;
    }
    if (input.media?.allowedMimePrefixes !== undefined) {
      merged.media.allowedMimePrefixes = input.media.allowedMimePrefixes;
    }
    if (input.moderation?.defaultSlowmodeSeconds !== undefined) {
      merged.moderation.defaultSlowmodeSeconds = input.moderation.defaultSlowmodeSeconds;
    }
    if (input.moderation?.maxMentionsPerMessage !== undefined) {
      merged.moderation.maxMentionsPerMessage = input.moderation.maxMentionsPerMessage;
    }
    if (input.moderation?.linkPolicy !== undefined) {
      merged.moderation.linkPolicy = input.moderation.linkPolicy;
    }
    if (!hadExplicitClientId) {
      const discoverableClientId = this.deriveDiscoverableClientIdFromPublicUrl(input.publicUrl);
      if (discoverableClientId) {
        merged.auth.atprotoClientId = discoverableClientId;
      }
      merged.auth.redirectUri = this.buildDefaultOAuthRedirectUri(input.publicUrl);
    }
    this.set(merged);
    return merged;
  }

  patchRegistrationMode(mode: RegistrationMode): CurrentConfig {
    const merged = createDefaultConfig(this.config);
    merged.server.registrationMode = mode;
    this.set(merged);
    return merged;
  }

  patchAdminSettings(input: {
    registrationMode?: RegistrationMode;
    authMode?: 'atproto' | 'lan';
    gifProvider?: CurrentConfig['media']['gifProvider'];
    gifFallbackProvider?: CurrentConfig['media']['gifFallbackProvider'];
    klipyApiKey?: string;
    giphyApiKey?: string;
    lanRedirectBaseUrl?: string;
  }): CurrentConfig {
    const merged = createDefaultConfig(this.config);
    if (input.registrationMode) {
      merged.server.registrationMode = input.registrationMode;
    }
    if (input.authMode) {
      merged.auth.mode = input.authMode;
    }
    if (input.gifProvider) {
      merged.media.gifProvider = input.gifProvider;
    }
    if (input.gifFallbackProvider) {
      merged.media.gifFallbackProvider = input.gifFallbackProvider;
    }
    if (input.klipyApiKey !== undefined) {
      merged.media.klipyApiKey = input.klipyApiKey.trim();
    }
    if (input.giphyApiKey !== undefined) {
      merged.media.giphyApiKey = input.giphyApiKey.trim();
    }
    if (input.lanRedirectBaseUrl !== undefined) {
      merged.auth.lanRedirectBaseUrl = input.lanRedirectBaseUrl.trim();
    }
    this.set(merged);
    return merged;
  }

  patchFullAdminSettings(input: DeepPartial<CurrentConfig>): CurrentConfig {
    const current = createDefaultConfig(this.config);
    const merged = createDefaultConfig(mergeDefined(current, input));
    this.set(merged);
    return merged;
  }

  private buildDefaultOAuthRedirectUri(publicUrl: string): string {
    const redirect = new URL(publicUrl);
    redirect.pathname = '/api/v1/auth/oauth/callback';
    redirect.search = '';
    redirect.hash = '';
    return redirect.toString();
  }

  private deriveDiscoverableClientIdFromPublicUrl(publicUrl: string): string | null {
    try {
      const parsed = new URL(publicUrl);
      if (parsed.protocol !== 'https:') {
        return null;
      }
      if (parsed.hostname === 'localhost' || parsed.hostname === '::1' || isIP(parsed.hostname)) {
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
}
