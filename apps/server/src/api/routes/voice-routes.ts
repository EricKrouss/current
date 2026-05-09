import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GatewayEvents } from '@current/protocol';
import { z } from 'zod';
import { requireAuth } from '../auth-guard.js';
import { denyForbidden, hasChannelPermission } from '../permission-guard.js';

const ChannelParamsSchema = z.object({ channelId: z.string().min(1) });
const TransportParamsSchema = z.object({ transportId: z.string().min(1) });
const ConsumerParamsSchema = z.object({ consumerId: z.string().min(1) });
const ProducerParamsSchema = z.object({ producerId: z.string().min(1) });
const SessionParamsSchema = z.object({ sessionId: z.string().min(1) });
const SessionBodySchema = z.object({ sessionId: z.string().min(1) });

const JoinBodySchema = z.object({
  muted: z.boolean().optional(),
  deafened: z.boolean().optional(),
  pushToTalk: z.boolean().optional(),
});

const TransportBodySchema = z.object({
  sessionId: z.string().min(1),
  direction: z.enum(['send', 'recv']),
});

const ConnectTransportBodySchema = z.object({
  sessionId: z.string().min(1),
  dtlsParameters: z.unknown(),
});

const ProduceBodySchema = z.object({
  sessionId: z.string().min(1),
  kind: z.literal('audio'),
  rtpParameters: z.unknown(),
  paused: z.boolean().optional(),
});

const ConsumeBodySchema = z.object({
  sessionId: z.string().min(1),
  producerId: z.string().min(1),
  rtpCapabilities: z.unknown(),
});

const ProducerPatchBodySchema = z.object({
  sessionId: z.string().min(1),
  paused: z.boolean(),
});

const VoiceStatePatchSchema = z.object({
  muted: z.boolean().optional(),
  deafened: z.boolean().optional(),
  pushToTalk: z.boolean().optional(),
  speaking: z.boolean().optional(),
});

function ensureVoiceSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
): boolean {
  if (!request.currentUser) {
    reply.code(401).send({ error: 'Unauthorized.' });
    return false;
  }
  if (!app.appContext.voice.sessionBelongsToUser(sessionId, request.currentUser.id)) {
    reply.code(404).send({ error: 'Voice session not found.' });
    return false;
  }
  return true;
}

function ensureVoiceChannelPermission(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  channelId: string,
  permission: 'CONNECT_VOICE' | 'SPEAK_VOICE',
): boolean {
  if (!request.currentUser) {
    reply.code(401).send({ error: 'Unauthorized.' });
    return false;
  }

  const status = app.appContext.setup.status();
  const channel = app.appContext.chat.getChannelById(channelId);
  if (!status.serverId || !channel || channel.serverId !== status.serverId || channel.type !== 'voice') {
    reply.code(404).send({ error: 'Voice channel not found.' });
    return false;
  }

  if (!hasChannelPermission(app.appContext, {
    serverId: status.serverId,
    channelId: channel.id,
    user: request.currentUser,
    permission,
  })) {
    denyForbidden(reply, permission);
    return false;
  }

  return true;
}

function sendVoiceError(reply: FastifyReply, error: unknown): void {
  reply.code(400).send({
    error: error instanceof Error ? error.message : 'Voice operation failed.',
  });
}

export async function registerVoiceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/voice/state', { preHandler: [requireAuth] }, async () => {
    return app.appContext.voice.listState();
  });

  app.post('/voice/channels/:channelId/token', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = ChannelParamsSchema.safeParse(request.params);
    if (!params.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (!ensureVoiceChannelPermission(app, request, reply, params.data.channelId, 'CONNECT_VOICE')) {
      return;
    }

    const token = app.appContext.voice.issueChannelToken({
      userId: request.currentUser.id,
      channelId: params.data.channelId,
    });

    reply.send(token);
  });

  app.post('/voice/channels/:channelId/join', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = ChannelParamsSchema.safeParse(request.params);
    const body = JoinBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (!ensureVoiceChannelPermission(app, request, reply, params.data.channelId, 'CONNECT_VOICE')) {
      return;
    }

    try {
      const join = await app.appContext.voice.joinChannel({
        userId: request.currentUser.id,
        channelId: params.data.channelId,
        ...body.data,
      });

      app.appContext.gateway.broadcast(GatewayEvents.VOICE_STATE_UPDATE, {
        voiceState: join.voiceState,
      });

      reply.send(join);
    } catch (error) {
      sendVoiceError(reply, error);
    }
  });

  app.post('/voice/channels/:channelId/leave', { preHandler: [requireAuth] }, async (request, reply) => {
    if (!request.currentUser) {
      reply.code(401).send({ error: 'Unauthorized.' });
      return;
    }

    const closed = await app.appContext.voice.leaveChannel(request.currentUser.id);
    for (const producer of closed?.producers ?? []) {
      app.appContext.gateway.broadcastEphemeral(GatewayEvents.VOICE_PRODUCER_REMOVED, {
        producerId: producer.id,
        channelId: producer.channelId,
        userId: producer.userId,
      });
    }

    app.appContext.gateway.broadcast(GatewayEvents.VOICE_STATE_UPDATE, {
      voiceState: {
        userId: request.currentUser.id,
        channelId: null,
      },
    });

    reply.code(204).send();
  });

  app.post('/voice/channels/:channelId/transports', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = ChannelParamsSchema.safeParse(request.params);
    const body = TransportBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (!ensureVoiceSession(app, request, reply, body.data.sessionId)) {
      return;
    }
    if (!ensureVoiceChannelPermission(app, request, reply, params.data.channelId, 'CONNECT_VOICE')) {
      return;
    }

    try {
      reply.send(await app.appContext.voice.createTransport(body.data));
    } catch (error) {
      sendVoiceError(reply, error);
    }
  });

  app.post('/voice/transports/:transportId/connect', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = TransportParamsSchema.safeParse(request.params);
    const body = ConnectTransportBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (!ensureVoiceSession(app, request, reply, body.data.sessionId)) {
      return;
    }

    try {
      await app.appContext.voice.connectTransport({
        sessionId: body.data.sessionId,
        transportId: params.data.transportId,
        dtlsParameters: body.data.dtlsParameters,
      });
      reply.code(204).send();
    } catch (error) {
      sendVoiceError(reply, error);
    }
  });

  app.post('/voice/transports/:transportId/restart-ice', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = TransportParamsSchema.safeParse(request.params);
    const body = SessionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (!ensureVoiceSession(app, request, reply, body.data.sessionId)) {
      return;
    }

    try {
      reply.send(await app.appContext.voice.restartTransportIce({
        sessionId: body.data.sessionId,
        transportId: params.data.transportId,
      }));
    } catch (error) {
      sendVoiceError(reply, error);
    }
  });

  app.post('/voice/transports/:transportId/produce', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = TransportParamsSchema.safeParse(request.params);
    const body = ProduceBodySchema.safeParse(request.body);
    if (!params.success || !body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    const state = app.appContext.voice.getUserState(request.currentUser.id);
    if (!state || !ensureVoiceSession(app, request, reply, body.data.sessionId)) {
      return;
    }
    if (!ensureVoiceChannelPermission(app, request, reply, state.channelId, 'SPEAK_VOICE')) {
      return;
    }

    try {
      const producer = await app.appContext.voice.produce({
        sessionId: body.data.sessionId,
        transportId: params.data.transportId,
        kind: body.data.kind,
        rtpParameters: body.data.rtpParameters,
        paused: body.data.paused,
      });

      app.appContext.gateway.broadcastEphemeral(GatewayEvents.VOICE_PRODUCER_ADDED, {
        producer,
      });

      reply.send({ producer });
    } catch (error) {
      sendVoiceError(reply, error);
    }
  });

  app.patch('/voice/producers/:producerId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = ProducerParamsSchema.safeParse(request.params);
    const body = ProducerPatchBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (!ensureVoiceSession(app, request, reply, body.data.sessionId)) {
      return;
    }

    try {
      const producer = await app.appContext.voice.setProducerPaused({
        sessionId: body.data.sessionId,
        producerId: params.data.producerId,
        paused: body.data.paused,
      });
      if (!producer) {
        reply.code(404).send({ error: 'Voice producer not found.' });
        return;
      }
      reply.send({ producer });
    } catch (error) {
      sendVoiceError(reply, error);
    }
  });

  app.post('/voice/transports/:transportId/consume', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = TransportParamsSchema.safeParse(request.params);
    const body = ConsumeBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (!ensureVoiceSession(app, request, reply, body.data.sessionId)) {
      return;
    }

    try {
      reply.send({
        consumer: await app.appContext.voice.consume({
          sessionId: body.data.sessionId,
          transportId: params.data.transportId,
          producerId: body.data.producerId,
          rtpCapabilities: body.data.rtpCapabilities,
        }),
      });
    } catch (error) {
      sendVoiceError(reply, error);
    }
  });

  app.post('/voice/consumers/:consumerId/resume', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = ConsumerParamsSchema.safeParse(request.params);
    const body = SessionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (!ensureVoiceSession(app, request, reply, body.data.sessionId)) {
      return;
    }

    try {
      await app.appContext.voice.resumeConsumer({
        sessionId: body.data.sessionId,
        consumerId: params.data.consumerId,
      });
      reply.code(204).send();
    } catch (error) {
      sendVoiceError(reply, error);
    }
  });

  app.post('/voice/sessions/:sessionId/heartbeat', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = SessionParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }
    if (!ensureVoiceSession(app, request, reply, params.data.sessionId)) {
      return;
    }
    app.appContext.voice.touchSession(params.data.sessionId);
    reply.code(204).send();
  });

  app.patch('/voice/state', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = VoiceStatePatchSchema.safeParse(request.body);
    if (!body.success || !request.currentUser) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    if (body.data.speaking) {
      const status = app.appContext.setup.status();
      const current = app.appContext.voice.getUserState(request.currentUser.id);
      if (!status.serverId || !current) {
        reply.code(404).send({ error: 'Voice state not found.' });
        return;
      }
      if (!hasChannelPermission(app.appContext, {
        serverId: status.serverId,
        channelId: current.channelId,
        user: request.currentUser,
        permission: 'SPEAK_VOICE',
      })) {
        denyForbidden(reply, 'SPEAK_VOICE');
        return;
      }
    }

    const state = app.appContext.voice.patchState({
      userId: request.currentUser.id,
      ...body.data,
    });

    if (!state) {
      reply.code(404).send({ error: 'Voice state not found.' });
      return;
    }

    app.appContext.gateway.broadcast(GatewayEvents.VOICE_STATE_UPDATE, {
      voiceState: state,
    });

    reply.send(state);
  });

  app.get('/voice/channels/:channelId/state', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = ChannelParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400).send({ error: 'Invalid request.' });
      return;
    }

    reply.send(app.appContext.voice.listChannelState(params.data.channelId));
  });

  app.get('/voice/diagnostics', { preHandler: [requireAuth] }, async () => {
    return app.appContext.voice.diagnostics();
  });
}
