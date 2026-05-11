import { describe, expect, it } from 'vitest';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';
import { createTestApp } from '../helpers/test-app.js';

describe('chat message integration', () => {
  it('boots setup and posts a message', async () => {
    const { app, db, context, close } = await createTestApp();

    const setupResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Integration',
        slug: 'integration',
        publicUrl: 'http://localhost:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:integration',
        adminHandle: 'integration.bsky.social',
        adminDisplayName: 'Integration Admin',
      },
    });

    expect(setupResponse.statusCode).toBe(201);

    const user = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:integration') as { id: string };

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('integration_session', user.id, addHours(1), nowIso());

    const channelsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: 'integration_session',
      },
    });

    expect(channelsResponse.statusCode).toBe(200);
    const channels = channelsResponse.json() as {
      items: Array<{ id: string; type: string }>;
    };
    const textChannel = channels.items.find((channel) => channel.type === 'text');
    expect(textChannel?.id).toBeDefined();

    const messageResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${textChannel?.id}/messages`,
      cookies: {
        current_session: 'integration_session',
      },
      payload: {
        content: 'hello integration world',
      },
    });

    expect(messageResponse.statusCode).toBe(201);
    const firstMessage = messageResponse.json() as { id: string; content: string };

    const reactionResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${firstMessage.id}/reactions`,
      cookies: {
        current_session: 'integration_session',
      },
      payload: {
        emoji: '❤️',
      },
    });

    expect(reactionResponse.statusCode).toBe(200);
    const reactedMessage = reactionResponse.json() as {
      id: string;
      reactions?: Array<{ emoji: string; count: number; userIds: string[] }>;
    };
    expect(reactedMessage.reactions).toEqual([
      {
        emoji: '❤️',
        count: 1,
        userIds: [user.id],
      },
    ]);

    const replyResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${textChannel?.id}/messages`,
      cookies: {
        current_session: 'integration_session',
      },
      payload: {
        content: 'replying to integration world',
        parentMessageId: firstMessage.id,
      },
    });

    expect(replyResponse.statusCode).toBe(201);
    const replyMessage = replyResponse.json() as { id: string; parentMessageId?: string };
    expect(replyMessage.parentMessageId).toBe(firstMessage.id);

    const replyLookupResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/messages/${replyMessage.id}`,
      cookies: {
        current_session: 'integration_session',
      },
    });

    expect(replyLookupResponse.statusCode).toBe(200);
    expect((replyLookupResponse.json() as { parentMessageId?: string }).parentMessageId).toBe(firstMessage.id);

    const invalidReplyResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${textChannel?.id}/messages`,
      cookies: {
        current_session: 'integration_session',
      },
      payload: {
        content: 'bad parent',
        parentMessageId: 'msg_missing',
      },
    });

    expect(invalidReplyResponse.statusCode).toBe(409);

    const maliciousAttachmentResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${textChannel?.id}/messages`,
      cookies: {
        current_session: 'integration_session',
      },
      payload: {
        content: 'host file please',
        attachmentIds: ['/etc/passwd'],
      },
    });
    expect(maliciousAttachmentResponse.statusCode).toBe(409);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE path = ?').get('/etc/passwd'),
    ).toEqual({ count: 0 });

    const uploaded = context.chat.saveAttachment({
      fileName: 'safe-image.png',
      mimeType: 'image/png',
      bytes: Buffer.from('fake-png'),
      ownerUserId: user.id,
    });
    expect(() =>
      context.chat.saveAttachment({
        fileName: 'script.svg',
        mimeType: 'image/svg+xml',
        bytes: Buffer.from('<svg><script>alert(1)</script></svg>'),
      }),
    ).toThrow('Attachment MIME type is not safe to serve.');
    const attachmentMessageResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${textChannel?.id}/messages`,
      cookies: {
        current_session: 'integration_session',
      },
      payload: {
        content: 'safe attachment',
        attachmentIds: [uploaded.id],
      },
    });
    expect(attachmentMessageResponse.statusCode).toBe(201);
    expect(
      (attachmentMessageResponse.json() as { attachments?: Array<{ id: string; path: string }> }).attachments,
    ).toEqual([expect.objectContaining({ id: uploaded.id, path: uploaded.path })]);

    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/channels/${textChannel?.id}/messages`,
      cookies: {
        current_session: 'integration_session',
      },
    });

    expect(messagesResponse.statusCode).toBe(200);
    const messages = messagesResponse.json() as {
      items: Array<{ content: string; reactions?: Array<{ emoji: string; count: number }> }>;
    };
    expect(messages.items.some((msg) => msg.content === 'hello integration world')).toBe(true);
    expect(
      messages.items.find((msg) => msg.content === 'hello integration world')?.reactions?.[0],
    ).toMatchObject({
      emoji: '❤️',
      count: 1,
    });

    const messageIdSearchResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/messages/search?q=${encodeURIComponent(firstMessage.id)}&limit=5`,
      cookies: {
        current_session: 'integration_session',
      },
    });

    expect(messageIdSearchResponse.statusCode).toBe(200);
    expect(
      (messageIdSearchResponse.json() as { items: Array<{ id: string }> }).items.map((item) => item.id),
    ).toContain(firstMessage.id);

    const reactionToggleResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${firstMessage.id}/reactions`,
      cookies: {
        current_session: 'integration_session',
      },
      payload: {
        emoji: '❤️',
      },
    });

    expect(reactionToggleResponse.statusCode).toBe(200);
    expect((reactionToggleResponse.json() as { reactions?: unknown[] }).reactions).toEqual([]);

    await close();
  });

  it('keeps author profiles on messages after the author is kicked or banned', async () => {
    const { app, db, close } = await createTestApp();

    const setupResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Author Profiles',
        slug: 'author-profiles',
        publicUrl: 'http://localhost:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:author-admin',
        adminHandle: 'author-admin.bsky.social',
        adminDisplayName: 'Author Admin',
      },
    });

    expect(setupResponse.statusCode).toBe(201);
    const setup = setupResponse.json() as { serverId: string; defaultChannelId: string };
    const admin = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:author-admin') as { id: string };
    const memberRole = db
      .prepare('SELECT id FROM roles WHERE server_id = ? AND name = ?')
      .get(setup.serverId, 'Member') as { id: string } | undefined;
    expect(memberRole?.id).toBeTruthy();

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_kicked_author',
      'did:plc:kicked-author',
      'kicked-author.bsky.social',
      'Kicked Author',
      'https://example.com/kicked.png',
      nowIso(),
      nowIso(),
      'usr_banned_author',
      'did:plc:banned-author',
      'banned-author.bsky.social',
      'Banned Author',
      'https://example.com/banned.png',
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO user_roles (user_id, role_id)
      VALUES (?, ?), (?, ?)
    `,
    ).run(
      'usr_kicked_author',
      memberRole!.id,
      'usr_banned_author',
      memberRole!.id,
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)
    `,
    ).run(
      'author_admin_session',
      admin.id,
      addHours(1),
      nowIso(),
      'kicked_author_session',
      'usr_kicked_author',
      addHours(1),
      nowIso(),
      'banned_author_session',
      'usr_banned_author',
      addHours(1),
      nowIso(),
    );

    const kickedMessageResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${setup.defaultChannelId}/messages`,
      cookies: {
        current_session: 'kicked_author_session',
      },
      payload: {
        content: 'message from kicked author',
      },
    });
    expect(kickedMessageResponse.statusCode).toBe(201);

    const bannedMessageResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${setup.defaultChannelId}/messages`,
      cookies: {
        current_session: 'banned_author_session',
      },
      payload: {
        content: 'message from banned author',
      },
    });
    expect(bannedMessageResponse.statusCode).toBe(201);

    const kickResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      cookies: {
        current_session: 'author_admin_session',
      },
      payload: {
        targetUserId: 'usr_kicked_author',
        type: 'kick',
        reason: 'Regression test kick',
      },
    });
    expect(kickResponse.statusCode).toBe(201);

    const banResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      cookies: {
        current_session: 'author_admin_session',
      },
      payload: {
        targetUserId: 'usr_banned_author',
        type: 'ban',
        reason: 'Regression test ban',
      },
    });
    expect(banResponse.statusCode).toBe(201);

    const membersResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/members',
      cookies: {
        current_session: 'author_admin_session',
      },
    });
    expect(membersResponse.statusCode).toBe(200);
    const members = membersResponse.json() as { items: Array<{ id: string }> };
    expect(members.items.map((member) => member.id)).not.toContain('usr_kicked_author');
    expect(members.items.map((member) => member.id)).not.toContain('usr_banned_author');

    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/channels/${setup.defaultChannelId}/messages`,
      cookies: {
        current_session: 'author_admin_session',
      },
    });
    expect(messagesResponse.statusCode).toBe(200);
    const messages = messagesResponse.json() as {
      items: Array<{
        content: string;
        author?: {
          id: string;
          handle: string;
          displayName: string;
          avatarUrl?: string;
        };
      }>;
    };
    expect(messages.items.find((message) => message.content === 'message from kicked author')?.author).toMatchObject({
      id: 'usr_kicked_author',
      handle: 'kicked-author.bsky.social',
      displayName: 'Kicked Author',
      avatarUrl: 'https://example.com/kicked.png',
    });
    expect(messages.items.find((message) => message.content === 'message from banned author')?.author).toMatchObject({
      id: 'usr_banned_author',
      handle: 'banned-author.bsky.social',
      displayName: 'Banned Author',
      avatarUrl: 'https://example.com/banned.png',
    });

    await close();
  });
});
