import { describe, expect, it } from 'vitest';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';
import { createTestApp } from '../helpers/test-app.js';

describe('pagination integration', () => {
  it('supports cursor pagination for channels, members, and messages', async () => {
    const { app, db, close } = await createTestApp();

    const setupResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Pagination Server',
        slug: 'pagination-server',
        publicUrl: 'http://localhost:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:pagination-admin',
        adminHandle: 'pagination-admin.bsky.social',
        adminDisplayName: 'Pagination Admin',
      },
    });
    expect(setupResponse.statusCode).toBe(201);
    const { serverId } = setupResponse.json() as { serverId: string };

    const admin = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:pagination-admin') as { id: string };

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('pagination_session', admin.id, addHours(1), nowIso());

    const createChannel = async (name: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/channels',
        cookies: {
          current_session: 'pagination_session',
        },
        payload: {
          name,
          type: 'text',
        },
      });

    expect((await createChannel('alpha')).statusCode).toBe(201);
    expect((await createChannel('beta')).statusCode).toBe(201);
    expect((await createChannel('gamma')).statusCode).toBe(201);

    const firstChannelsPage = await app.inject({
      method: 'GET',
      url: '/api/v1/channels?limit=2',
      cookies: {
        current_session: 'pagination_session',
      },
    });
    expect(firstChannelsPage.statusCode).toBe(200);
    const channelsPayload1 = firstChannelsPage.json() as {
      items: Array<{ id: string; type: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(channelsPayload1.items.length).toBe(2);
    expect(channelsPayload1.pageInfo.hasMore).toBe(true);
    expect(channelsPayload1.pageInfo.nextCursor).toBeTruthy();

    const secondChannelsPage = await app.inject({
      method: 'GET',
      url: `/api/v1/channels?limit=2&after=${encodeURIComponent(channelsPayload1.pageInfo.nextCursor ?? '')}`,
      cookies: {
        current_session: 'pagination_session',
      },
    });
    expect(secondChannelsPage.statusCode).toBe(200);
    const channelsPayload2 = secondChannelsPage.json() as {
      items: Array<{ id: string }>;
      pageInfo: { hasMore: boolean };
    };
    expect(channelsPayload2.items.length).toBeGreaterThan(0);

    const membersSeed = [
      ['usr_page_1', 'did:plc:page1', 'a1.bsky.social', 'Aaron'],
      ['usr_page_2', 'did:plc:page2', 'b1.bsky.social', 'Beatrice'],
      ['usr_page_3', 'did:plc:page3', 'c1.bsky.social', 'Carlos'],
    ] as const;
    for (const [id, did, handle, displayName] of membersSeed) {
      db.prepare(
        `
        INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
      `,
      ).run(id, did, handle, displayName, nowIso(), nowIso());
    }

    const firstMembersPage = await app.inject({
      method: 'GET',
      url: '/api/v1/members?limit=2',
      cookies: {
        current_session: 'pagination_session',
      },
    });
    expect(firstMembersPage.statusCode).toBe(200);
    const membersPayload1 = firstMembersPage.json() as {
      items: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(membersPayload1.items.length).toBe(2);
    expect(membersPayload1.pageInfo.hasMore).toBe(true);
    expect(membersPayload1.pageInfo.nextCursor).toBeTruthy();

    const secondMembersPage = await app.inject({
      method: 'GET',
      url: `/api/v1/members?limit=2&after=${encodeURIComponent(membersPayload1.pageInfo.nextCursor ?? '')}`,
      cookies: {
        current_session: 'pagination_session',
      },
    });
    expect(secondMembersPage.statusCode).toBe(200);
    const membersPayload2 = secondMembersPage.json() as {
      items: Array<{ id: string }>;
    };
    expect(membersPayload2.items.length).toBeGreaterThan(0);

    const channelsForMessages = await app.inject({
      method: 'GET',
      url: '/api/v1/channels?limit=20',
      cookies: {
        current_session: 'pagination_session',
      },
    });
    const textChannelId = (channelsForMessages.json() as {
      items: Array<{ id: string; type: 'text' | 'voice' | 'dm' }>;
    }).items.find((channel) => channel.type === 'text')?.id;
    expect(textChannelId).toBeDefined();

    for (let index = 1; index <= 6; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/channels/${textChannelId}/messages`,
        cookies: {
          current_session: 'pagination_session',
        },
        payload: {
          content: `page-message-${index}`,
        },
      });
      expect(response.statusCode).toBe(201);
    }

    const firstMessagesPage = await app.inject({
      method: 'GET',
      url: `/api/v1/channels/${textChannelId}/messages?limit=3`,
      cookies: {
        current_session: 'pagination_session',
      },
    });
    expect(firstMessagesPage.statusCode).toBe(200);
    const messagesPayload1 = firstMessagesPage.json() as {
      items: Array<{ content: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(messagesPayload1.items.length).toBe(3);
    expect(messagesPayload1.items.at(-1)?.content).toBe('page-message-6');
    expect(messagesPayload1.pageInfo.hasMore).toBe(true);
    expect(messagesPayload1.pageInfo.nextCursor).toBeTruthy();

    const secondMessagesPage = await app.inject({
      method: 'GET',
      url:
        `/api/v1/channels/${textChannelId}/messages?limit=3&before=` +
        `${encodeURIComponent(messagesPayload1.pageInfo.nextCursor ?? '')}`,
      cookies: {
        current_session: 'pagination_session',
      },
    });
    expect(secondMessagesPage.statusCode).toBe(200);
    const messagesPayload2 = secondMessagesPage.json() as {
      items: Array<{ content: string }>;
      pageInfo: { hasMore: boolean };
    };
    expect(messagesPayload2.items.length).toBe(3);
    expect(messagesPayload2.items[0]?.content).toBe('page-message-1');
    expect(messagesPayload2.pageInfo.hasMore).toBe(false);

    const messageSearchResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/channels/${textChannelId}/messages/search?q=page-message&limit=2`,
      cookies: {
        current_session: 'pagination_session',
      },
    });
    expect(messageSearchResponse.statusCode).toBe(200);
    const messageSearchPayload = messageSearchResponse.json() as {
      items: Array<{ content: string }>;
    };
    expect(messageSearchPayload.items.map((item) => item.content)).toEqual([
      'page-message-6',
      'page-message-5',
    ]);

    const serverMessageSearchResponse = await app.inject({
      method: 'GET',
      url:
        `/api/v1/messages/search?q=page-message&limit=2&from=${encodeURIComponent(admin.id)}` +
        `&channelId=${encodeURIComponent(textChannelId ?? '')}`,
      cookies: {
        current_session: 'pagination_session',
      },
    });
    expect(serverMessageSearchResponse.statusCode).toBe(200);
    const serverMessageSearchPayload = serverMessageSearchResponse.json() as {
      items: Array<{ content: string; channelId: string; authorId: string }>;
    };
    expect(serverMessageSearchPayload.items.map((item) => item.content)).toEqual([
      'page-message-6',
      'page-message-5',
    ]);
    expect(serverMessageSearchPayload.items.every((item) => item.channelId === textChannelId)).toBe(true);
    expect(serverMessageSearchPayload.items.every((item) => item.authorId === admin.id)).toBe(true);

    await close();
  });

  it('rejects malformed pagination cursors', async () => {
    const { app, db, close } = await createTestApp();

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?)
    `,
    ).run('usr_cursor', 'did:plc:cursor', 'cursor.bsky.social', 'Cursor User', nowIso(), nowIso());

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('cursor_session', 'usr_cursor', addHours(1), nowIso());

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/members?after=not-a-valid-cursor',
      cookies: {
        current_session: 'cursor_session',
      },
    });

    expect(response.statusCode).toBe(400);

    await close();
  });

  it('validates limit bounds and malformed cursors for channels and messages', async () => {
    const { app, db, close } = await createTestApp();

    const setupResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Bounds Server',
        slug: 'bounds-server',
        publicUrl: 'http://localhost:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:bounds-admin',
        adminHandle: 'bounds-admin.bsky.social',
        adminDisplayName: 'Bounds Admin',
      },
    });
    expect(setupResponse.statusCode).toBe(201);

    const admin = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:bounds-admin') as { id: string };

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('bounds_session', admin.id, addHours(1), nowIso());

    const channelsLimitResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/channels?limit=201',
      cookies: {
        current_session: 'bounds_session',
      },
    });
    expect(channelsLimitResponse.statusCode).toBe(400);

    const malformedChannelsCursorResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/channels?after=not-a-valid-cursor',
      cookies: {
        current_session: 'bounds_session',
      },
    });
    expect(malformedChannelsCursorResponse.statusCode).toBe(400);

    const channelResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      cookies: {
        current_session: 'bounds_session',
      },
      payload: {
        name: 'bounds-text',
        type: 'text',
      },
    });
    expect(channelResponse.statusCode).toBe(201);
    const channelId = (channelResponse.json() as { id: string }).id;

    const messagesLimitResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/channels/${channelId}/messages?limit=201`,
      cookies: {
        current_session: 'bounds_session',
      },
    });
    expect(messagesLimitResponse.statusCode).toBe(400);

    const malformedMessagesCursorResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/channels/${channelId}/messages?before=not-a-valid-cursor`,
      cookies: {
        current_session: 'bounds_session',
      },
    });
    expect(malformedMessagesCursorResponse.statusCode).toBe(400);

    await close();
  });
});
