import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

function sessionTokenFromSetCookie(rawSetCookie: string | string[] | undefined): string {
  const value = Array.isArray(rawSetCookie) ? rawSetCookie[0] : rawSetCookie;
  const sessionToken = value?.match(/current_session=([^;]+)/)?.[1];
  if (!sessionToken) {
    throw new Error('Expected current_session cookie token');
  }
  return sessionToken;
}

describe('LAN auth mode', () => {
  it('supports screen-name login without Bluesky OAuth', async () => {
    const { app, context, close } = await createTestApp();
    const config = context.serverConfig.get();
    context.serverConfig.set({
      ...config,
      auth: {
        ...config.auth,
        mode: 'lan',
      },
    });

    const setupStatusResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/setup/status',
    });
    expect(setupStatusResponse.statusCode).toBe(200);
    const setupStatus = setupStatusResponse.json() as { authMode?: string };
    expect(setupStatus.authMode).toBe('lan');

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/lan-login',
      payload: {
        screenName: 'LAN Tester',
      },
    });
    expect(loginResponse.statusCode).toBe(200);
    const sessionToken = sessionTokenFromSetCookie(loginResponse.headers['set-cookie']);

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: sessionToken,
      },
    });
    expect(sessionResponse.statusCode).toBe(200);
    const payload = sessionResponse.json() as { user: { did: string; handle: string; displayName: string } };
    expect(payload.user.displayName).toBe('LAN Tester');
    expect(payload.user.handle).toBe('lan-tester.lan');
    expect(payload.user.did.startsWith('did:current:lan:')).toBe(true);

    await close();
  });

  it('recovers LAN owner/admin only for host-machine LAN sessions', async () => {
    const { app, context, db, close } = await createTestApp();

    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'LAN Ownership',
        slug: 'lan-ownership',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrap.statusCode).toBe(201);

    const config = context.serverConfig.get();
    context.serverConfig.set({
      ...config,
      auth: {
        ...config.auth,
        mode: 'lan',
      },
    });

    const remoteLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/lan-login',
      remoteAddress: '10.22.33.44',
      payload: {
        screenName: 'Remote User',
      },
    });
    expect(remoteLogin.statusCode).toBe(200);
    const remoteSessionToken = sessionTokenFromSetCookie(remoteLogin.headers['set-cookie']);

    const remoteSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      remoteAddress: '10.22.33.44',
      cookies: {
        current_session: remoteSessionToken,
      },
    });
    expect(remoteSession.statusCode).toBe(200);
    const remotePayload = remoteSession.json() as { user: { id: string } };

    const remoteSettings = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      remoteAddress: '10.22.33.44',
      cookies: {
        current_session: remoteSessionToken,
      },
    });
    expect(remoteSettings.statusCode).toBe(403);

    const adminRole = db
      .prepare(`SELECT id FROM roles WHERE permissions LIKE '%ADMINISTRATOR%' LIMIT 1`)
      .get() as { id: string } | undefined;
    expect(adminRole?.id).toBeTruthy();
    if (!adminRole?.id) {
      throw new Error('Expected admin role to exist');
    }

    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(remotePayload.user.id, adminRole.id);
    db.prepare(
      `
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
    ).run('owner_user_id', remotePayload.user.id);

    const ownerAfterRemote = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('owner_user_id') as { value: string } | undefined;
    expect(ownerAfterRemote?.value).toBe(remotePayload.user.id);

    const hostLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/lan-login',
      payload: {
        screenName: 'Host User',
      },
    });
    expect(hostLogin.statusCode).toBe(200);
    const hostSessionToken = sessionTokenFromSetCookie(hostLogin.headers['set-cookie']);

    const hostSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: hostSessionToken,
      },
    });
    expect(hostSession.statusCode).toBe(200);
    const hostPayload = hostSession.json() as { user: { id: string } };

    const hostSettings = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: hostSessionToken,
      },
    });
    expect(hostSettings.statusCode).toBe(200);

    const ownerAfterHost = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('owner_user_id') as { value: string } | undefined;
    expect(ownerAfterHost?.value).toBe(hostPayload.user.id);
    expect(ownerAfterHost?.value).not.toBe(remotePayload.user.id);

    await close();
  });

  it('rejects OAuth start in LAN mode', async () => {
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
      method: 'GET',
      url: '/api/v1/auth/oauth/start?handle=test.bsky.social',
    });
    expect(response.statusCode).toBe(409);

    await close();
  });

  it('allows host-machine ownership recovery in LAN mode for existing non-LAN sessions', async () => {
    const { app, context, db, close } = await createTestApp();

    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'LAN Host Claim',
        slug: 'lan-host-claim',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrap.statusCode).toBe(201);

    const config = context.serverConfig.get();
    context.serverConfig.set({
      ...config,
      auth: {
        ...config.auth,
        mode: 'lan',
      },
    });

    const devLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        handle: 'host-dev@current',
        displayName: 'Host Dev',
      },
    });
    expect(devLogin.statusCode).toBe(200);
    const sessionToken = sessionTokenFromSetCookie(devLogin.headers['set-cookie']);

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: sessionToken,
      },
    });
    expect(session.statusCode).toBe(200);
    const payload = session.json() as { user: { id: string } };

    const owner = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('owner_user_id') as { value: string } | undefined;
    expect(owner?.value).toBe(payload.user.id);

    const canOpenSettings = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: sessionToken,
      },
    });
    expect(canOpenSettings.statusCode).toBe(200);

    await close();
  });
});
