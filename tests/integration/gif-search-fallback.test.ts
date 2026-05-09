import { describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

describe('gif search fallback', () => {
  it('returns an empty payload with providerError when Klipy is not configured', async () => {
    const { app, db, context, close } = await createTestApp();

    context.serverConfig.patchAdminSettings({
      klipyApiKey: '',
    });

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_gif',
      'did:plc:gif',
      'gif-user.bsky.social',
      'Gif User',
      null,
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('gif_session', 'usr_gif', addHours(1), nowIso());

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/media/gifs/search?q=Trending%20GIFs&limit=36',
      cookies: {
        current_session: 'gif_session',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      results?: unknown[];
      provider?: string;
      providerError?: { code?: string; message?: string };
    };
    expect(payload.provider).toBe('klipy');
    expect(payload.results).toEqual([]);
    expect(payload.providerError?.code).toBe('KLIPY_ERROR');
    expect(payload.providerError?.message).toContain('Klipy API key is not configured');

    await close();
  });

  it('uses the configured backup provider when the primary GIF provider fails', async () => {
    const { app, db, context, close } = await createTestApp();
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('https://api.klipy.com/')) {
        return new Response('quota exhausted', { status: 429 });
      }

      if (url.startsWith('https://api.giphy.com/')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'giphy-1',
                title: 'Backup GIF',
                images: {
                  original: {
                    url: 'https://media.giphy.com/original.gif',
                    mp4: 'https://media.giphy.com/original.mp4',
                  },
                  fixed_width_small: {
                    url: 'https://media.giphy.com/preview.gif',
                  },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response('unexpected provider', { status: 500 });
    });
    globalThis.fetch = mockFetch as typeof fetch;

    try {
      context.serverConfig.patchAdminSettings({
        gifProvider: 'klipy',
        gifFallbackProvider: 'giphy',
        klipyApiKey: 'primary-key',
        giphyApiKey: 'backup-key',
      });

      db.prepare(
        `
        INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        'usr_gif_backup',
        'did:plc:gif-backup',
        'gif-backup.bsky.social',
        'Gif Backup User',
        null,
        nowIso(),
        nowIso(),
      );

      db.prepare(
        `
        INSERT INTO sessions (token, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `,
      ).run('gif_backup_session', 'usr_gif_backup', addHours(1), nowIso());

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/media/gifs/search?q=wow&limit=5',
        cookies: {
          current_session: 'gif_backup_session',
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json() as {
        results?: Array<{
          id?: string;
          content_description?: string;
          media_formats?: { mp4?: { url?: string }; tinygif?: { url?: string } };
        }>;
        provider?: string;
        fallbackProvider?: string;
        providerError?: { provider?: string; code?: string; message?: string };
      };

      expect(payload.provider).toBe('giphy');
      expect(payload.fallbackProvider).toBe('giphy');
      expect(payload.providerError?.provider).toBe('klipy');
      expect(payload.providerError?.code).toBe('KLIPY_ERROR');
      expect(payload.providerError?.message).toContain('quota exhausted');
      expect(payload.results?.[0]?.id).toBe('giphy-1');
      expect(payload.results?.[0]?.content_description).toBe('Backup GIF');
      expect(payload.results?.[0]?.media_formats?.mp4?.url).toBe('https://media.giphy.com/original.mp4');
      expect(payload.results?.[0]?.media_formats?.tinygif?.url).toBe('https://media.giphy.com/preview.gif');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
      await close();
    }
  });
});
