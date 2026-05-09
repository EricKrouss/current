import type { CurrentUser, Permission } from '@current/types';
import type { FastifyReply } from 'fastify';
import type { AppContext } from '../types/context.js';
import { hasPermission, resolvePermissions } from '../moderation/permissions.js';

export function hasServerPermission(
  context: AppContext,
  input: {
    serverId: string;
    user: CurrentUser;
    permission: Permission;
  },
): boolean {
  const roles = context.moderation.listRoles(input.serverId);
  const permissions = resolvePermissions({
    roleIds: input.user.roleIds,
    roles,
    channelOverwrites: [],
    userId: input.user.id,
  });

  return hasPermission(permissions, input.permission);
}

export function hasChannelPermission(
  context: AppContext,
  input: {
    serverId: string;
    channelId: string;
    user: CurrentUser;
    permission: Permission;
  },
): boolean {
  const roles = context.moderation.listRoles(input.serverId);
  const permissions = resolvePermissions({
    roleIds: input.user.roleIds,
    roles,
    channelOverwrites: context.repos.channels.listOverwrites(input.channelId),
    userId: input.user.id,
  });

  return hasPermission(permissions, input.permission);
}

export function denyForbidden(reply: FastifyReply, permission: Permission): void {
  reply.code(403).send({
    error: {
      code: 'FORBIDDEN',
      message: `Missing required permission: ${permission}`,
    },
  });
}
