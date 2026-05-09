import { describe, expect, it } from 'vitest';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';
import { createTestApp } from '../helpers/test-app.js';

describe('channel delete cascade', () => {
  it('deletes dependent records before deleting a channel', async () => {
    const { app, db, close } = await createTestApp();

    const setupResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Cascade Integration',
        slug: 'cascade-integration',
        publicUrl: 'http://localhost:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:cascade',
        adminHandle: 'cascade.bsky.social',
        adminDisplayName: 'Cascade Admin',
      },
    });

    expect(setupResponse.statusCode).toBe(201);

    const user = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:cascade') as { id: string };

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('cascade_session', user.id, addHours(1), nowIso());

    const channelsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: 'cascade_session',
      },
    });

    expect(channelsResponse.statusCode).toBe(200);
    const channels = channelsResponse.json() as {
      items: Array<{ id: string; type: 'text' | 'voice' | 'dm' }>;
    };
    const textChannel = channels.items.find((channel) => channel.type === 'text');
    const voiceChannel = channels.items.find((channel) => channel.type === 'voice');

    expect(textChannel?.id).toBeDefined();
    expect(voiceChannel?.id).toBeDefined();

    const messageResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${textChannel?.id}/messages`,
      cookies: {
        current_session: 'cascade_session',
      },
      payload: {
        content: 'message that should be removed by channel deletion',
      },
    });

    expect(messageResponse.statusCode).toBe(201);
    const message = messageResponse.json() as { id: string };

    const reactionResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/messages/${message.id}/reactions`,
      cookies: {
        current_session: 'cascade_session',
      },
      payload: {
        emoji: '🔥',
      },
    });

    expect(reactionResponse.statusCode).toBe(200);
    expect((reactionResponse.json() as { reactions?: Array<{ emoji: string; count: number }> }).reactions?.[0])
      .toMatchObject({
        emoji: '🔥',
        count: 1,
      });

    db.prepare(
      `
      INSERT INTO attachments (id, message_id, file_name, mime_type, byte_size, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'att_cascade',
      message.id,
      'test.txt',
      'text/plain',
      4,
      '/tmp/test.txt',
      nowIso(),
    );

    const voiceJoinResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/channels/${voiceChannel?.id}/join`,
      cookies: {
        current_session: 'cascade_session',
      },
      payload: {
        muted: false,
      },
    });
    expect(voiceJoinResponse.statusCode).toBe(200);

    const deleteTextChannelResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/channels/${textChannel?.id}`,
      cookies: {
        current_session: 'cascade_session',
      },
    });
    expect(deleteTextChannelResponse.statusCode).toBe(204);

    const remainingMessages = db
      .prepare('SELECT COUNT(*) as count FROM messages WHERE channel_id = ?')
      .get(textChannel?.id) as { count: number };
    expect(remainingMessages.count).toBe(0);

    const remainingAttachments = db
      .prepare('SELECT COUNT(*) as count FROM attachments WHERE message_id = ?')
      .get(message.id) as { count: number };
    expect(remainingAttachments.count).toBe(0);

    const remainingReactions = db
      .prepare('SELECT COUNT(*) as count FROM reactions WHERE message_id = ?')
      .get(message.id) as { count: number };
    expect(remainingReactions.count).toBe(0);

    const deleteVoiceChannelResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/channels/${voiceChannel?.id}`,
      cookies: {
        current_session: 'cascade_session',
      },
    });
    expect(deleteVoiceChannelResponse.statusCode).toBe(204);

    const remainingVoiceStates = db
      .prepare('SELECT COUNT(*) as count FROM voice_states WHERE channel_id = ?')
      .get(voiceChannel?.id) as { count: number };
    expect(remainingVoiceStates.count).toBe(0);

    await close();
  });
});
