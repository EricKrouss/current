import { describe, expect, it } from 'vitest';
import { GatewayEvents } from '@current/protocol';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

function parseGatewayPayload<T>(payload: string): T {
  return JSON.parse(payload) as T;
}

describe('members integration', () => {
  it('lists members with profile fields for authenticated clients', async () => {
    const { app, db, close } = await createTestApp();

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_1',
      'did:plc:one',
      'zeta.bsky.social',
      'Zeta',
      'https://example.com/zeta.png',
      nowIso(),
      nowIso(),
      'usr_2',
      'did:plc:two',
      'alpha.bsky.social',
      'Alpha',
      null,
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('member_session', 'usr_1', addHours(1), nowIso());

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/members',
      cookies: {
        current_session: 'member_session',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      items: Array<{ displayName: string; avatarUrl?: string }>;
    };
    expect(payload.items.map((member) => member.displayName)).toEqual(['Alpha', 'Zeta']);
    expect(payload.items.find((member) => member.displayName === 'Zeta')?.avatarUrl).toBe('https://example.com/zeta.png');

    await close();
  });

  it('hides kicked and banned members from the members list', async () => {
    const { app, db, close } = await createTestApp();
    const joinedAt = '2026-05-09T00:00:00.000Z';
    const removedAt = '2026-05-09T00:05:00.000Z';
    const rejoinedAt = '2026-05-09T00:10:00.000Z';

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Moderated Server',
        slug: 'moderated-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);
    const { serverId } = bootstrapResponse.json() as { serverId: string };

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_admin',
      'did:plc:admin',
      'admin.bsky.social',
      'Admin',
      null,
      joinedAt,
      joinedAt,
      'usr_kicked',
      'did:plc:kicked',
      'kicked.bsky.social',
      'Kicked User',
      null,
      joinedAt,
      joinedAt,
      'usr_banned',
      'did:plc:banned',
      'banned.bsky.social',
      'Banned User',
      null,
      joinedAt,
      joinedAt,
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('admin_session', 'usr_admin', addHours(1), nowIso());
    const memberRole = db
      .prepare('SELECT id FROM roles WHERE server_id = ? AND name = ?')
      .get(serverId, 'Member') as { id: string } | undefined;
    expect(memberRole?.id).toBeTruthy();
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run('usr_admin', memberRole!.id);

    db.prepare(
      `
      INSERT INTO moderation_actions (id, server_id, actor_id, target_user_id, type, reason, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'mod_kick',
      serverId,
      'usr_admin',
      'usr_kicked',
      'kick',
      'Removed by admin',
      null,
      removedAt,
      'mod_ban',
      serverId,
      'usr_admin',
      'usr_banned',
      'ban',
      'Banned by admin',
      null,
      removedAt,
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/members',
      cookies: {
        current_session: 'admin_session',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      items: Array<{ id: string; displayName: string }>;
    };
    expect(payload.items.map((member) => member.id)).toEqual(['usr_admin']);
    expect(payload.items.some((member) => member.displayName === 'Kicked User')).toBe(false);
    expect(payload.items.some((member) => member.displayName === 'Banned User')).toBe(false);

    db.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(rejoinedAt, 'usr_kicked');

    const rejoinedResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/members',
      cookies: {
        current_session: 'admin_session',
      },
    });

    expect(rejoinedResponse.statusCode).toBe(200);
    const rejoinedPayload = rejoinedResponse.json() as {
      items: Array<{ id: string; displayName: string }>;
    };
    expect(rejoinedPayload.items.map((member) => member.id)).toEqual(['usr_admin', 'usr_kicked']);
    expect(rejoinedPayload.items.some((member) => member.displayName === 'Kicked User')).toBe(true);
    expect(rejoinedPayload.items.some((member) => member.displayName === 'Banned User')).toBe(false);

    await close();
  });

  it('blocks kicked sessions until rejoin and keeps banned sessions blocked', async () => {
    const { app, db, close } = await createTestApp();
    const joinedAt = '2026-05-09T01:00:00.000Z';
    const removedAt = '2026-05-09T01:05:00.000Z';
    const rejoinedAt = '2026-05-09T01:10:00.000Z';

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Removal Server',
        slug: 'removal-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);
    const { serverId } = bootstrapResponse.json() as { serverId: string };

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_admin',
      'did:plc:admin',
      'admin.bsky.social',
      'Admin',
      null,
      joinedAt,
      joinedAt,
      'usr_kicked',
      'did:plc:kicked',
      'kicked.bsky.social',
      'Kicked User',
      null,
      joinedAt,
      joinedAt,
      'usr_banned',
      'did:plc:banned',
      'banned.bsky.social',
      'Banned User',
      null,
      joinedAt,
      joinedAt,
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `,
    ).run(
      'kicked_session',
      'usr_kicked',
      addHours(1),
      joinedAt,
      'banned_session',
      'usr_banned',
      addHours(1),
      joinedAt,
    );

    db.prepare(
      `
      INSERT INTO moderation_actions (id, server_id, actor_id, target_user_id, type, reason, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'mod_kick_session',
      serverId,
      'usr_admin',
      'usr_kicked',
      'kick',
      'Too much static',
      null,
      removedAt,
      'mod_ban_session',
      serverId,
      'usr_admin',
      'usr_banned',
      'ban',
      'Kept breaking rules',
      null,
      removedAt,
    );

    const kickedResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: 'kicked_session',
      },
    });
    expect(kickedResponse.statusCode).toBe(403);
    expect(kickedResponse.json()).toEqual({
      error: {
        code: 'SERVER_KICKED',
        message: "You've been kicked",
        reason: 'Too much static',
        type: 'kick',
      },
    });

    const bannedResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: 'banned_session',
      },
    });
    expect(bannedResponse.statusCode).toBe(403);
    expect(bannedResponse.json()).toEqual({
      error: {
        code: 'SERVER_BANNED',
        message: "You've been banned",
        reason: 'Kept breaking rules',
        type: 'ban',
      },
    });

    db.prepare('UPDATE users SET updated_at = ? WHERE id IN (?, ?)').run(
      rejoinedAt,
      'usr_kicked',
      'usr_banned',
    );

    const rejoinedKickResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: 'kicked_session',
      },
    });
    expect(rejoinedKickResponse.statusCode).toBe(200);
    expect((rejoinedKickResponse.json() as { user: { id: string } }).user.id).toBe('usr_kicked');

    const stillBannedResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: 'banned_session',
      },
    });
    expect(stillBannedResponse.statusCode).toBe(403);
    expect(stillBannedResponse.json()).toEqual({
      error: {
        code: 'SERVER_BANNED',
        message: "You've been banned",
        reason: 'Kept breaking rules',
        type: 'ban',
      },
    });

    await close();
  });

  it('broadcasts member list updates when members join, get kicked, or get banned', async () => {
    const { app, context, db, close } = await createTestApp();
    const disconnects: Array<{ userId: string; reason?: string }> = [];
    const originalDisconnectUser = context.gateway.disconnectUser.bind(context.gateway);
    context.gateway.disconnectUser = (userId, reason) => {
      disconnects.push({ userId, reason });
      originalDisconnectUser(userId, reason);
    };

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Roster Events Server',
        slug: 'roster-events-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);
    const { serverId } = bootstrapResponse.json() as { serverId: string };

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        handle: 'roster.mod@current',
        displayName: 'Roster Mod',
      },
    });
    expect(loginResponse.statusCode).toBe(200);
    const loginPayload = loginResponse.json() as { user: { id: string } };
    const setCookie = loginResponse.headers['set-cookie'];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const sessionToken = rawCookie?.match(/current_session=([^;]+)/)?.[1];
    expect(sessionToken).toBeTruthy();
    if (!sessionToken) {
      throw new Error('Expected current_session cookie token');
    }

    db.prepare(
      `
      INSERT INTO roles (id, server_id, name, color, position, permissions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'rol_roster_moderator',
      serverId,
      'Roster Moderator',
      '#f9a8ff',
      60,
      JSON.stringify(['MODERATE_MEMBERS']),
      nowIso(),
    );
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(
      loginPayload.user.id,
      'rol_roster_moderator',
    );

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_roster_kick',
      'did:plc:roster-kick',
      'roster-kick.bsky.social',
      'Roster Kick',
      null,
      nowIso(),
      nowIso(),
      'usr_roster_ban',
      'did:plc:roster-ban',
      'roster-ban.bsky.social',
      'Roster Ban',
      null,
      nowIso(),
      nowIso(),
    );

    const kickResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      cookies: {
        current_session: sessionToken,
      },
      payload: {
        targetUserId: 'usr_roster_kick',
        type: 'kick',
        reason: 'Testing kick roster refresh',
      },
    });
    expect(kickResponse.statusCode).toBe(201);

    const banResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      cookies: {
        current_session: sessionToken,
      },
      payload: {
        targetUserId: 'usr_roster_ban',
        type: 'ban',
        reason: 'Testing ban roster refresh',
      },
    });
    expect(banResponse.statusCode).toBe(201);

    const events = db
      .prepare('SELECT payload FROM gateway_events WHERE type = ? ORDER BY seq ASC')
      .all(GatewayEvents.MEMBER_UPDATE) as Array<{ payload: string }>;
    const payloads = events.map((event) =>
      parseGatewayPayload<{ action: string; userId: string; member?: { handle: string } }>(event.payload),
    );

    expect(payloads).toEqual([
      {
        action: 'join',
        userId: loginPayload.user.id,
        member: expect.objectContaining({ handle: 'roster.mod@current' }),
      },
      expect.objectContaining({
        action: 'kick',
        userId: 'usr_roster_kick',
      }),
      expect.objectContaining({
        action: 'ban',
        userId: 'usr_roster_ban',
      }),
    ]);
    expect(disconnects).toEqual([
      {
        userId: 'usr_roster_kick',
        reason: "You've been kicked: Testing kick roster refresh",
      },
      {
        userId: 'usr_roster_ban',
        reason: "You've been banned: Testing ban roster refresh",
      },
    ]);

    await close();
  });

  it('hides Bluesky identities from members list when LAN mode is enabled', async () => {
    const { app, context, db, close } = await createTestApp();

    const config = context.serverConfig.get();
    context.serverConfig.set({
      ...config,
      auth: {
        ...config.auth,
        mode: 'lan',
      },
    });

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?), (?, ?, ?, ?, NULL, ?, ?), (?, ?, ?, ?, NULL, ?, ?)
    `,
    ).run(
      'usr_lan_1',
      'did:current:lan:a1',
      'lan-one.lan',
      'LAN One',
      nowIso(),
      nowIso(),
      'usr_lan_2',
      'did:current:lan:a2',
      'lan-two.lan',
      'LAN Two',
      nowIso(),
      nowIso(),
      'usr_bsky_1',
      'did:plc:blue1',
      'blue-one.bsky.social',
      'Blue One',
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('lan_members_session', 'usr_lan_1', addHours(1), nowIso());

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/members',
      cookies: {
        current_session: 'lan_members_session',
      },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      items: Array<{ id: string }>;
    };
    expect(payload.items.map((member) => member.id)).toEqual(['usr_lan_1', 'usr_lan_2']);

    await close();
  });
});
