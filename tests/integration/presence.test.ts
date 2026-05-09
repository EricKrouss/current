import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

describe('presence status integration', () => {
  it('lets authenticated users read and update their selected presence status', async () => {
    const { app, close } = await createTestApp();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        handle: 'presence.tester@current',
        displayName: 'Presence Tester',
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

    const initialResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/presence',
      cookies: {
        current_session: sessionToken,
      },
    });

    expect(initialResponse.statusCode).toBe(200);
    expect((initialResponse.json() as { selfStatus: string }).selfStatus).toBe('online');
    const initialStoredStatus = app.appContext.repos.users.getPresenceStatus(loginResponse.json().user.id);
    expect(initialStoredStatus).toBe('online');

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: '/api/v1/presence',
      cookies: {
        current_session: sessionToken,
      },
      payload: {
        status: 'dnd',
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect((updateResponse.json() as { selfStatus: string }).selfStatus).toBe('dnd');
    expect(app.appContext.repos.users.getPresenceStatus(loginResponse.json().user.id)).toBe('dnd');

    const secondLoginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        handle: 'presence.tester@current',
        displayName: 'Presence Tester',
      },
    });
    expect(secondLoginResponse.statusCode).toBe(200);
    const secondSetCookie = secondLoginResponse.headers['set-cookie'];
    const secondRawCookie = Array.isArray(secondSetCookie) ? secondSetCookie[0] : secondSetCookie;
    const secondSessionToken = secondRawCookie?.match(/current_session=([^;]+)/)?.[1];
    expect(secondSessionToken).toBeTruthy();
    if (!secondSessionToken) {
      throw new Error('Expected second current_session cookie token');
    }

    const restoredResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/presence',
      cookies: {
        current_session: secondSessionToken,
      },
    });
    expect(restoredResponse.statusCode).toBe(200);
    expect((restoredResponse.json() as { selfStatus: string }).selfStatus).toBe('dnd');

    const invalidResponse = await app.inject({
      method: 'PATCH',
      url: '/api/v1/presence',
      cookies: {
        current_session: sessionToken,
      },
      payload: {
        status: 'busy',
      },
    });

    expect(invalidResponse.statusCode).toBe(400);

    await close();
  });
});
