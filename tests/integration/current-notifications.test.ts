import { describe, expect, it } from 'vitest';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';
import { createTestApp } from '../helpers/test-app.js';

describe('current notification feed', () => {
  it('persists mention and reply notifications for launcher catch-up', async () => {
    const { app, db, close } = await createTestApp();

    const setupResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Notification Server',
        slug: 'notification-server',
        publicUrl: 'http://localhost:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:notification-admin',
        adminHandle: 'notification-admin.bsky.social',
        adminDisplayName: 'Notification Admin',
      },
    });
    expect(setupResponse.statusCode).toBe(201);
    const setup = setupResponse.json() as { serverId: string; defaultChannelId: string };

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
      'usr_notification_author',
      'did:plc:notification-author',
      'notification-author.bsky.social',
      'Notification Author',
      null,
      nowIso(),
      nowIso(),
      'usr_notification_target',
      'did:plc:notification-target',
      'notification-target.bsky.social',
      'Notification Target',
      'https://example.com/target.png',
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO user_roles (user_id, role_id)
      VALUES (?, ?), (?, ?)
    `,
    ).run(
      'usr_notification_author',
      memberRole!.id,
      'usr_notification_target',
      memberRole!.id,
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `,
    ).run(
      'notification_author_session',
      'usr_notification_author',
      addHours(1),
      nowIso(),
      'notification_target_session',
      'usr_notification_target',
      addHours(1),
      nowIso(),
    );

    const mentionResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${setup.defaultChannelId}/messages`,
      cookies: {
        current_session: 'notification_author_session',
      },
      payload: {
        content: 'hello @notification-target.bsky.social',
        notificationMentions: ['notification-target.bsky.social'],
      },
    });
    expect(mentionResponse.statusCode).toBe(201);

    const firstFeedResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/current?afterSeq=0&limit=10',
      cookies: {
        current_session: 'notification_target_session',
      },
    });
    expect(firstFeedResponse.statusCode).toBe(200);
    const firstFeed = firstFeedResponse.json() as {
      items: Array<{
        seq: number;
        kind: string;
        message: { content: string; authorId: string };
        notification?: { mentionHandles?: string[]; replyToUserId?: string };
      }>;
      pageInfo: { latestSeq: number; hasMore: boolean };
    };
    expect(firstFeed.items).toHaveLength(1);
    expect(firstFeed.items[0]).toMatchObject({
      kind: 'current_mention',
      message: {
        content: 'hello @notification-target.bsky.social',
        authorId: 'usr_notification_author',
      },
    });
    expect(firstFeed.items[0].notification?.mentionHandles).toEqual(['notification-target.bsky.social']);
    expect(firstFeed.pageInfo.hasMore).toBe(false);

    const targetMessageResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${setup.defaultChannelId}/messages`,
      cookies: {
        current_session: 'notification_target_session',
      },
      payload: {
        content: 'a message worth replying to',
      },
    });
    expect(targetMessageResponse.statusCode).toBe(201);
    const targetMessage = targetMessageResponse.json() as { id: string };

    const replyResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${setup.defaultChannelId}/messages`,
      cookies: {
        current_session: 'notification_author_session',
      },
      payload: {
        content: 'replying while you were offline',
        parentMessageId: targetMessage.id,
      },
    });
    expect(replyResponse.statusCode).toBe(201);

    const catchUpResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/notifications/current?afterSeq=${firstFeed.items[0].seq}&limit=10`,
      cookies: {
        current_session: 'notification_target_session',
      },
    });
    expect(catchUpResponse.statusCode).toBe(200);
    const catchUpFeed = catchUpResponse.json() as {
      items: Array<{
        kind: string;
        message: { content: string };
        notification?: { replyToUserId?: string };
      }>;
      pageInfo: { latestSeq: number };
    };
    expect(catchUpFeed.items).toHaveLength(1);
    expect(catchUpFeed.items[0]).toMatchObject({
      kind: 'current_reply',
      message: {
        content: 'replying while you were offline',
      },
      notification: {
        replyToUserId: 'usr_notification_target',
      },
    });

    const authorFeedResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/current?afterSeq=0&limit=10',
      cookies: {
        current_session: 'notification_author_session',
      },
    });
    expect(authorFeedResponse.statusCode).toBe(200);
    expect((authorFeedResponse.json() as { items: unknown[] }).items).toEqual([]);

    await close();
  });
});
