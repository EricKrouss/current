import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth-guard.js';

const PresencePatchSchema = z.object({
  status: z.enum(['online', 'away', 'dnd', 'invisible']),
});

export async function registerPresenceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/presence', { preHandler: [requireAuth] }, async (request, reply) => {
    if (!request.currentUser) {
      reply.code(401).send({ error: 'Unauthorized.' });
      return;
    }

    reply.send({
      items: app.appContext.gateway.listPresenceForViewer(request.currentUser.id),
      selfStatus: app.appContext.gateway.getSelectedPresenceStatus(request.currentUser.id),
    });
  });

  app.patch('/presence', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = PresencePatchSchema.safeParse(request.body);
    if (!body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const presence = app.appContext.gateway.setSelectedPresenceStatus(request.currentUser.id, body.data.status);

    reply.send({
      presence,
      selfStatus: body.data.status,
    });
  });
}
