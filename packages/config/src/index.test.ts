import { describe, expect, it } from 'vitest';
import { createDefaultConfig, migrateConfig } from './index.js';

describe('config schema', () => {
  it('creates a valid default config', () => {
    const config = createDefaultConfig({});
    expect(config.version).toBe(1);
    expect(config.server.port).toBe(6414);
    expect(config.server.publicUrl).toBe('http://localhost:6414');
    expect(config.server.registrationMode).toBe('invite_only');
    expect(config.server.tls.enabled).toBe(false);
    expect(config.auth.mode).toBe('atproto');
    expect(config.auth.redirectUri).toBe('http://localhost:6414/api/v1/auth/oauth/callback');
    expect(config.auth.lanRedirectBaseUrl).toBe('');
    expect(config.media.gifProvider).toBe('klipy');
    expect(config.media.gifFallbackProvider).toBe('none');
    expect(config.media.giphyApiKey).toBe('');
    expect(config.appearance.backgroundAttachmentId).toBe('');
    expect(config.appearance.panelColor).toBe('');
    expect(config.appearance.ownMessageColor).toBe('');
    expect(config.appearance.otherMessageColor).toBe('');
    expect(config.rtc.workerCount).toBe(0);
  });

  it('migrates unknown versions into v1', () => {
    const migrated = migrateConfig({ server: { name: 'test', slug: 'test', publicUrl: 'http://localhost:8080' } });
    expect(migrated.version).toBe(1);
  });

  it('maps legacy tenorApiKey into klipyApiKey', () => {
    const migrated = migrateConfig({
      version: 1,
      server: { name: 'test', slug: 'test', publicUrl: 'http://localhost:8080' },
      auth: {
        atprotoClientId: '',
        redirectUri: 'http://127.0.0.1:8080/api/v1/auth/oauth/callback',
        authorizationEndpoint: 'https://bsky.social/oauth/authorize',
        tokenEndpoint: 'https://bsky.social/oauth/token',
        profileEndpoint: 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile',
        scope: 'atproto transition:generic',
        cookieSecret: 'change-me-super-secret-cookie-key-please',
        allowDevLogin: true,
      },
      storage: {
        sqlitePath: 'apps/server/data/current.sqlite',
        uploadDir: 'apps/server/uploads',
        mediaBackend: 'local',
      },
      media: {
        maxAttachmentBytes: 10 * 1024 * 1024,
        allowedMimePrefixes: ['image/'],
        tenorApiKey: 'legacy-tenor-key',
      },
      moderation: {
        defaultSlowmodeSeconds: 0,
        maxMentionsPerMessage: 8,
        linkPolicy: 'members_only',
      },
      rtc: {
        listenIp: '0.0.0.0',
        announcedIp: '127.0.0.1',
        udpMinPort: 40000,
        udpMaxPort: 40100,
        workerCount: 1,
        sessionTimeoutMs: 45000,
        turnUrls: [],
      },
      observability: {
        metricsEnabled: true,
        logLevel: 'info',
      },
    });

    expect(migrated.media.klipyApiKey).toBe('legacy-tenor-key');
    expect(migrated.media.gifProvider).toBe('klipy');
    expect(migrated.media.gifFallbackProvider).toBe('none');
  });
});
