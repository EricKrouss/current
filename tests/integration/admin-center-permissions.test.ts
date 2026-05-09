import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

function insertUser(db: Awaited<ReturnType<typeof createTestApp>>['db'], input: {
  id: string;
  did: string;
  handle: string;
  displayName: string;
  session: string;
}) {
  db.prepare(
    `
    INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
  `,
  ).run(input.id, input.did, input.handle, input.displayName, nowIso(), nowIso());

  db.prepare(
    `
    INSERT INTO sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(input.session, input.id, addHours(1), nowIso());
}

describe('discord-style admin center permissions', () => {
  it('manages member roles, channel overwrites, and runtime channel permissions', async () => {
    const { app, db, context, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Permission Server',
        slug: 'permission-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);
    const { serverId } = bootstrapResponse.json() as { serverId: string };

    insertUser(db, {
      id: 'usr_admin',
      did: 'did:plc:admin',
      handle: 'admin.bsky.social',
      displayName: 'Admin User',
      session: 'admin_session',
    });
    insertUser(db, {
      id: 'usr_member',
      did: 'did:plc:member',
      handle: 'member.bsky.social',
      displayName: 'Member User',
      session: 'member_session',
    });

    const roles = context.moderation.listRoles(serverId);
    const adminRole = roles.find((role) => role.name === 'Admin')!;
    const memberRole = roles.find((role) => role.name === 'Member')!;
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?), (?, ?)').run(
      'usr_admin',
      adminRole.id,
      'usr_member',
      memberRole.id,
    );
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('owner_user_id', 'usr_admin');

    const channels = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: { current_session: 'admin_session' },
    });
    const general = (channels.json() as { items: Array<{ id: string; name: string }> }).items.find(
      (channel) => channel.name === 'general',
    )!;

    const selfLockout = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/members/usr_admin/roles',
      cookies: { current_session: 'admin_session' },
      payload: {
        roleIds: [memberRole.id],
      },
    });
    expect(selfLockout.statusCode).toBe(400);

    const assignRoles = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/members/usr_member/roles',
      cookies: { current_session: 'admin_session' },
      payload: {
        roleIds: [memberRole.id],
      },
    });
    expect(assignRoles.statusCode).toBe(200);
    expect((assignRoles.json() as { roleIds: string[] }).roleIds).toEqual([memberRole.id]);

    const denySend = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/channels/${general.id}/overwrites`,
      cookies: { current_session: 'admin_session' },
      payload: {
        overwrites: [
          {
            targetType: 'role',
            targetId: memberRole.id,
            allow: [],
            deny: ['SEND_MESSAGES'],
          },
        ],
      },
    });
    expect(denySend.statusCode).toBe(200);

    const blockedMessage = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${general.id}/messages`,
      cookies: { current_session: 'member_session' },
      payload: {
        content: 'blocked',
      },
    });
    expect(blockedMessage.statusCode).toBe(403);

    const allowSendDenyFiles = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/channels/${general.id}/overwrites`,
      cookies: { current_session: 'admin_session' },
      payload: {
        overwrites: [
          {
            targetType: 'role',
            targetId: memberRole.id,
            allow: ['SEND_MESSAGES'],
            deny: ['ATTACH_FILES', 'USE_GIFS'],
          },
        ],
      },
    });
    expect(allowSendDenyFiles.statusCode).toBe(200);

    const allowedMessage = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${general.id}/messages`,
      cookies: { current_session: 'member_session' },
      payload: {
        content: 'allowed',
      },
    });
    expect(allowedMessage.statusCode).toBe(201);

    const blockedAttachment = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${general.id}/messages`,
      cookies: { current_session: 'member_session' },
      payload: {
        content: '',
        attachmentIds: ['att_fake'],
      },
    });
    expect(blockedAttachment.statusCode).toBe(403);

    const blockedGif = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${general.id}/messages`,
      cookies: { current_session: 'member_session' },
      payload: {
        gifUrl: 'https://example.com/test.gif',
      },
    });
    expect(blockedGif.statusCode).toBe(403);

    const adminMessage = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${general.id}/messages`,
      cookies: { current_session: 'admin_session' },
      payload: {
        content: 'admin message',
      },
    });
    const message = adminMessage.json() as { id: string };

    const blockedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/messages/${message.id}`,
      cookies: { current_session: 'member_session' },
    });
    expect(blockedDelete.statusCode).toBe(403);

    await close();
  });
});
