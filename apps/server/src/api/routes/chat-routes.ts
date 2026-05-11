import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GatewayEvents } from '@current/protocol';
import type { Channel, CurrentUser, Message } from '@current/types';
import type {
  CurrentMessageNotificationPayload,
  CurrentNotificationKind,
} from '../../db/repositories/notification-events-repository.js';
import { requireAuth } from '../auth-guard.js';
import { denyForbidden, hasChannelPermission, hasServerPermission } from '../permission-guard.js';
import { decodeCursor } from '../../utils/cursor.js';

const ChannelTypeSchema = z.enum(['category', 'text', 'voice', 'dm']);
const ChannelPositionSchema = z.number().int().min(0).max(1_000_000_000);

const ChannelCreateSchema = z.object({
  name: z.string().min(1),
  type: ChannelTypeSchema,
  categoryId: z.string().nullable().optional(),
  topic: z.string().optional(),
  slowmodeSeconds: z.number().int().min(0).optional(),
  position: ChannelPositionSchema.optional(),
});

const ChannelPatchSchema = z.object({
  categoryId: z.string().nullable().optional(),
  name: z.string().optional(),
  type: ChannelTypeSchema.optional(),
  topic: z.string().optional(),
  slowmodeSeconds: z.number().int().min(0).optional(),
  locked: z.boolean().optional(),
  position: ChannelPositionSchema.optional(),
});

const ChannelOrderSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    categoryId: z.string().nullable().optional(),
    position: ChannelPositionSchema,
  })).min(1).max(500),
});

const ChannelsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  after: z.string().trim().min(1).max(1024).optional(),
});

const ChannelsAfterCursorSchema = z.object({
  position: z.number().optional(),
  createdAt: z.string().min(1),
  id: z.string().min(1),
});

const EncryptedMessageContentSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal('AES-GCM'),
  keyId: z.string().trim().min(8).max(128),
  nonce: z.string().trim().min(16).max(64),
  ciphertext: z.string().trim().min(1).max(32768),
});

const MessageCreateSchema = z
  .object({
    content: z.string().max(4000).optional().default(''),
    encryptedContent: EncryptedMessageContentSchema.optional(),
    parentMessageId: z.string().optional(),
    notificationMentions: z.array(z.string().trim().min(1).max(253)).max(32).optional(),
    gifUrl: z.string().url().optional(),
    attachmentIds: z.array(z.string().trim().min(1).max(128)).max(10).optional(),
  })
  .superRefine((value, context) => {
    if (value.encryptedContent && value.content.trim().length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Encrypted messages must not include plaintext content.',
      });
    }
  });

function normalizeNotificationMentionHandle(handle: string): string | null {
  const normalized = handle.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._-]+$/.test(normalized) ? normalized : null;
}

function normalizeNotificationMentionHandles(handles: string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const handle of handles ?? []) {
    const value = normalizeNotificationMentionHandle(handle);
    if (value) {
      normalized.add(value);
    }
  }
  return [...normalized];
}

function extractNotificationMentionHandles(content: string): string[] {
  const handles = new Set<string>();
  for (const match of content.matchAll(/@[A-Za-z0-9._-]+/g)) {
    const handle = normalizeNotificationMentionHandle(match[0]);
    if (handle) {
      handles.add(handle);
    }
  }
  return [...handles];
}

const MessagePatchSchema = z
  .object({
    content: z.string().max(4000).optional().default(''),
    encryptedContent: EncryptedMessageContentSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.encryptedContent && value.content.trim().length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Encrypted messages must not include plaintext content.',
      });
    }
  });

const MessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().trim().min(1).max(1024).optional(),
});

const CurrentNotificationsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const MessageSearchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  from: z.string().trim().min(1).max(128).optional(),
});

const ServerMessageSearchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  from: z.string().trim().min(1).max(128).optional(),
  channelId: z.string().trim().min(1).max(128).optional(),
});

const MessagesBeforeCursorSchema = z.object({
  createdAt: z.string().min(1),
  id: z.string().min(1),
});

const TypingUpdateSchema = z.object({
  isTyping: z.boolean().optional(),
});

const ReactionSchema = z.object({
  emoji: z.string().min(1).max(32),
});

const AttachmentUploadQuerySchema = z.object({
  channelId: z.string().trim().min(1).max(128).optional(),
});

function isConfiguredServerAsset(app: FastifyInstance, attachmentId: string): boolean {
  const server = app.appContext.repos.servers.getPrimaryServer();
  const config = app.appContext.serverConfig.get();
  return (
    server?.iconAttachmentId === attachmentId ||
    server?.bannerAttachmentId === attachmentId ||
    config.appearance.backgroundAttachmentId === attachmentId
  );
}

function canViewChannel(app: FastifyInstance, input: { serverId: string; channelId: string; user: CurrentUser }): boolean {
  return hasChannelPermission(app.appContext, {
    serverId: input.serverId,
    channelId: input.channelId,
    user: input.user,
    permission: 'VIEW_CHANNEL',
  });
}

function filterVisibleChannels(
  app: FastifyInstance,
  input: { serverId: string; user: CurrentUser; channels: Channel[] },
): Channel[] {
  return input.channels.filter((channel) =>
    canViewChannel(app, {
      serverId: input.serverId,
      channelId: channel.id,
      user: input.user,
    }),
  );
}

function visibleMessageChannelIds(app: FastifyInstance, input: { serverId: string; user: CurrentUser }): string[] {
  return filterVisibleChannels(app, {
    serverId: input.serverId,
    user: input.user,
    channels: app.appContext.repos.channels.listAll(input.serverId),
  })
    .filter((channel) => channel.type === 'text' || channel.type === 'dm')
    .map((channel) => channel.id);
}

function notificationKindForTarget(input: {
  mentioned: boolean;
  replyToUser: boolean;
}): CurrentNotificationKind {
  return input.mentioned ? 'current_mention' : 'current_reply';
}

function recordCurrentNotificationEvents(
  app: FastifyInstance,
  input: {
    serverId: string;
    channelId: string;
    gatewaySeq: number;
    message: Message;
    mentionHandles: string[];
    replyToUserId?: string;
  },
): void {
  const targets = new Map<
    string,
    {
      user: CurrentUser;
      mentioned: boolean;
      replyToUser: boolean;
      mentionHandles: Set<string>;
    }
  >();

  const addTarget = (user: CurrentUser | null, patch: { mentionHandle?: string; replyToUser?: boolean }) => {
    if (!user || user.id === input.message.authorId) {
      return;
    }

    if (!canViewChannel(app, {
      serverId: input.serverId,
      channelId: input.channelId,
      user,
    })) {
      return;
    }

    const existing = targets.get(user.id) ?? {
      user,
      mentioned: false,
      replyToUser: false,
      mentionHandles: new Set<string>(),
    };

    if (patch.mentionHandle) {
      existing.mentioned = true;
      existing.mentionHandles.add(patch.mentionHandle);
    }
    if (patch.replyToUser) {
      existing.replyToUser = true;
    }
    targets.set(user.id, existing);
  };

  if (input.replyToUserId) {
    addTarget(app.appContext.repos.users.findById(input.replyToUserId), { replyToUser: true });
  }

  for (const handle of input.mentionHandles) {
    addTarget(app.appContext.repos.users.findByHandle(handle), { mentionHandle: handle });
  }

  for (const target of targets.values()) {
    const notification: CurrentMessageNotificationPayload = {
      ...(target.mentionHandles.size > 0 ? { mentionHandles: [...target.mentionHandles] } : {}),
      ...(target.replyToUser ? { replyToUserId: target.user.id } : {}),
    };

    app.appContext.repos.notificationEvents.append({
      gatewaySeq: input.gatewaySeq,
      userId: target.user.id,
      serverId: input.serverId,
      channelId: input.channelId,
      messageId: input.message.id,
      kind: notificationKindForTarget({
        mentioned: target.mentioned,
        replyToUser: target.replyToUser,
      }),
      payload: {
        message: input.message,
        notification,
      },
    });
  }
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/channels', { preHandler: [requireAuth] }, async (request, reply) => {
    const query = ChannelsQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    const after = query.data.after
      ? ChannelsAfterCursorSchema.safeParse(decodeCursor<unknown>(query.data.after))
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
    if (!status.serverId) {
      return {
        items: [],
        pageInfo: {
          hasMore: false,
        },
      };
    }

    const currentUser = request.currentUser;
    const serverId = status.serverId;
    if (!currentUser || !serverId) {
      reply.code(401).send({ error: 'Unauthorized.' });
      return;
    }

    const page = app.appContext.chat.listChannelsPage({
      serverId,
      limit: query.data.limit ?? 75,
      after: after?.success ? after.data : undefined,
    });
    return {
      ...page,
      items: filterVisibleChannels(app, {
        serverId,
        user: currentUser,
        channels: page.items,
      }),
    };
  });

  app.post('/channels', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = ChannelCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser) {
      reply.code(401).send({ error: { code: 'NO_SERVER', message: 'No configured server.' } });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_CHANNELS',
    })) {
      denyForbidden(reply, 'MANAGE_CHANNELS');
      return;
    }

    let channel;
    try {
      channel = app.appContext.chat.createChannel({
        ...parsed.data,
        serverId: status.serverId,
        actorId: request.currentUser.id,
      });
    } catch (error) {
      reply.code(400).send({
        error: {
          code: 'INVALID_CHANNEL',
          message: error instanceof Error ? error.message : 'Invalid channel.',
        },
      });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.PRESENCE_UPDATE, {
      action: 'channel_create',
      channel,
    });

    reply.code(201).send(channel);
  });

  app.put('/channels/order', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = ChannelOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser) {
      reply.code(401).send({ error: { code: 'NO_SERVER', message: 'No configured server.' } });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_CHANNELS',
    })) {
      denyForbidden(reply, 'MANAGE_CHANNELS');
      return;
    }

    let channels;
    try {
      channels = app.appContext.chat.reorderChannels({
        serverId: status.serverId,
        actorId: request.currentUser.id,
        items: parsed.data.items,
      });
    } catch (error) {
      reply.code(400).send({
        error: {
          code: 'INVALID_CHANNEL_ORDER',
          message: error instanceof Error ? error.message : 'Invalid channel order.',
        },
      });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.PRESENCE_UPDATE, {
      action: 'channel_reorder',
      channels,
    });

    reply.send({ items: channels });
  });

  app.patch('/channels/:channelId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const patch = ChannelPatchSchema.safeParse(request.body);

    if (!params.success || !patch.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_CHANNELS',
    })) {
      denyForbidden(reply, 'MANAGE_CHANNELS');
      return;
    }

    let channel;
    try {
      channel = app.appContext.chat.updateChannel({
        channelId: params.data.channelId,
        serverId: status.serverId,
        actorId: request.currentUser.id,
        patch: patch.data,
      });
    } catch (error) {
      reply.code(400).send({
        error: {
          code: 'INVALID_CHANNEL',
          message: error instanceof Error ? error.message : 'Invalid channel.',
        },
      });
      return;
    }

    if (!channel) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.PRESENCE_UPDATE, {
      action: 'channel_update',
      channel,
    });

    reply.send(channel);
  });

  app.delete('/channels/:channelId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    if (!params.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_CHANNELS',
    })) {
      denyForbidden(reply, 'MANAGE_CHANNELS');
      return;
    }

    const deleted = app.appContext.chat.deleteChannel({
      channelId: params.data.channelId,
      serverId: status.serverId,
      actorId: request.currentUser.id,
    });
    if (!deleted) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.PRESENCE_UPDATE, {
      action: 'channel_delete',
      channelId: params.data.channelId,
    });

    reply.code(204).send();
  });

  app.get('/notifications/current', { preHandler: [requireAuth] }, async (request, reply) => {
    reply.header('cache-control', 'no-store');

    const query = CurrentNotificationsQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      return {
        items: [],
        pageInfo: {
          hasMore: false,
          latestSeq: 0,
        },
      };
    }

    const currentUser = request.currentUser;
    const serverId = status.serverId;
    if (!currentUser || !serverId) {
      reply.code(401).send({ error: 'Unauthorized.' });
      return;
    }

    const afterSeq = query.data.afterSeq ?? 0;
    const limit = query.data.limit ?? 100;
    const latestSeq = app.appContext.repos.gatewayEvents.latestSeq();
    const rows = app.appContext.repos.notificationEvents.listForUserSince({
      userId: currentUser.id,
      afterSeq,
      limit: limit + 1,
    });
    const pageRows = rows.slice(0, limit);
    const visibleRows = pageRows.filter((row) =>
      canViewChannel(app, {
        serverId,
        channelId: row.channelId,
        user: currentUser,
      }),
    );
    const hasMore = rows.length > limit;
    const lastScannedSeq = pageRows[pageRows.length - 1]?.seq ?? afterSeq;

    return {
      items: visibleRows.map((row) => ({
        id: row.eventId,
        seq: row.seq,
        kind: row.kind,
        message: row.payload.message,
        notification: row.payload.notification,
        createdAt: row.createdAt,
      })),
      pageInfo: {
        hasMore,
        nextAfterSeq: hasMore ? lastScannedSeq : undefined,
        latestSeq: Math.max(latestSeq, lastScannedSeq),
      },
    };
  });

  app.get('/channels/:channelId/messages', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).parse(request.params);
    const query = MessagesQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    const before = query.data.before
      ? MessagesBeforeCursorSchema.safeParse(decodeCursor<unknown>(query.data.before))
      : null;
    if (query.data.before && (!before || !before.success)) {
      reply.code(400).send({
        error: {
          code: 'INVALID_CURSOR',
          message: 'Invalid pagination cursor.',
        },
      });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const channel = app.appContext.chat.getChannelById(params.channelId);
    if (!channel || channel.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }
    if (!request.currentUser || !canViewChannel(app, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
    return app.appContext.chat.listMessagesPage({
      channelId: params.channelId,
      limit: query.data.limit ?? 40,
      before: before?.success ? before.data : undefined,
      identityMode,
    });
  });

  app.get('/channels/:channelId/messages/search', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const query = MessageSearchQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const channel = app.appContext.chat.getChannelById(params.data.channelId);
    if (!channel || channel.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }
    if (!request.currentUser || !canViewChannel(app, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
    return {
      items: app.appContext.chat.searchMessages({
        channelId: params.data.channelId,
        query: query.data.q,
        limit: query.data.limit ?? 10,
        authorId: query.data.from,
        identityMode,
      }),
    };
  });

  app.get('/messages/search', { preHandler: [requireAuth] }, async (request, reply) => {
    const query = ServerMessageSearchQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      return { items: [] };
    }
    if (!request.currentUser) {
      reply.code(401).send({ error: 'Unauthorized.' });
      return;
    }

    if (query.data.channelId) {
      const channel = app.appContext.chat.getChannelById(query.data.channelId);
      if (!channel || channel.serverId !== status.serverId) {
        reply.code(404).send({ error: 'Channel not found.' });
        return;
      }
      if (!canViewChannel(app, {
        serverId: status.serverId,
        channelId: channel.id,
        user: request.currentUser,
      })) {
        reply.code(404).send({ error: 'Channel not found.' });
        return;
      }
    }

    const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
    const channelIds = query.data.channelId
      ? [query.data.channelId]
      : visibleMessageChannelIds(app, {
          serverId: status.serverId,
          user: request.currentUser,
        });
    return {
      items: app.appContext.chat.searchMessagesInServer({
        serverId: status.serverId,
        query: query.data.q,
        limit: query.data.limit ?? 10,
        authorId: query.data.from,
        channelId: query.data.channelId,
        channelIds,
        identityMode,
      }),
    };
  });

  app.get('/messages/:messageId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ messageId: z.string() }).safeParse(request.params);
    if (!params.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
    const message = app.appContext.chat.getMessageById({
      messageId: params.data.messageId,
      serverId: status.serverId,
      identityMode,
    });

    if (!message) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }
    if (!request.currentUser || !canViewChannel(app, {
      serverId: status.serverId,
      channelId: message.channelId,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    reply.send(message);
  });

  app.post('/channels/:channelId/messages', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const body = MessageCreateSchema.safeParse(request.body);

    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const channel = app.appContext.chat.getChannelById(params.data.channelId);
    if (!channel || channel.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }
    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    if (!hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
      permission: 'SEND_MESSAGES',
    })) {
      denyForbidden(reply, 'SEND_MESSAGES');
      return;
    }

    if ((body.data.attachmentIds?.length ?? 0) > 0 && !hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
      permission: 'ATTACH_FILES',
    })) {
      denyForbidden(reply, 'ATTACH_FILES');
      return;
    }

    if (body.data.gifUrl && !hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
      permission: 'USE_GIFS',
    })) {
      denyForbidden(reply, 'USE_GIFS');
      return;
    }

    const result = app.appContext.chat.sendMessage({
      serverId: status.serverId,
      channelId: params.data.channelId,
      authorId: request.currentUser.id,
      content: body.data.content,
      encryptedContent: body.data.encryptedContent,
      parentMessageId: body.data.parentMessageId,
      gifUrl: body.data.gifUrl,
      attachmentIds: body.data.attachmentIds,
    });

    if (!result.message) {
      reply.code(409).send({
        error: {
          code: 'MESSAGE_BLOCKED',
          reasons: result.blocked,
        },
      });
      return;
    }

    const mentionHandles = normalizeNotificationMentionHandles([
      ...extractNotificationMentionHandles(body.data.content),
      ...(body.data.notificationMentions ?? []),
    ]);
    const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
    const parentMessage = result.message.parentMessageId
      ? app.appContext.chat.getMessageById({
          messageId: result.message.parentMessageId,
          serverId: status.serverId,
          identityMode,
        })
      : null;
    const notification =
      mentionHandles.length > 0 || parentMessage?.authorId
        ? {
            ...(mentionHandles.length > 0 ? { mentionHandles } : {}),
            ...(parentMessage?.authorId ? { replyToUserId: parentMessage.authorId } : {}),
          }
        : undefined;

    const gatewaySeq = app.appContext.gateway.broadcast(GatewayEvents.MESSAGE_CREATE, {
      message: result.message,
      ...(notification ? { notification } : {}),
    });
    recordCurrentNotificationEvents(app, {
      serverId: status.serverId,
      channelId: channel.id,
      gatewaySeq,
      message: result.message,
      mentionHandles,
      replyToUserId: parentMessage?.authorId,
    });

    reply.code(201).send(result.message);
  });

  app.post('/channels/:channelId/typing', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const body = TypingUpdateSchema.safeParse(request.body ?? {});

    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    const channel = app.appContext.chat.getChannelById(params.data.channelId);
    if (!channel) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    if (channel.type !== 'text' && channel.type !== 'dm') {
      reply.code(409).send({
        error: {
          code: 'TYPING_UNSUPPORTED',
          message: 'Typing indicators are only available in text channels and DMs.',
        },
      });
      return;
    }

    if (!status.serverId || channel.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    if (!hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: channel.id,
      user: request.currentUser,
      permission: 'SEND_MESSAGES',
    })) {
      denyForbidden(reply, 'SEND_MESSAGES');
      return;
    }

    app.appContext.gateway.broadcastTypingUpdate({
      channelId: channel.id,
      userId: request.currentUser.id,
      isTyping: body.data.isTyping ?? true,
    });

    reply.code(204).send();
  });

  app.patch('/messages/:messageId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ messageId: z.string() }).safeParse(request.params);
    const body = MessagePatchSchema.safeParse(request.body);

    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const existing = app.appContext.chat.getMessageById({
      messageId: params.data.messageId,
      serverId: status.serverId,
    });
    if (!existing) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }
    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    if (existing.authorId !== request.currentUser.id && !hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
      permission: 'MANAGE_MESSAGES',
    })) {
      denyForbidden(reply, 'MANAGE_MESSAGES');
      return;
    }

    const message = app.appContext.chat.editMessage({
      messageId: params.data.messageId,
      content: body.data.content,
      encryptedContent: body.data.encryptedContent,
    });

    if (!message) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.MESSAGE_UPDATE, {
      message,
    });

    reply.send(message);
  });

  app.delete('/messages/:messageId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ messageId: z.string() }).safeParse(request.params);
    if (!params.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const existing = app.appContext.chat.getMessageById({
      messageId: params.data.messageId,
      serverId: status.serverId,
    });
    if (!existing) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }
    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    if (existing.authorId !== request.currentUser.id && !hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
      permission: 'MANAGE_MESSAGES',
    })) {
      denyForbidden(reply, 'MANAGE_MESSAGES');
      return;
    }

    const message = app.appContext.chat.deleteMessage({
      messageId: params.data.messageId,
      serverId: status.serverId,
      actorId: request.currentUser.id,
    });
    if (!message) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.MESSAGE_DELETE, {
      messageId: message.id,
      channelId: message.channelId,
    });

    reply.code(204).send();
  });

  app.post('/messages/:messageId/reactions', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ messageId: z.string() }).safeParse(request.params);
    const body = ReactionSchema.safeParse(request.body);

    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    const existing = app.appContext.chat.getMessageById({
      messageId: params.data.messageId,
      serverId: status.serverId,
    });
    if (!existing) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }
    if (!canViewChannel(app, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
    })) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    if (!hasChannelPermission(app.appContext, {
      serverId: status.serverId,
      channelId: existing.channelId,
      user: request.currentUser,
      permission: 'SEND_MESSAGES',
    })) {
      denyForbidden(reply, 'SEND_MESSAGES');
      return;
    }

    const result = app.appContext.chat.toggleReaction({
      messageId: params.data.messageId,
      userId: request.currentUser.id,
      emoji: body.data.emoji,
    });

    if (!result.message) {
      reply.code(404).send({ error: 'Message not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.MESSAGE_UPDATE, {
      message: result.message,
    });

    reply.send(result.message);
  });

  app.post('/media/attachments', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const query = AttachmentUploadQuerySchema.safeParse(request.query);
    if (!status.serverId || !request.currentUser || !query.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (query.data.channelId) {
      const channel = app.appContext.chat.getChannelById(query.data.channelId);
      if (!channel || channel.serverId !== status.serverId) {
        reply.code(404).send({ error: 'Channel not found.' });
        return;
      }

      if (!canViewChannel(app, {
        serverId: status.serverId,
        channelId: channel.id,
        user: request.currentUser,
      })) {
        reply.code(404).send({ error: 'Channel not found.' });
        return;
      }

      if (!hasChannelPermission(app.appContext, {
        serverId: status.serverId,
        channelId: channel.id,
        user: request.currentUser,
        permission: 'ATTACH_FILES',
      })) {
        denyForbidden(reply, 'ATTACH_FILES');
        return;
      }
    } else if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'ATTACH_FILES',
    })) {
      denyForbidden(reply, 'ATTACH_FILES');
      return;
    }

    const file = await request.file();
    if (!file) {
      reply.code(400).send({ error: 'No file uploaded.' });
      return;
    }

    const bytes = await file.toBuffer();
    try {
      const attachment = app.appContext.chat.saveAttachment({
        fileName: file.filename,
        mimeType: file.mimetype,
        bytes,
        ownerUserId: request.currentUser.id,
      });
      reply.code(201).send(attachment);
    } catch (error) {
      reply.code(400).send({
        error: {
          code: 'ATTACHMENT_REJECTED',
          message: error instanceof Error ? error.message : 'Attachment upload failed.',
        },
      });
    }
  });

  app.get('/media/attachments/:attachmentId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ attachmentId: z.string() }).safeParse(request.params);
    if (!params.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    const attachment = app.appContext.chat.getAttachment(params.data.attachmentId);
    if (!attachment) {
      reply.code(404).send({ error: 'Attachment not found.' });
      return;
    }

    const status = app.appContext.setup.status();
    if (!status.serverId || !request.currentUser) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (attachment.messageId) {
      const identityMode = app.appContext.serverConfig.get().auth.mode === 'lan' ? 'lan' : 'atproto';
      const message = app.appContext.chat.getMessageById({
        messageId: attachment.messageId,
        serverId: status.serverId,
        identityMode,
      });
      if (!message) {
        reply.code(404).send({ error: 'Attachment not found.' });
        return;
      }
      if (!canViewChannel(app, {
        serverId: status.serverId,
        channelId: message.channelId,
        user: request.currentUser,
      })) {
        reply.code(404).send({ error: 'Attachment not found.' });
        return;
      }
    } else if (
      attachment.ownerUserId !== request.currentUser.id &&
      !isConfiguredServerAsset(app, attachment.id) &&
      !hasServerPermission(app.appContext, {
        serverId: status.serverId,
        user: request.currentUser,
        permission: 'MANAGE_SERVER',
      })
    ) {
      reply.code(404).send({ error: 'Attachment not found.' });
      return;
    }

    reply
      .type(attachment.mimeType)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'; script-src 'none'; object-src 'none'")
      .header('Cross-Origin-Resource-Policy', 'same-origin')
      .header('Content-Disposition', `inline; filename="${attachment.fileName.replace(/["\\\r\n]/g, '_')}"`);
    return reply.send(createReadStream(attachment.path));
  });

  app.get('/media/gifs/search', { preHandler: [requireAuth] }, async (request, reply) => {
    const query = z
      .object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(50).optional() })
      .safeParse(request.query);

    if (!query.success) {
      reply.code(400).send({ error: query.error.flatten() });
      return;
    }

    try {
      const data = await app.appContext.chat.searchGifs(query.data.q, query.data.limit ?? 20);
      reply.send(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GIF search failed.';
      const provider = app.appContext.serverConfig.get().media.gifProvider;
      reply.send({
        results: [],
        provider,
        providerError: {
          provider,
          code: `${provider.toUpperCase()}_ERROR`,
          message,
        },
      });
    }
  });
}
