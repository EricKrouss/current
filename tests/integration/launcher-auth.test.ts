import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

describe('launcher auth route', () => {
  it('requires Gaia launcher DPoP credentials', async () => {
    const { app, close } = await createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/launcher',
      payload: {
        profile: {
          did: 'did:plc:launcher-test',
          handle: 'launcher.test',
        },
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: 'MISSING_LAUNCHER_TOKEN',
      },
    });

    await close();
  });

  it('stays disabled for LAN auth instances', async () => {
    const { app, context, close } = await createTestApp();
    const config = context.serverConfig.get();
    context.serverConfig.set({
      ...config,
      auth: {
        ...config.auth,
        mode: 'lan',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/launcher',
      payload: {
        profile: {
          did: 'did:plc:launcher-test',
          handle: 'launcher.test',
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'ATPROTO_AUTH_DISABLED',
      },
    });

    await close();
  });
});
