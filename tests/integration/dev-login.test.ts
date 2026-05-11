import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

describe('dev login integration', () => {
  it('creates a local session when enabled', async () => {
    const { app, close } = await createTestApp();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        handle: 'local.tester@current',
        displayName: 'Local Tester',
      },
    });

    expect(loginResponse.statusCode).toBe(200);
    const setCookie = loginResponse.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const sessionToken = rawCookie?.match(/current_session=([^;]+)/)?.[1];
    expect(sessionToken).toBeTruthy();
    if (!sessionToken) {
      throw new Error('Expected current_session cookie token');
    }

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: sessionToken,
      },
    });

    expect(sessionResponse.statusCode).toBe(200);
    const payload = sessionResponse.json() as { user: { handle: string; displayName: string } };
    expect(payload.user.handle).toBe('local.tester@current');
    expect(payload.user.displayName).toBe('Local Tester');

    await close();
  });

  it('rejects local dev login when disabled', async () => {
    const { app, context, close } = await createTestApp();
    const config = context.serverConfig.get();
    context.serverConfig.set({
      ...config,
      auth: {
        ...config.auth,
        allowDevLogin: false,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
    });

    expect(response.statusCode).toBe(403);

    await close();
  });

  it('rejects local dev login from remote clients', async () => {
    const { app, close } = await createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      remoteAddress: '10.22.33.44',
      payload: {
        handle: 'remote.tester@current',
        displayName: 'Remote Tester',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: 'DEV_LOGIN_HOST_ONLY',
      },
    });

    await close();
  });
});
