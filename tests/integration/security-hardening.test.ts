import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

function sessionTokenFromSetCookie(rawSetCookie: string | string[] | undefined): string {
  const value = Array.isArray(rawSetCookie) ? rawSetCookie[0] : rawSetCookie;
  const sessionToken = value?.match(/current_session=([^;]+)/)?.[1];
  if (!sessionToken) {
    throw new Error('Expected current_session cookie token');
  }
  return sessionToken;
}

async function expectGatewayRejected(input: {
  url: string;
  origin: string;
  sessionToken: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(input.url, {
      headers: {
        Origin: input.origin,
        Cookie: `current_session=${input.sessionToken}`,
      },
    });

    socket.once('open', () => {
      socket.close();
      reject(new Error('Gateway accepted a disallowed origin.'));
    });
    socket.once('unexpected-response', (_request, response) => {
      try {
        expect(response.statusCode).toBe(403);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

async function expectGatewayReady(input: {
  url: string;
  origin: string;
  sessionToken: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(input.url, {
      headers: {
        Origin: input.origin,
        Cookie: `current_session=${input.sessionToken}`,
      },
    });

    socket.once('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as { type?: string };
        expect(payload.type).toBe('READY');
        socket.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

async function expectGatewayReadyWithProtocolSession(input: {
  url: string;
  origin: string;
  sessionToken: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(
      input.url,
      ['current-session', `current-session-token.${Buffer.from(input.sessionToken, 'utf8').toString('base64url')}`],
      {
        headers: {
          Origin: input.origin,
        },
      },
    );

    socket.once('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as { type?: string };
        expect(payload.type).toBe('READY');
        socket.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

async function expectGatewayDoesNotReplayMessage(input: {
  url: string;
  origin: string;
  sessionToken: string;
  messageId: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(input.url, {
      headers: {
        Origin: input.origin,
        Cookie: `current_session=${input.sessionToken}`,
      },
    });
    const timer = setTimeout(() => {
      socket.close();
      resolve();
    }, 250);

    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString()) as {
          type?: string;
          payload?: { message?: { id?: string } };
        };
        if (payload.type === 'MESSAGE_CREATE' && payload.payload?.message?.id === input.messageId) {
          clearTimeout(timer);
          socket.close();
          reject(new Error('Gateway replayed a hidden channel message.'));
        }
      } catch (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
      }
    });
  });
}

describe('security hardening', () => {
  it('blocks disallowed browser origins for credentialed API and gateway traffic', async () => {
    const { app, close } = await createTestApp();

    const health = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: {
        origin: 'https://evil.example',
      },
    });
    expect(health.statusCode).toBe(200);
    expect(health.headers['access-control-allow-origin']).not.toBe('https://evil.example');

    const blockedWrite = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      headers: {
        origin: 'https://evil.example',
      },
      payload: {
        handle: 'origin-blocked@current',
        displayName: 'Origin Blocked',
      },
    });
    expect(blockedWrite.statusCode).toBe(403);
    expect((blockedWrite.json() as { error: { code: string } }).error.code).toBe('ORIGIN_NOT_ALLOWED');

    const allowedWrite = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      headers: {
        host: 'localhost:8080',
        origin: 'http://localhost:8080',
      },
      payload: {
        handle: 'origin-allowed@current',
        displayName: 'Origin Allowed',
      },
    });
    expect(allowedWrite.statusCode).toBe(200);
    const sessionToken = sessionTokenFromSetCookie(allowedWrite.headers['set-cookie']);

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : undefined;
    expect(port).toBeTruthy();
    if (!port) {
      throw new Error('Expected test server port');
    }
    const gatewayUrl = `ws://127.0.0.1:${port}/gateway`;

    await expectGatewayRejected({
      url: gatewayUrl,
      origin: 'https://evil.example',
      sessionToken,
    });
    await expectGatewayReady({
      url: gatewayUrl,
      origin: `http://127.0.0.1:${port}`,
      sessionToken,
    });
    await expectGatewayReadyWithProtocolSession({
      url: gatewayUrl,
      origin: `http://127.0.0.1:${port}`,
      sessionToken,
    });

    await close();
  });

  it('does not append auth exchange tickets to off-origin OAuth return redirects', async () => {
    const { app, context, close } = await createTestApp();
    const originalHandleOAuthCallback = context.auth.handleOAuthCallback;
    const now = nowIso();

    context.auth.handleOAuthCallback = (async () => ({
      user: {
        id: 'usr_redirect',
        did: 'did:plc:redirect',
        handle: 'redirect.bsky.social',
        displayName: 'Redirect User',
        roleIds: [],
        createdAt: now,
      },
      sessionToken: 'redirect_session',
      isNewUser: false,
      returnTo: 'https://evil.example/capture',
    })) as typeof context.auth.handleOAuthCallback;

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/callback?code=test',
      headers: {
        host: 'localhost:8080',
      },
    });

    context.auth.handleOAuthCallback = originalHandleOAuthCallback;

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/');
    expect(response.headers.location).not.toContain('current_auth_ticket');

    await close();
  });

  it('requires the browser claim token before exposing LAN OAuth handoff tickets', async () => {
    const { app, db, close } = await createTestApp();
    const now = Date.now();

    try {
      db.prepare(
        `
        INSERT INTO settings (key, value)
        VALUES (?, ?)
      `,
      ).run(
        'auth:lan_handoff:test-handoff',
        JSON.stringify({
          id: 'test-handoff',
          handle: 'alice.bsky.social',
          returnTo: 'http://lan-client.local/',
          claimToken: 'claim-secret',
          status: 'completed',
          authTicket: 'test-ticket',
          createdAt: now,
          expiresAt: now + 600_000,
        }),
      );

      const wrongStatus = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/lan/handoffs/test-handoff?claimToken=wrong',
      });
      expect(wrongStatus.statusCode).toBe(403);
      expect((wrongStatus.json() as { error: { code: string } }).error.code).toBe('LAN_HANDOFF_TOKEN_MISMATCH');

      const wrongClaim = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/lan/handoffs/test-handoff/claim',
        payload: {
          claimToken: 'wrong',
        },
      });
      expect(wrongClaim.statusCode).toBe(403);
      expect((wrongClaim.json() as { error: { code: string } }).error.code).toBe('LAN_HANDOFF_TOKEN_MISMATCH');

      const readyStatus = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/lan/handoffs/test-handoff?claimToken=claim-secret',
      });
      expect(readyStatus.statusCode).toBe(200);
      expect((readyStatus.json() as { status: string }).status).toBe('ready');

      const claim = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/lan/handoffs/test-handoff/claim',
        payload: {
          claimToken: 'claim-secret',
        },
      });
      expect(claim.statusCode).toBe(200);
      expect((claim.json() as { ticket: string }).ticket).toBe('test-ticket');

      const secondClaim = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/lan/handoffs/test-handoff/claim',
        payload: {
          claimToken: 'claim-secret',
        },
      });
      expect(secondClaim.statusCode).toBe(409);

      const row = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('auth:lan_handoff:test-handoff') as { value: string };
      expect((JSON.parse(row.value) as { status: string }).status).toBe('claimed');
      expect((JSON.parse(row.value) as { authTicket?: string }).authTicket).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('keeps moderation, audit, metrics, and voice diagnostics behind privileged permissions', async () => {
    const { app, db, context, close } = await createTestApp();

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Security Permission Server',
        slug: 'security-permission-server',
        publicUrl: 'http://localhost:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:security-admin',
        adminHandle: 'security-admin.bsky.social',
        adminDisplayName: 'Security Admin',
      },
    });
    expect(setup.statusCode).toBe(201);
    const { serverId } = setup.json() as { serverId: string };

    const admin = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:security-admin') as { id: string };
    const roles = context.moderation.listRoles(serverId);
    const memberRole = roles.find((role) => role.name === 'Member');
    expect(memberRole).toBeTruthy();
    if (!memberRole) {
      throw new Error('Expected member role');
    }

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?)
    `,
    ).run(
      'usr_security_member',
      'did:plc:security-member',
      'security-member.bsky.social',
      'Security Member',
      nowIso(),
      nowIso(),
    );
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run('usr_security_member', memberRole.id);
    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `,
    ).run(
      'security_admin_session',
      admin.id,
      addHours(1),
      nowIso(),
      'security_member_session',
      'usr_security_member',
      addHours(1),
      nowIso(),
    );

    const unauthMetrics = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/metrics',
    });
    expect(unauthMetrics.statusCode).toBe(401);

    for (const url of [
      '/api/v1/moderation/actions',
      '/api/v1/audit/logs',
      '/api/v1/admin/metrics',
      '/api/v1/voice/diagnostics',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        cookies: {
          current_session: 'security_member_session',
        },
      });
      expect(response.statusCode).toBe(403);
    }

    const adminMetrics = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/metrics',
      cookies: {
        current_session: 'security_admin_session',
      },
    });
    expect(adminMetrics.statusCode).toBe(200);

    await close();
  });

  it('rejects stale object IDs that belong to another server row', async () => {
    const { app, db, close } = await createTestApp();

    try {
      const setup = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/bootstrap',
        payload: {
          serverName: 'Security Isolation Server',
          slug: 'security-isolation-server',
          publicUrl: 'http://localhost:8080',
          registrationMode: 'invite_only',
          adminDid: 'did:plc:isolation-admin',
          adminHandle: 'isolation-admin.bsky.social',
          adminDisplayName: 'Isolation Admin',
        },
      });
      expect(setup.statusCode).toBe(201);
      const { serverId } = setup.json() as { serverId: string };
      expect(serverId).toBeTruthy();

      const admin = db
        .prepare('SELECT id FROM users WHERE did = ?')
        .get('did:plc:isolation-admin') as { id: string };
      const createdAt = nowIso();

      db.prepare(
        `
        INSERT INTO sessions (token, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `,
      ).run('isolation_admin_session', admin.id, addHours(1), createdAt);

      db.prepare(
        `
        INSERT INTO servers (id, name, slug, registration_mode, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      ).run('srv_foreign', 'Foreign Server', 'foreign-server', 'invite_only', createdAt);

      db.prepare(
        `
        INSERT INTO channels (
          id, server_id, category_id, name, type, topic, slowmode_seconds, locked, position, created_at
        )
        VALUES (?, ?, NULL, ?, ?, NULL, 0, 0, 1000, ?)
      `,
      ).run('chn_foreign', 'srv_foreign', 'foreign-chat', 'text', createdAt);

      db.prepare(
        `
        INSERT INTO messages (
          id, channel_id, author_id, content, encrypted_content, parent_message_id, gif_url, created_at
        )
        VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)
      `,
      ).run('msg_foreign', 'chn_foreign', admin.id, 'foreign secret', createdAt);

      db.prepare(
        `
        INSERT INTO roles (id, server_id, name, color, position, permissions, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run('rol_foreign', 'srv_foreign', 'Foreign Role', '#ffffff', 1, '["MANAGE_SERVER"]', createdAt);

      db.prepare(
        `
        INSERT INTO automod_rules (id, server_id, name, type, enabled, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        'amr_foreign',
        'srv_foreign',
        'Foreign Automod',
        'keyword',
        1,
        '{"words":["secret"]}',
        createdAt,
        createdAt,
      );

      db.prepare(
        `
        INSERT INTO invites (code, server_id, channel_id, max_uses, used_count, expires_at, created_by, created_at, revoked)
        VALUES (?, ?, ?, NULL, 0, NULL, ?, ?, 0)
      `,
      ).run('foreign-invite', 'srv_foreign', 'chn_foreign', admin.id, createdAt);

      const cookies = {
        current_session: 'isolation_admin_session',
      };

      const messageList = await app.inject({
        method: 'GET',
        url: '/api/v1/channels/chn_foreign/messages',
        cookies,
      });
      expect(messageList.statusCode).toBe(404);

      const messageSearch = await app.inject({
        method: 'GET',
        url: '/api/v1/channels/chn_foreign/messages/search?q=foreign',
        cookies,
      });
      expect(messageSearch.statusCode).toBe(404);

      const createMessage = await app.inject({
        method: 'POST',
        url: '/api/v1/channels/chn_foreign/messages',
        cookies,
        payload: {
          content: 'cross-server write attempt',
        },
      });
      expect(createMessage.statusCode).toBe(404);

      const moderateChannel = await app.inject({
        method: 'PATCH',
        url: '/api/v1/channels/chn_foreign/moderation',
        cookies,
        payload: {
          locked: true,
        },
      });
      expect(moderateChannel.statusCode).toBe(404);

      const deleteChannel = await app.inject({
        method: 'DELETE',
        url: '/api/v1/channels/chn_foreign',
        cookies,
      });
      expect(deleteChannel.statusCode).toBe(404);
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM channels WHERE id = ?').get('chn_foreign') as { count: number })
          .count,
      ).toBe(1);
      expect((db.prepare('SELECT locked FROM channels WHERE id = ?').get('chn_foreign') as { locked: number }).locked)
        .toBe(0);

      const patchRole = await app.inject({
        method: 'PATCH',
        url: '/api/v1/roles/rol_foreign',
        cookies,
        payload: {
          name: 'Stolen Role',
        },
      });
      expect(patchRole.statusCode).toBe(404);

      const deleteRole = await app.inject({
        method: 'DELETE',
        url: '/api/v1/roles/rol_foreign',
        cookies,
      });
      expect(deleteRole.statusCode).toBe(404);
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM roles WHERE id = ?').get('rol_foreign') as { count: number }).count,
      ).toBe(1);

      const patchAutomod = await app.inject({
        method: 'PATCH',
        url: '/api/v1/automod/rules/amr_foreign',
        cookies,
        payload: {
          name: 'Stolen Automod',
        },
      });
      expect(patchAutomod.statusCode).toBe(404);

      const deleteAutomod = await app.inject({
        method: 'DELETE',
        url: '/api/v1/automod/rules/amr_foreign',
        cookies,
      });
      expect(deleteAutomod.statusCode).toBe(404);
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM automod_rules WHERE id = ?').get('amr_foreign') as { count: number })
          .count,
      ).toBe(1);

      const createInvite = await app.inject({
        method: 'POST',
        url: '/api/v1/invites',
        cookies,
        payload: {
          channelId: 'chn_foreign',
        },
      });
      expect(createInvite.statusCode).toBe(400);

      const revokeInvite = await app.inject({
        method: 'DELETE',
        url: '/api/v1/invites/foreign-invite',
        cookies,
      });
      expect(revokeInvite.statusCode).toBe(404);
      expect((db.prepare('SELECT revoked FROM invites WHERE code = ?').get('foreign-invite') as { revoked: number }).revoked)
        .toBe(0);
    } finally {
      await close();
    }
  });

  it('keeps pending attachment uploads bound to the uploading user and channel permission', async () => {
    const { app, db, context, close } = await createTestApp();

    try {
      const setup = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/bootstrap',
        payload: {
          serverName: 'Attachment Isolation Server',
          slug: 'attachment-isolation-server',
          publicUrl: 'http://localhost:8080',
          registrationMode: 'invite_only',
          adminDid: 'did:plc:attachment-admin',
          adminHandle: 'attachment-admin.bsky.social',
          adminDisplayName: 'Attachment Admin',
        },
      });
      expect(setup.statusCode).toBe(201);
      const { serverId, defaultChannelId } = setup.json() as { serverId: string; defaultChannelId: string };

      const admin = db
        .prepare('SELECT id FROM users WHERE did = ?')
        .get('did:plc:attachment-admin') as { id: string };
      const memberRole = db
        .prepare("SELECT id FROM roles WHERE server_id = ? AND name = 'Member'")
        .get(serverId) as { id: string };

      db.prepare(
        `
        INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
      `,
      ).run(
        'usr_attachment_other',
        'did:plc:attachment-other',
        'attachment-other.bsky.social',
        'Attachment Other',
        nowIso(),
        nowIso(),
      );
      db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(
        'usr_attachment_other',
        memberRole.id,
      );
      db.prepare(
        `
        INSERT INTO sessions (token, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
      `,
      ).run(
        'attachment_owner_session',
        admin.id,
        addHours(1),
        nowIso(),
        'attachment_other_session',
        'usr_attachment_other',
        addHours(1),
        nowIso(),
      );

      const pending = context.chat.saveAttachment({
        fileName: 'draft.png',
        mimeType: 'image/png',
        bytes: Buffer.from('draft-image'),
        ownerUserId: admin.id,
      });

      const ownerRead = await app.inject({
        method: 'GET',
        url: `/api/v1/media/attachments/${pending.id}`,
        cookies: {
          current_session: 'attachment_owner_session',
        },
      });
      expect(ownerRead.statusCode).toBe(200);
      expect(ownerRead.headers['x-content-type-options']).toBe('nosniff');
      expect(ownerRead.headers['content-security-policy']).toContain("script-src 'none'");

      const otherRead = await app.inject({
        method: 'GET',
        url: `/api/v1/media/attachments/${pending.id}`,
        cookies: {
          current_session: 'attachment_other_session',
        },
      });
      expect(otherRead.statusCode).toBe(404);

      const otherClaim = await app.inject({
        method: 'POST',
        url: `/api/v1/channels/${defaultChannelId}/messages`,
        cookies: {
          current_session: 'attachment_other_session',
        },
        payload: {
          content: 'claim someone else upload',
          attachmentIds: [pending.id],
        },
      });
      expect(otherClaim.statusCode).toBe(409);
      expect((otherClaim.json() as { error: { reasons?: string[] } }).error.reasons).toContain('invalid_attachment');

      db.prepare(
        `
        INSERT INTO channel_overwrites (id, channel_id, target_type, target_id, allow_permissions, deny_permissions)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      ).run('ovr_attachment_deny', defaultChannelId, 'role', memberRole.id, '[]', '["ATTACH_FILES"]');

      const deniedUpload = await app.inject({
        method: 'POST',
        url: `/api/v1/media/attachments?channelId=${encodeURIComponent(defaultChannelId)}`,
        cookies: {
          current_session: 'attachment_other_session',
        },
      });
      expect(deniedUpload.statusCode).toBe(403);
    } finally {
      await close();
    }
  });

  it('keeps hidden channel messages and attachments out of member reads and gateway replay', async () => {
    const { app, db, context, close } = await createTestApp();

    try {
      const setup = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/bootstrap',
        payload: {
          serverName: 'Hidden Channel Server',
          slug: 'hidden-channel-server',
          publicUrl: 'http://localhost:8080',
          registrationMode: 'invite_only',
          adminDid: 'did:plc:hidden-admin',
          adminHandle: 'hidden-admin.bsky.social',
          adminDisplayName: 'Hidden Admin',
        },
      });
      expect(setup.statusCode).toBe(201);
      const { serverId } = setup.json() as { serverId: string };

      const admin = db
        .prepare('SELECT id FROM users WHERE did = ?')
        .get('did:plc:hidden-admin') as { id: string };
      const memberRole = db
        .prepare("SELECT id FROM roles WHERE server_id = ? AND name = 'Member'")
        .get(serverId) as { id: string };

      db.prepare(
        `
        INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
      `,
      ).run(
        'usr_hidden_member',
        'did:plc:hidden-member',
        'hidden-member.bsky.social',
        'Hidden Member',
        nowIso(),
        nowIso(),
      );
      db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(
        'usr_hidden_member',
        memberRole.id,
      );
      db.prepare(
        `
        INSERT INTO sessions (token, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?)
      `,
      ).run(
        'hidden_admin_session',
        admin.id,
        addHours(1),
        nowIso(),
        'hidden_member_session',
        'usr_hidden_member',
        addHours(1),
        nowIso(),
      );

      const hiddenChannel = context.chat.createChannel({
        serverId,
        name: 'staff-secrets',
        type: 'text',
        actorId: admin.id,
      });
      db.prepare(
        `
        INSERT INTO channel_overwrites (id, channel_id, target_type, target_id, allow_permissions, deny_permissions)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      ).run('ovr_hidden_view', hiddenChannel.id, 'role', memberRole.id, '[]', '["VIEW_CHANNEL"]');

      const secretAttachment = context.chat.saveAttachment({
        fileName: 'secret.png',
        mimeType: 'image/png',
        bytes: Buffer.from('secret-image'),
        ownerUserId: admin.id,
      });
      const lastEventSeq = context.repos.gatewayEvents.latestSeq();
      const hiddenMessageResponse = await app.inject({
        method: 'POST',
        url: `/api/v1/channels/${hiddenChannel.id}/messages`,
        cookies: {
          current_session: 'hidden_admin_session',
        },
        payload: {
          content: 'private staff note',
          attachmentIds: [secretAttachment.id],
        },
      });
      expect(hiddenMessageResponse.statusCode).toBe(201);
      const hiddenMessage = hiddenMessageResponse.json() as { id: string };

      const channels = await app.inject({
        method: 'GET',
        url: '/api/v1/channels',
        cookies: {
          current_session: 'hidden_member_session',
        },
      });
      expect(channels.statusCode).toBe(200);
      expect((channels.json() as { items: Array<{ id: string }> }).items.map((channel) => channel.id))
        .not.toContain(hiddenChannel.id);

      const history = await app.inject({
        method: 'GET',
        url: `/api/v1/channels/${hiddenChannel.id}/messages`,
        cookies: {
          current_session: 'hidden_member_session',
        },
      });
      expect(history.statusCode).toBe(404);

      const channelSearch = await app.inject({
        method: 'GET',
        url: `/api/v1/channels/${hiddenChannel.id}/messages/search?q=private`,
        cookies: {
          current_session: 'hidden_member_session',
        },
      });
      expect(channelSearch.statusCode).toBe(404);

      const serverSearch = await app.inject({
        method: 'GET',
        url: '/api/v1/messages/search?q=private',
        cookies: {
          current_session: 'hidden_member_session',
        },
      });
      expect(serverSearch.statusCode).toBe(200);
      expect((serverSearch.json() as { items: Array<{ id: string }> }).items.map((message) => message.id))
        .not.toContain(hiddenMessage.id);

      const directMessage = await app.inject({
        method: 'GET',
        url: `/api/v1/messages/${hiddenMessage.id}`,
        cookies: {
          current_session: 'hidden_member_session',
        },
      });
      expect(directMessage.statusCode).toBe(404);

      const hiddenAttachment = await app.inject({
        method: 'GET',
        url: `/api/v1/media/attachments/${secretAttachment.id}`,
        cookies: {
          current_session: 'hidden_member_session',
        },
      });
      expect(hiddenAttachment.statusCode).toBe(404);

      const hiddenReaction = await app.inject({
        method: 'POST',
        url: `/api/v1/messages/${hiddenMessage.id}/reactions`,
        cookies: {
          current_session: 'hidden_member_session',
        },
        payload: {
          emoji: 'lock',
        },
      });
      expect(hiddenReaction.statusCode).toBe(404);

      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      expect(port).toBeTruthy();
      if (!port) {
        throw new Error('Expected test server port');
      }
      await expectGatewayDoesNotReplayMessage({
        url: `ws://127.0.0.1:${port}/gateway?lastEventSeq=${lastEventSeq}`,
        origin: `http://127.0.0.1:${port}`,
        sessionToken: 'hidden_member_session',
        messageId: hiddenMessage.id,
      });
    } finally {
      await close();
    }
  });
});
