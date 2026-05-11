import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

function insertUserSession(
  db: Awaited<ReturnType<typeof createTestApp>>['db'],
  input: {
    userId: string;
    sessionToken: string;
    did: string;
    handle: string;
    displayName: string;
  },
) {
  db.prepare(
    `
    INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(input.userId, input.did, input.handle, input.displayName, null, nowIso(), nowIso());

  db.prepare(
    `
    INSERT INTO sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(input.sessionToken, input.userId, addHours(1), nowIso());
}

describe('server access requests', () => {
  it('lets admins approve manual approval waitlist requests', async () => {
    const { app, db, close } = await createTestApp();

    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Manual Approval Server',
        slug: 'manual-approval-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'manual_approval',
        adminDid: 'did:current:dev:access-admin',
        adminHandle: 'access.admin@current',
        adminDisplayName: 'Access Admin',
      },
    });
    expect(bootstrap.statusCode).toBe(201);
    const { serverId } = bootstrap.json() as { serverId: string };

    const admin = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:current:dev:access-admin') as { id: string } | undefined;
    expect(admin?.id).toBeTruthy();
    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('access_admin_session', admin!.id, addHours(1), nowIso());

    insertUserSession(db, {
      userId: 'usr_waitlist',
      sessionToken: 'waitlist_session',
      did: 'did:current:dev:waitlist',
      handle: 'waitlist.user@current',
      displayName: 'Waitlist User',
    });

    const initialSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: 'waitlist_session',
      },
    });
    expect(initialSession.statusCode).toBe(200);
    expect((initialSession.json() as { access: { state: string } }).access.state).toBe('not_requested');

    const waitlist = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/waitlist',
      cookies: {
        current_session: 'waitlist_session',
      },
      payload: {
        notificationsEnabled: true,
        source: 'browser',
      },
    });
    expect(waitlist.statusCode).toBe(201);
    expect((waitlist.json() as { access: { state: string; request: { notificationsEnabled: boolean } } }).access)
      .toMatchObject({
        state: 'pending',
        request: {
          notificationsEnabled: true,
        },
      });

    const blockedChannels = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: 'waitlist_session',
      },
    });
    expect(blockedChannels.statusCode).toBe(403);
    expect(blockedChannels.json()).toMatchObject({
      error: {
        code: 'SERVER_ACCESS_PENDING',
      },
    });

    const requests = await app.inject({
      method: 'GET',
      url: '/api/v1/access-requests?status=pending',
      cookies: {
        current_session: 'access_admin_session',
      },
    });
    expect(requests.statusCode).toBe(200);
    expect(requests.json()).toMatchObject([
      {
        userId: 'usr_waitlist',
        status: 'pending',
        user: {
          displayName: 'Waitlist User',
        },
      },
    ]);

    const approval = await app.inject({
      method: 'POST',
      url: '/api/v1/access-requests/usr_waitlist/approve',
      cookies: {
        current_session: 'access_admin_session',
      },
    });
    expect(approval.statusCode).toBe(200);
    expect((approval.json() as { status: string }).status).toBe('approved');

    const memberRole = db
      .prepare('SELECT id FROM roles WHERE server_id = ? AND name = ?')
      .get(serverId, 'Member') as { id: string } | undefined;
    expect(memberRole?.id).toBeTruthy();
    const membership = db
      .prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?')
      .get('usr_waitlist', memberRole!.id);
    expect(membership).toBeTruthy();

    const approvedSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: 'waitlist_session',
      },
    });
    expect(approvedSession.statusCode).toBe(200);
    expect((approvedSession.json() as { access: { state: string } }).access.state).toBe('approved');

    const allowedChannels = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: 'waitlist_session',
      },
    });
    expect(allowedChannels.statusCode).toBe(200);

    await close();
  });

  it('keeps existing public members in but gates fresh users after switching to manual approval', async () => {
    const { app, db, close } = await createTestApp();

    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Manual Switch Server',
        slug: 'manual-switch-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'open_signup',
        adminDid: 'did:current:dev:switch-admin',
        adminHandle: 'switch.admin@current',
        adminDisplayName: 'Switch Admin',
      },
    });
    expect(bootstrap.statusCode).toBe(201);

    const admin = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:current:dev:switch-admin') as { id: string } | undefined;
    expect(admin?.id).toBeTruthy();
    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('switch_admin_session', admin!.id, addHours(1), nowIso());

    const publicLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        handle: 'public.member@current',
        displayName: 'Public Member',
      },
    });
    expect(publicLogin.statusCode).toBe(200);
    const publicSessionCookie = publicLogin.cookies.find((cookie) => cookie.name === 'current_session')?.value;
    expect(publicSessionCookie).toBeTruthy();

    const publicSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: publicSessionCookie!,
      },
    });
    expect(publicSession.statusCode).toBe(200);
    expect((publicSession.json() as { access: { state: string } }).access.state).toBe('approved');

    const switchMode = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'switch_admin_session',
      },
      payload: {
        server: {
          registrationMode: 'manual_approval',
        },
      },
    });
    expect(switchMode.statusCode).toBe(200);
    expect((switchMode.json() as { server: { registrationMode: string } }).server.registrationMode).toBe('manual_approval');

    const existingMemberChannels = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: publicSessionCookie!,
      },
    });
    expect(existingMemberChannels.statusCode).toBe(200);

    const freshLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        handle: 'fresh.manual@current',
        displayName: 'Fresh Manual',
      },
    });
    expect(freshLogin.statusCode).toBe(200);
    const freshSessionCookie = freshLogin.cookies.find((cookie) => cookie.name === 'current_session')?.value;
    expect(freshSessionCookie).toBeTruthy();

    const freshSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: freshSessionCookie!,
      },
    });
    expect(freshSession.statusCode).toBe(200);
    expect((freshSession.json() as { access: { state: string } }).access.state).toBe('not_requested');

    const freshBlockedChannels = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: freshSessionCookie!,
      },
    });
    expect(freshBlockedChannels.statusCode).toBe(403);
    expect(freshBlockedChannels.json()).toMatchObject({
      error: {
        code: 'SERVER_ACCESS_REQUIRED',
      },
    });

    const waitlist = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/waitlist',
      cookies: {
        current_session: freshSessionCookie!,
      },
      payload: {
        source: 'browser',
      },
    });
    expect(waitlist.statusCode).toBe(201);
    expect((waitlist.json() as { access: { state: string } }).access.state).toBe('pending');

    await close();
  });

  it('requires kicked manual approval members to request access again when they come back', async () => {
    const { app, db, close } = await createTestApp();

    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Manual Kick Server',
        slug: 'manual-kick-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'manual_approval',
        adminDid: 'did:current:dev:kick-admin',
        adminHandle: 'kick.admin@current',
        adminDisplayName: 'Kick Admin',
      },
    });
    expect(bootstrap.statusCode).toBe(201);
    const { serverId } = bootstrap.json() as { serverId: string };

    const admin = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:current:dev:kick-admin') as { id: string } | undefined;
    expect(admin?.id).toBeTruthy();
    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('kick_admin_session', admin!.id, addHours(1), nowIso());

    const firstLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        handle: 'manual.kicked@current',
        displayName: 'Manual Kicked',
      },
    });
    expect(firstLogin.statusCode).toBe(200);
    const firstSessionCookie = firstLogin.cookies.find((cookie) => cookie.name === 'current_session')?.value;
    expect(firstSessionCookie).toBeTruthy();
    const firstUser = firstLogin.json() as { user: { id: string } };

    const waitlist = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/waitlist',
      cookies: {
        current_session: firstSessionCookie!,
      },
      payload: {
        source: 'browser',
      },
    });
    expect(waitlist.statusCode).toBe(201);

    const approval = await app.inject({
      method: 'POST',
      url: `/api/v1/access-requests/${firstUser.user.id}/approve`,
      cookies: {
        current_session: 'kick_admin_session',
      },
    });
    expect(approval.statusCode).toBe(200);

    const approvedChannels = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: firstSessionCookie!,
      },
    });
    expect(approvedChannels.statusCode).toBe(200);

    const kick = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      cookies: {
        current_session: 'kick_admin_session',
      },
      payload: {
        targetUserId: firstUser.user.id,
        type: 'kick',
        reason: 'Needs another look',
      },
    });
    expect(kick.statusCode).toBe(201);

    const memberRole = db
      .prepare('SELECT id FROM roles WHERE server_id = ? AND name = ?')
      .get(serverId, 'Member') as { id: string } | undefined;
    expect(memberRole?.id).toBeTruthy();
    expect(
      db
        .prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?')
        .get(firstUser.user.id, memberRole!.id),
    ).toBeFalsy();
    expect(
      db
        .prepare('SELECT 1 FROM access_requests WHERE server_id = ? AND user_id = ?')
        .get(serverId, firstUser.user.id),
    ).toBeFalsy();

    const returnLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        handle: 'manual.kicked@current',
        displayName: 'Manual Kicked',
      },
    });
    expect(returnLogin.statusCode).toBe(200);
    const returnSessionCookie = returnLogin.cookies.find((cookie) => cookie.name === 'current_session')?.value;
    expect(returnSessionCookie).toBeTruthy();

    const returnedSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: returnSessionCookie!,
      },
    });
    expect(returnedSession.statusCode).toBe(200);
    expect((returnedSession.json() as { access: { state: string } }).access.state).toBe('not_requested');

    const blockedChannels = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: returnSessionCookie!,
      },
    });
    expect(blockedChannels.statusCode).toBe(403);
    expect(blockedChannels.json()).toMatchObject({
      error: {
        code: 'SERVER_ACCESS_REQUIRED',
      },
    });

    const secondWaitlist = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/waitlist',
      cookies: {
        current_session: returnSessionCookie!,
      },
      payload: {
        source: 'browser',
      },
    });
    expect(secondWaitlist.statusCode).toBe(201);
    expect((secondWaitlist.json() as { access: { state: string } }).access.state).toBe('pending');

    await close();
  });

  it('lets signed-in users claim invite-only access with an invite code', async () => {
    const { app, db, close } = await createTestApp();

    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Invite Access Server',
        slug: 'invite-access-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:current:dev:invite-admin',
        adminHandle: 'invite.admin@current',
        adminDisplayName: 'Invite Admin',
      },
    });
    expect(bootstrap.statusCode).toBe(201);

    const admin = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:current:dev:invite-admin') as { id: string } | undefined;
    expect(admin?.id).toBeTruthy();
    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('invite_admin_session', admin!.id, addHours(1), nowIso());

    const inviteResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      cookies: {
        current_session: 'invite_admin_session',
      },
      payload: {},
    });
    expect(inviteResponse.statusCode).toBe(201);
    const invite = inviteResponse.json() as { code: string };

    insertUserSession(db, {
      userId: 'usr_invited',
      sessionToken: 'invited_session',
      did: 'did:current:dev:invited',
      handle: 'invited.user@current',
      displayName: 'Invited User',
    });

    const blockedSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: 'invited_session',
      },
    });
    expect(blockedSession.statusCode).toBe(200);
    expect((blockedSession.json() as { access: { state: string } }).access.state).toBe('invite_required');

    const claim = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/invite/claim',
      cookies: {
        current_session: 'invited_session',
      },
      payload: {
        code: invite.code,
      },
    });
    expect(claim.statusCode).toBe(200);
    expect((claim.json() as { access: { state: string } }).access.state).toBe('approved');

    const usedInvite = db
      .prepare('SELECT used_count FROM invites WHERE code = ?')
      .get(invite.code) as { used_count: number } | undefined;
    expect(usedInvite?.used_count).toBe(1);

    const allowedChannels = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: 'invited_session',
      },
    });
    expect(allowedChannels.statusCode).toBe(200);

    await close();
  });
});
