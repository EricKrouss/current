import { describe, expect, it } from 'vitest';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';
import { createTestApp } from '../helpers/test-app.js';

describe('chat message integration', () => {
  it('boots setup and posts a message', async () => {
    const { app, db, close } = await createTestApp();

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
});
