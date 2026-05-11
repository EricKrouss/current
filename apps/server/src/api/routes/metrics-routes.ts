import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth-guard.js';
import { denyForbidden, hasServerPermission } from '../permission-guard.js';

export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async () => {
    const status = app.appContext.setup.status();
    return {
      status: status.configured ? 'ready' : 'setup_required',
      setup: status,
    };
  });

  app.get('/admin/metrics', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_SERVER',
    })) {
      denyForbidden(reply, 'MANAGE_SERVER');
      return;
    }

    return app.appContext.metrics.snapshot();
  });
}
