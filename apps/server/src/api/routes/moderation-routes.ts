import type { FastifyInstance } from 'fastify';
import { GatewayEvents } from '@current/protocol';
import { z } from 'zod';
import { requireAuth } from '../auth-guard.js';
import { denyForbidden, hasServerPermission } from '../permission-guard.js';
import { grantDefaultMemberRole } from '../../services/access-control.js';

const RoleCreateSchema = z.object({
  name: z.string().min(1),
  color: z.string().min(4).max(16),
  position: z.number().int(),
  permissions: z.array(z.enum([
    'ADMINISTRATOR',
    'MANAGE_SERVER',
    'MANAGE_CHANNELS',
    'MANAGE_ROLES',
    'MODERATE_MEMBERS',
    'MANAGE_MESSAGES',
    'VIEW_CHANNEL',
    'SEND_MESSAGES',
    'CONNECT_VOICE',
    'SPEAK_VOICE',
    'ATTACH_FILES',
    'USE_GIFS',
  ])),
});

const ModActionSchema = z.object({
  targetUserId: z.string(),
  type: z.enum(['ban', 'mute', 'timeout', 'kick', 'warn']),
  reason: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
});

const ChannelModerationSchema = z.object({
  locked: z.boolean(),
  slowmodeSeconds: z.number().int().min(0).optional(),
});

const AutomodCreateSchema = z.object({
  name: z.string(),
  type: z.enum(['keyword', 'regex', 'mention_spam', 'link_policy']),
  enabled: z.boolean().default(true),
  payload: z.record(z.string(), z.unknown()),
});

const AccessRequestsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'denied']).optional(),
});

const AccessRequestParamsSchema = z.object({
  userId: z.string().min(1),
});

function formatRemovalDisconnectReason(type: 'kick' | 'ban', reason?: string): string {
  const title = type === 'ban' ? "You've been banned" : "You've been kicked";
  const trimmedReason = reason?.trim();
  return trimmedReason ? `${title}: ${trimmedReason}` : title;
}

export async function registerModerationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/roles', { preHandler: [requireAuth] }, async (_request, reply) => {
    const status = app.appContext.setup.status();
    if (!status.serverId) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    reply.send(app.appContext.moderation.listRoles(status.serverId));
  });

  app.post('/roles', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = RoleCreateSchema.safeParse(request.body);
    const status = app.appContext.setup.status();

    if (!body.success || !request.currentUser || !status.serverId) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_ROLES',
    })) {
      denyForbidden(reply, 'MANAGE_ROLES');
      return;
    }

    const role = app.appContext.moderation.createRole({
      ...body.data,
      serverId: status.serverId,
      actorId: request.currentUser.id,
    });

    reply.code(201).send(role);
  });

  app.patch('/roles/:roleId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ roleId: z.string() }).safeParse(request.params);
    const body = RoleCreateSchema.partial().safeParse(request.body);
    const status = app.appContext.setup.status();

    if (!params.success || !body.success || !request.currentUser || !status.serverId) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_ROLES',
    })) {
      denyForbidden(reply, 'MANAGE_ROLES');
      return;
    }

    const role = app.appContext.moderation.updateRole({
      roleId: params.data.roleId,
      serverId: status.serverId,
      actorId: request.currentUser.id,
      ...body.data,
    });

    if (!role) {
      reply.code(404).send({ error: 'Role not found.' });
      return;
    }

    reply.send(role);
  });

  app.delete('/roles/:roleId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ roleId: z.string() }).safeParse(request.params);
    const status = app.appContext.setup.status();

    if (!params.success || !request.currentUser || !status.serverId) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MANAGE_ROLES',
    })) {
      denyForbidden(reply, 'MANAGE_ROLES');
      return;
    }

    const deleted = app.appContext.moderation.deleteRole({
      roleId: params.data.roleId,
      actorId: request.currentUser.id,
      serverId: status.serverId,
    });
    if (!deleted) {
      reply.code(404).send({ error: 'Role not found.' });
      return;
    }

    reply.code(204).send();
  });

  app.get('/moderation/actions', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const query = z.object({ targetUserId: z.string().optional() }).safeParse(request.query);

    if (!status.serverId || !query.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (!request.currentUser || !hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MODERATE_MEMBERS',
    })) {
      denyForbidden(reply, 'MODERATE_MEMBERS');
      return;
    }

    reply.send(app.appContext.moderation.listActions(status.serverId, query.data.targetUserId));
  });

  app.post('/moderation/actions', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = ModActionSchema.safeParse(request.body);
    const status = app.appContext.setup.status();

    if (!body.success || !request.currentUser || !status.serverId) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MODERATE_MEMBERS',
    })) {
      denyForbidden(reply, 'MODERATE_MEMBERS');
      return;
    }

    const action = app.appContext.moderation.applyAction({
      serverId: status.serverId,
      actorId: request.currentUser.id,
      targetUserId: body.data.targetUserId,
      type: body.data.type,
      reason: body.data.reason,
      expiresAt: body.data.expiresAt,
    });

    app.appContext.gateway.broadcast(GatewayEvents.MOD_ACTION, {
      type: action.type,
      targetUserId: action.targetUserId,
      actorId: action.actorId,
      reason: action.reason,
    });

    if (action.type === 'kick' || action.type === 'ban') {
      const closedVoice = await app.appContext.voice.leaveChannel(action.targetUserId);
      for (const producer of closedVoice?.producers ?? []) {
        app.appContext.gateway.broadcastEphemeral(GatewayEvents.VOICE_PRODUCER_REMOVED, {
          producerId: producer.id,
          channelId: producer.channelId,
          userId: producer.userId,
        });
      }

      app.appContext.gateway.broadcast(GatewayEvents.VOICE_STATE_UPDATE, {
        voiceState: {
          userId: action.targetUserId,
          channelId: null,
        },
      });

      app.appContext.gateway.broadcast(GatewayEvents.MEMBER_UPDATE, {
        action: action.type,
        userId: action.targetUserId,
        actorId: action.actorId,
        reason: action.reason,
      });
      app.appContext.gateway.disconnectUser(
        action.targetUserId,
        formatRemovalDisconnectReason(action.type, action.reason),
      );
    }

    reply.code(201).send(action);
  });

  app.patch('/channels/:channelId/moderation', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ channelId: z.string() }).safeParse(request.params);
    const body = ChannelModerationSchema.safeParse(request.body);
    const status = app.appContext.setup.status();

    if (!params.success || !body.success || !request.currentUser || !status.serverId) {
      reply.code(400).send({ error: 'Invalid request.' });
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

    const channel = app.appContext.moderation.lockChannel({
      channelId: params.data.channelId,
      serverId: status.serverId,
      actorId: request.currentUser.id,
      locked: body.data.locked,
      slowmodeSeconds: body.data.slowmodeSeconds,
    });

    if (!channel) {
      reply.code(404).send({ error: 'Channel not found.' });
      return;
    }

    reply.send(channel);
  });

  app.get('/automod/rules', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();

    if (!status.serverId || !request.currentUser) {
      reply.code(404).send({ error: 'Server not configured.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MODERATE_MEMBERS',
    })) {
      denyForbidden(reply, 'MODERATE_MEMBERS');
      return;
    }

    reply.send(app.appContext.moderation.listAutomodRules(status.serverId));
  });

  app.post('/automod/rules', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = AutomodCreateSchema.safeParse(request.body);
    const status = app.appContext.setup.status();

    if (!body.success || !status.serverId || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MODERATE_MEMBERS',
    })) {
      denyForbidden(reply, 'MODERATE_MEMBERS');
      return;
    }

    const rule = app.appContext.moderation.createAutomodRule({
      serverId: status.serverId,
      actorId: request.currentUser.id,
      ...body.data,
    });

    reply.code(201).send(rule);
  });

  app.patch('/automod/rules/:ruleId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ ruleId: z.string() }).safeParse(request.params);
    const body = AutomodCreateSchema.partial().safeParse(request.body);
    const status = app.appContext.setup.status();

    if (!params.success || !body.success || !status.serverId || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MODERATE_MEMBERS',
    })) {
      denyForbidden(reply, 'MODERATE_MEMBERS');
      return;
    }

    const rule = app.appContext.moderation.updateAutomodRule({
      serverId: status.serverId,
      actorId: request.currentUser.id,
      ruleId: params.data.ruleId,
      patch: body.data,
    });

    if (!rule) {
      reply.code(404).send({ error: 'Rule not found.' });
      return;
    }

    reply.send(rule);
  });

  app.delete('/automod/rules/:ruleId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ ruleId: z.string() }).safeParse(request.params);
    const status = app.appContext.setup.status();

    if (!params.success || !status.serverId || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (!hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MODERATE_MEMBERS',
    })) {
      denyForbidden(reply, 'MODERATE_MEMBERS');
      return;
    }

    const deleted = app.appContext.moderation.deleteAutomodRule({
      ruleId: params.data.ruleId,
      serverId: status.serverId,
      actorId: request.currentUser.id,
    });
    if (!deleted) {
      reply.code(404).send({ error: 'Rule not found.' });
      return;
    }

    reply.code(204).send();
  });

  app.get('/audit/logs', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const query = z.object({ limit: z.coerce.number().int().min(1).max(300).optional() }).safeParse(request.query);

    if (!status.serverId || !query.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (!request.currentUser || !hasServerPermission(app.appContext, {
      serverId: status.serverId,
      user: request.currentUser,
      permission: 'MODERATE_MEMBERS',
    })) {
      denyForbidden(reply, 'MODERATE_MEMBERS');
      return;
    }

    reply.send(app.appContext.moderation.listAuditLogs(status.serverId, query.data.limit ?? 100));
  });

  app.get('/invites', { preHandler: [requireAuth] }, async (request, reply) => {
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

    reply.send(app.appContext.invites.list(status.serverId));
  });

  app.post('/invites', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = z
      .object({
        channelId: z.string().optional(),
        maxUses: z.number().int().positive().optional(),
        expiresAt: z.string().datetime().optional(),
      })
      .safeParse(request.body);

    const status = app.appContext.setup.status();
    if (!body.success || !request.currentUser || !status.serverId) {
      reply.code(400).send({ error: 'Invalid request.' });
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

    if (body.data.channelId) {
      const channel = app.appContext.chat.getChannelById(body.data.channelId);
      if (!channel || channel.serverId !== status.serverId) {
        reply.code(400).send({
          error: {
            code: 'INVALID_INVITE_CHANNEL',
            message: 'Invite channel must belong to the configured server.',
          },
        });
        return;
      }
    }

    const invite = app.appContext.invites.create({
      serverId: status.serverId,
      createdBy: request.currentUser.id,
      ...body.data,
    });

    reply.code(201).send(invite);
  });

  app.delete('/invites/:code', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = z.object({ code: z.string() }).safeParse(request.params);
    const status = app.appContext.setup.status();
    if (!params.success || !request.currentUser || !status.serverId) {
      reply.code(400).send({ error: 'Invalid request.' });
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

    const invite = app.appContext.repos.invites.get(params.data.code);
    if (!invite || invite.serverId !== status.serverId) {
      reply.code(404).send({ error: 'Invite not found.' });
      return;
    }

    app.appContext.invites.revoke(params.data.code);
    reply.code(204).send();
  });

  app.get('/access-requests', { preHandler: [requireAuth] }, async (request, reply) => {
    const status = app.appContext.setup.status();
    const query = AccessRequestsQuerySchema.safeParse(request.query);
    if (!query.success || !status.serverId || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
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

    reply.send(app.appContext.repos.accessRequests.list(status.serverId, query.data.status));
  });

  app.post('/access-requests/:userId/approve', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = AccessRequestParamsSchema.safeParse(request.params);
    const status = app.appContext.setup.status();
    if (!params.success || !status.serverId || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
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

    const existing = app.appContext.repos.accessRequests.get(status.serverId, params.data.userId);
    if (!existing) {
      reply.code(404).send({ error: 'Access request not found.' });
      return;
    }
    if (existing.status !== 'pending') {
      reply.code(409).send({ error: 'Access request has already been reviewed.' });
      return;
    }

    const accessRequest = app.appContext.repos.accessRequests.setStatus({
      serverId: status.serverId,
      userId: params.data.userId,
      status: 'approved',
      reviewedBy: request.currentUser.id,
    });
    const granted = grantDefaultMemberRole(app.appContext.repos, {
      serverId: status.serverId,
      userId: params.data.userId,
    });
    const member = granted.user ?? app.appContext.repos.users.findById(params.data.userId);

    if (member) {
      app.appContext.gateway.broadcast(GatewayEvents.MEMBER_UPDATE, {
        action: 'join',
        userId: member.id,
        member,
        actorId: request.currentUser.id,
      });
    }

    reply.send(accessRequest);
  });

  app.post('/access-requests/:userId/deny', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = AccessRequestParamsSchema.safeParse(request.params);
    const status = app.appContext.setup.status();
    if (!params.success || !status.serverId || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
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

    const existing = app.appContext.repos.accessRequests.get(status.serverId, params.data.userId);
    if (!existing) {
      reply.code(404).send({ error: 'Access request not found.' });
      return;
    }
    if (existing.status !== 'pending') {
      reply.code(409).send({ error: 'Access request has already been reviewed.' });
      return;
    }

    const accessRequest = app.appContext.repos.accessRequests.setStatus({
      serverId: status.serverId,
      userId: params.data.userId,
      status: 'denied',
      reviewedBy: request.currentUser.id,
    });
    app.appContext.gateway.disconnectUser(params.data.userId, 'Access request denied');
    reply.send(accessRequest);
  });
}
