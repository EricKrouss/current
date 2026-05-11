import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CurrentUser, ServerAccess } from '@current/types';
import type { ServerRemovalStatus } from '../db/repositories/moderation-repository.js';
import { buildAccessError, grantDefaultMemberRole, resolveServerAccess } from '../services/access-control.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: CurrentUser | null;
    serverRemoval: ServerRemovalStatus | null;
    serverAccess: ServerAccess | null;
  }
}

export function buildRemovalError(removal: ServerRemovalStatus) {
  const isBan = removal.type === 'ban';
  return {
    code: isBan ? 'SERVER_BANNED' : 'SERVER_KICKED',
    message: isBan ? "You've been banned" : "You've been kicked",
    reason: removal.reason,
    type: removal.type,
  };
}

export async function attachCurrentUser(request: FastifyRequest): Promise<void> {
  const app = request.server;
  const token = request.cookies.current_session;
  request.currentUser = app.appContext.auth.getUserBySession(token);
  request.serverRemoval = null;
  request.serverAccess = null;
  if (request.currentUser) {
    const serverId = app.appContext.setup.status().serverId;
    if (serverId) {
      request.serverRemoval = app.appContext.moderation.getServerRemovalStatus(serverId, request.currentUser.id);
    }
  }

  if (request.currentUser && !request.serverRemoval) {
    app.appContext.members.recordClientIp(request.currentUser.id, request.ip);
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.currentUser) {
    reply.code(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
      },
    });
    return;
  }

  if (request.serverRemoval) {
    reply.code(403).send({
      error: buildRemovalError(request.serverRemoval),
    });
    return;
  }

  if (
    request.method === 'POST' &&
    request.url.split('?')[0]?.endsWith('/admin/ownership/claim-host')
  ) {
    return;
  }

  const serverId = request.server.appContext.setup.status().serverId;
  if (!serverId) {
    request.serverAccess = {
      state: 'approved',
      registrationMode: request.server.appContext.serverConfig.get().server.registrationMode,
    };
    return;
  }

  request.serverAccess = resolveServerAccess(request.server.appContext.repos, {
    serverId,
    user: request.currentUser,
    registrationMode: request.server.appContext.serverConfig.get().server.registrationMode,
  });

  if (request.serverAccess.state !== 'approved') {
    reply.code(403).send({
      error: buildAccessError(request.serverAccess),
    });
    return;
  }

  if (!request.currentUser.roleIds.length) {
    const granted = grantDefaultMemberRole(request.server.appContext.repos, {
      serverId,
      userId: request.currentUser.id,
    });
    request.currentUser = granted.user ?? request.currentUser;
  }
}
