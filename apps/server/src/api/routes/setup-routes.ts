import type { FastifyInstance } from 'fastify';
import { isIP } from 'node:net';
import { z } from 'zod';

const BootstrapSchema = z.object({
  serverName: z.string().min(2),
  slug: z.string().min(2),
  publicUrl: z.string().url(),
  registrationMode: z.enum(['invite_only', 'open_signup', 'manual_approval']),
  initialPresenceStatus: z.enum(['online', 'away', 'dnd', 'invisible']).optional(),
  media: z
    .object({
      gifProvider: z.enum(['klipy', 'giphy']).optional(),
      gifFallbackProvider: z.enum(['none', 'klipy', 'giphy']).optional(),
      klipyApiKey: z.string().max(512).optional(),
      giphyApiKey: z.string().max(512).optional(),
      maxAttachmentBytes: z.number().int().positive().max(1024 * 1024 * 1024).optional(),
      allowedMimePrefixes: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
    })
    .optional(),
  moderation: z
    .object({
      defaultSlowmodeSeconds: z.number().int().min(0).max(86_400).optional(),
      maxMentionsPerMessage: z.number().int().min(1).max(500).optional(),
      linkPolicy: z.enum(['allow', 'members_only', 'deny']).optional(),
    })
    .optional(),
  adminDid: z.string().optional(),
  adminHandle: z.string().optional(),
  adminDisplayName: z.string().optional(),
  adminAvatarUrl: z.string().optional(),
});

function normalizeIpAddress(value: string): string {
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}

function isLoopbackIpAddress(value: string): boolean {
  const normalized = normalizeIpAddress(value);
  if (normalized === '::1' || normalized === '127.0.0.1') {
    return true;
  }
  if (isIP(normalized) !== 4) {
    return false;
  }
  const [firstOctet] = normalized.split('.').map((segment) => Number(segment));
  return firstOctet === 127;
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/setup/status', async () => {
    return app.appContext.setup.status();
  });

  app.post('/setup/bootstrap', async (request, reply) => {
    const parsed = BootstrapSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    try {
      const currentUser = request.currentUser;
      if (!currentUser && (!isLoopbackIpAddress(request.ip) || request.headers.origin)) {
        reply.code(401).send({
          error: {
            code: 'SETUP_AUTH_REQUIRED',
            message: 'First-run setup must be completed by a signed-in user.',
          },
        });
        return;
      }
      const payload = currentUser
        ? {
            ...parsed.data,
            adminDid: currentUser.did,
            adminHandle: currentUser.handle,
            adminDisplayName: currentUser.displayName,
            adminAvatarUrl: currentUser.avatarUrl,
          }
        : parsed.data;

      const result = app.appContext.setup.bootstrap(payload);
      reply.code(201).send(result);
    } catch (error) {
      reply.code(409).send({
        error: {
          code: 'SETUP_CONFLICT',
          message: error instanceof Error ? error.message : 'Unable to bootstrap setup.',
        },
      });
    }
  });
}
