import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

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
      nowIso(),
      nowIso(),
      'usr_kicked',
      'did:plc:kicked',
      'kicked.bsky.social',
      'Kicked User',
      null,
      nowIso(),
      nowIso(),
      'usr_banned',
      'did:plc:banned',
      'banned.bsky.social',
      'Banned User',
      null,
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('admin_session', 'usr_admin', addHours(1), nowIso());

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
      nowIso(),
      'mod_ban',
      serverId,
      'usr_admin',
      'usr_banned',
      'ban',
      'Banned by admin',
      null,
      nowIso(),
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
