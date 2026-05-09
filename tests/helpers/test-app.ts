import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDefaultConfig } from '@current/config';
import { createDb } from '../../apps/server/src/db/client.js';
import { createAppContext } from '../../apps/server/src/create-context.js';
import { buildApp } from '../../apps/server/src/app.js';
import { InMemoryVoiceSfuAdapter } from '../../apps/server/src/voice/in-memory-voice-sfu-adapter.js';

export async function createTestApp(options: { webDistDir?: string | false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'current-test-'));
  const dbPath = join(dir, 'current.sqlite');
  const uploads = join(dir, 'uploads');
  const configPath = join(dir, 'current.config.json');

  const config = createDefaultConfig({
    server: {
      name: 'Test Current',
      slug: 'test-current',
      publicUrl: 'http://localhost:8080',
    },
    storage: {
      sqlitePath: dbPath,
      uploadDir: uploads,
      mediaBackend: 'local',
    },
    auth: {
      atprotoClientId: 'test-client',
      redirectUri: 'http://127.0.0.1:8080/api/v1/auth/oauth/callback',
      authorizationEndpoint: 'https://example.com/oauth/authorize',
      tokenEndpoint: 'https://example.com/oauth/token',
      profileEndpoint: 'https://example.com/profile',
      scope: 'atproto transition:generic',
      cookieSecret: 'super-secret-cookie-key-for-tests-only',
    },
    media: {
      maxAttachmentBytes: 8 * 1024 * 1024,
      allowedMimePrefixes: ['image/', 'application/'],
      klipyApiKey: 'test-key',
    },
  });

  const db = createDb(config.storage.sqlitePath);
  const voiceSfu = new InMemoryVoiceSfuAdapter({
    getConfig: () => config,
  });

  const context = createAppContext({
    db,
    config,
    configPath,
    voiceSfu,
  });

  const app = buildApp(context, { webDistDir: options.webDistDir ?? false });
  await app.ready();

  async function close() {
    await app.close();
    db.close();
  }

  return {
    app,
    db,
    context,
    close,
  };
}
