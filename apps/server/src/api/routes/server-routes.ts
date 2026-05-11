import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth-guard.js';
import { buildPublicServerPayload } from './server-payload.js';
import { denyForbidden, hasServerPermission } from '../permission-guard.js';

const E2EE_ROOM_KEY_SETTING = 'e2ee:room-key:v1';

const RegistrationModeSchema = z.object({
  registrationMode: z.enum(['invite_only', 'open_signup', 'manual_approval']),
});

const SharedE2eeKeySchema = z.object({
  exportedKey: z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/, 'E2EE room keys must be 32-byte base64url values.'),
});

interface StoredE2eeRoomKey {
  version: 1;
  exportedKey: string;
  keyId: string;
  createdAt: string;
  createdByUserId: string;
}

function exportedKeyToRawKey(exportedKey: string): Buffer | null {
  try {
    const rawKey = Buffer.from(exportedKey, 'base64url');
    return rawKey.byteLength === 32 ? rawKey : null;
  } catch {
    return null;
  }
}

function keyIdForRawKey(rawKey: Buffer): string {
  return createHash('sha256').update(rawKey).digest().subarray(0, 12).toString('base64url');
}

function normalizeExportedKey(exportedKey: string): { exportedKey: string; keyId: string } | null {
  const parsed = SharedE2eeKeySchema.safeParse({ exportedKey });
  if (!parsed.success) {
    return null;
  }

  const rawKey = exportedKeyToRawKey(parsed.data.exportedKey);
  if (!rawKey) {
    return null;
  }

  return {
    exportedKey: parsed.data.exportedKey,
    keyId: keyIdForRawKey(rawKey),
  };
}

function getStoredE2eeRoomKey(app: FastifyInstance): Pick<StoredE2eeRoomKey, 'exportedKey' | 'keyId'> | null {
  const stored = app.appContext.repos.settings.get<StoredE2eeRoomKey | string>(E2EE_ROOM_KEY_SETTING);
  const exportedKey = typeof stored === 'string' ? stored : stored?.exportedKey;
  if (!exportedKey) {
    return null;
  }

  const normalized = normalizeExportedKey(exportedKey);
  if (!normalized) {
    app.appContext.repos.settings.delete(E2EE_ROOM_KEY_SETTING);
    return null;
  }

  return normalized;
}

function getHistoricalEncryptedMessageKeyIds(app: FastifyInstance): Set<string> {
  const rows = app.appContext.db
    .prepare(
      `
      SELECT encrypted_content
      FROM messages
      WHERE encrypted_content IS NOT NULL
        AND encrypted_content <> ''
    `,
    )
    .all() as Array<{ encrypted_content: string }>;
  const keyIds = new Set<string>();

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.encrypted_content) as { keyId?: unknown };
      if (typeof parsed.keyId === 'string' && parsed.keyId.trim().length > 0) {
        keyIds.add(parsed.keyId);
      }
    } catch {
      // Invalid encrypted envelopes are ignored by the API serializer too.
    }
  }

  return keyIds;
}

export async function registerServerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/server', { preHandler: [requireAuth] }, async () => {
    const primary = app.appContext.setup.status();

    return {
      configured: primary.configured,
      server: buildPublicServerPayload(app),
      serverId: primary.serverId,
    };
  });

  app.get('/server/e2ee-key', { preHandler: [requireAuth] }, async (_request, reply) => {
    const stored = getStoredE2eeRoomKey(app);
    if (!stored) {
      reply.code(404).send({
        error: {
          code: 'E2EE_KEY_UNCLAIMED',
          message: 'A shared message encryption key has not been claimed yet.',
        },
      });
      return;
    }

    return stored;
  });

  app.post('/server/e2ee-key', { preHandler: [requireAuth] }, async (request, reply) => {
    const stored = getStoredE2eeRoomKey(app);
    if (stored) {
      return stored;
    }

    const parsed = SharedE2eeKeySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const normalized = normalizeExportedKey(parsed.data.exportedKey);
    if (!normalized) {
      reply.code(400).send({
        error: {
          code: 'INVALID_E2EE_KEY',
          message: 'E2EE room keys must decode to 32 bytes.',
        },
      });
      return;
    }

    const historicalKeyIds = getHistoricalEncryptedMessageKeyIds(app);
    if (historicalKeyIds.size > 0 && !historicalKeyIds.has(normalized.keyId)) {
      reply.code(409).send({
        error: {
          code: 'E2EE_KEY_MISMATCH',
          message:
            'Existing encrypted messages use a different browser key. Open a browser that can already read them once, or import that old room key.',
        },
      });
      return;
    }

    const roomKey: StoredE2eeRoomKey = {
      version: 1,
      exportedKey: normalized.exportedKey,
      keyId: normalized.keyId,
      createdAt: new Date().toISOString(),
      createdByUserId: request.currentUser?.id ?? 'unknown',
    };

    app.appContext.repos.settings.set(E2EE_ROOM_KEY_SETTING, roomKey);

    return {
      exportedKey: roomKey.exportedKey,
      keyId: roomKey.keyId,
    };
  });

  app.patch('/server/registration-mode', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = RegistrationModeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const primary = app.appContext.setup.status();
    if (!primary.serverId) {
      reply.code(404).send({
        error: {
          code: 'SERVER_NOT_FOUND',
          message: 'Server is not configured yet.',
        },
      });
      return;
    }
    if (!request.currentUser || !hasServerPermission(app.appContext, {
      serverId: primary.serverId,
      user: request.currentUser,
      permission: 'MANAGE_SERVER',
    })) {
      denyForbidden(reply, 'MANAGE_SERVER');
      return;
    }

    app.appContext.serverConfig.patchRegistrationMode(parsed.data.registrationMode);
    app.appContext.db
      .prepare('UPDATE servers SET registration_mode = ? WHERE id = ?')
      .run(parsed.data.registrationMode, primary.serverId);

    reply.send({
      registrationMode: parsed.data.registrationMode,
    });
  });
}
