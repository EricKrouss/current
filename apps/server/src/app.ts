import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import type { AppContext } from './types/context.js';
import { attachCurrentUser } from './api/auth-guard.js';
import { registerSetupRoutes } from './api/routes/setup-routes.js';
import { registerAuthRoutes } from './api/routes/auth-routes.js';
import { registerServerRoutes } from './api/routes/server-routes.js';
import { registerMemberRoutes } from './api/routes/member-routes.js';
import { registerChatRoutes } from './api/routes/chat-routes.js';
import { registerModerationRoutes } from './api/routes/moderation-routes.js';
import { registerVoiceRoutes } from './api/routes/voice-routes.js';
import { registerPresenceRoutes } from './api/routes/presence-routes.js';
import { registerMetricsRoutes } from './api/routes/metrics-routes.js';
import { registerAdminRoutes } from './api/routes/admin-routes.js';
import { registerWebClientRoutes } from './web-client.js';

export interface BuildAppOptions {
  webDistDir?: string | false;
}

export function buildApp(context: AppContext, options: BuildAppOptions = {}) {
  const tls = context.config.server.tls;
  const app = Fastify({
    logger: {
      level: context.config.observability.logLevel,
    },
    ...(tls.enabled && tls.keyPath && tls.certPath
      ? {
          https: {
            key: readFileSync(tls.keyPath),
            cert: readFileSync(tls.certPath),
          },
        }
      : {}),
  });

  app.decorate('appContext', context);

  app.register(cors, {
    origin: true,
    credentials: true,
  });

  app.register(cookie, {
    secret: context.config.auth.cookieSecret,
    hook: 'onRequest',
  });

  app.register(multipart, {
    limits: {
      fileSize: context.config.media.maxAttachmentBytes,
    },
  });

  app.addHook('onRequest', attachCurrentUser);

  app.addHook('onResponse', async (_request, reply) => {
    context.metrics.recordRequest(reply.statusCode);
  });

  app.addHook('onClose', async () => {
    await context.voice.close();
  });

  app.register(async (api) => {
    await registerMetricsRoutes(api);
    await registerSetupRoutes(api);
    await registerAuthRoutes(api);
    await registerServerRoutes(api);
    await registerMemberRoutes(api);
    await registerChatRoutes(api);
    await registerModerationRoutes(api);
    await registerVoiceRoutes(api);
    await registerPresenceRoutes(api);
    await registerAdminRoutes(api);
  }, { prefix: '/api/v1' });

  registerWebClientRoutes(app, options.webDistDir);

  context.gateway.attach(app.server);

  return app;
}
