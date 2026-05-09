import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth-guard.js';
import { decodeCursor } from '../../utils/cursor.js';

const MembersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  after: z.string().trim().min(1).max(1024).optional(),
});

const MembersAfterCursorSchema = z.object({
  displayName: z.string().min(1),
  handle: z.string().min(1),
  id: z.string().min(1),
});

export async function registerMemberRoutes(app: FastifyInstance): Promise<void> {
  app.get('/members', { preHandler: [requireAuth] }, async (request, reply) => {
    const query = MembersQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    const after = query.data.after
      ? MembersAfterCursorSchema.safeParse(decodeCursor<unknown>(query.data.after))
      : null;
    if (query.data.after && (!after || !after.success)) {
      reply.code(400).send({
        error: {
          code: 'INVALID_CURSOR',
          message: 'Invalid pagination cursor.',
        },
      });
      return;
    }

    const status = app.appContext.setup.status();
    return app.appContext.members.listMembersPage({
      serverId: status.serverId,
      limit: query.data.limit ?? 100,
      after: after?.success ? after.data : undefined,
    });
  });
}
