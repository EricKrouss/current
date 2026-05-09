import type { Channel } from '@current/types';
import { describe, expect, it } from 'vitest';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';
import { createTestApp } from '../helpers/test-app.js';

describe('channel categories', () => {
  it('creates categories, persists sidebar order, and keeps category rows non-messageable', async () => {
    const { app, db, close } = await createTestApp();

    try {
      const setupResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/bootstrap',
        payload: {
          serverName: 'Category Integration',
          slug: 'category-integration',
          publicUrl: 'http://localhost:8080',
          registrationMode: 'invite_only',
          adminDid: 'did:plc:category',
          adminHandle: 'category.bsky.social',
          adminDisplayName: 'Category Admin',
        },
      });
      expect(setupResponse.statusCode).toBe(201);

      const user = db
        .prepare('SELECT id FROM users WHERE did = ?')
        .get('did:plc:category') as { id: string };
      db.prepare(
        `
        INSERT INTO sessions (token, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `,
      ).run('category_session', user.id, addHours(1), nowIso());

      const createCategoryResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/channels',
        cookies: {
          current_session: 'category_session',
        },
        payload: {
          name: 'Project Rooms',
          type: 'category',
        },
      });
      expect(createCategoryResponse.statusCode).toBe(201);
      const category = createCategoryResponse.json() as Channel;
      expect(category.type).toBe('category');

      const createTextResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/channels',
        cookies: {
          current_session: 'category_session',
        },
        payload: {
          name: 'planning',
          type: 'text',
        },
      });
      expect(createTextResponse.statusCode).toBe(201);
      const planning = createTextResponse.json() as Channel;

      const categoryMessageResponse = await app.inject({
        method: 'POST',
        url: `/api/v1/channels/${category.id}/messages`,
        cookies: {
          current_session: 'category_session',
        },
        payload: {
          content: 'category rows do not accept messages',
        },
      });
      expect(categoryMessageResponse.statusCode).toBe(409);
      expect((categoryMessageResponse.json() as { error: { reasons?: string[] } }).error.reasons)
        .toContain('unsupported_channel_type');

      const channelsBeforeOrderResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/channels?limit=20',
        cookies: {
          current_session: 'category_session',
        },
      });
      expect(channelsBeforeOrderResponse.statusCode).toBe(200);
      const channelsBeforeOrder = (channelsBeforeOrderResponse.json() as { items: Channel[] }).items;
      const rest = channelsBeforeOrder.filter((channel) => channel.id !== category.id && channel.id !== planning.id);
      const orderedItems = [
        { id: category.id, categoryId: null, position: 1000 },
        { id: planning.id, categoryId: category.id, position: 2000 },
        ...rest.map((channel, index) => ({
          id: channel.id,
          categoryId: channel.categoryId ?? null,
          position: (index + 3) * 1000,
        })),
      ];

      const reorderResponse = await app.inject({
        method: 'PUT',
        url: '/api/v1/channels/order',
        cookies: {
          current_session: 'category_session',
        },
        payload: {
          items: orderedItems,
        },
      });
      expect(reorderResponse.statusCode).toBe(200);

      const channelsAfterOrderResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/channels?limit=20',
        cookies: {
          current_session: 'category_session',
        },
      });
      expect(channelsAfterOrderResponse.statusCode).toBe(200);
      const channelsAfterOrder = (channelsAfterOrderResponse.json() as { items: Channel[] }).items;
      expect(channelsAfterOrder[0]?.id).toBe(category.id);
      expect(channelsAfterOrder[1]).toMatchObject({
        id: planning.id,
        categoryId: category.id,
        position: 2000,
      });

      const deleteCategoryResponse = await app.inject({
        method: 'DELETE',
        url: `/api/v1/channels/${category.id}`,
        cookies: {
          current_session: 'category_session',
        },
      });
      expect(deleteCategoryResponse.statusCode).toBe(204);

      const detachedPlanning = db
        .prepare('SELECT category_id FROM channels WHERE id = ?')
        .get(planning.id) as { category_id: string | null };
      expect(detachedPlanning.category_id).toBeNull();
    } finally {
      await close();
    }
  });
});
