import type { CurrentUser, RegistrationMode, ServerAccess } from '@current/types';
import type { RepositoryBag } from '../db/repositories/index.js';

export function userHasServerRole(
  repos: RepositoryBag,
  input: { serverId: string; user: CurrentUser },
): boolean {
  const serverRoleIds = new Set(repos.roles.list(input.serverId).map((role) => role.id));
  return input.user.roleIds.some((roleId) => serverRoleIds.has(roleId));
}

export function grantDefaultMemberRole(
  repos: RepositoryBag,
  input: { serverId: string; userId: string },
): { user: CurrentUser | null; granted: boolean } {
  const user = repos.users.findById(input.userId);
  if (!user) {
    return { user: null, granted: false };
  }

  const memberRole = repos.roles
    .list(input.serverId)
    .find((role) => role.name.toLowerCase() === 'member');
  if (!memberRole) {
    return { user, granted: false };
  }

  if (user.roleIds.includes(memberRole.id)) {
    return { user, granted: false };
  }

  repos.users.addRole(user.id, memberRole.id);
  return {
    user: repos.users.findById(user.id) ?? user,
    granted: true,
  };
}

export function resolveServerAccess(
  repos: RepositoryBag,
  input: {
    serverId?: string;
    user: CurrentUser;
    registrationMode?: RegistrationMode;
  },
): ServerAccess {
  const server = input.serverId
    ? repos.servers.getPrimaryServer()
    : null;
  const serverId = input.serverId ?? server?.id;
  const registrationMode = input.registrationMode ?? server?.registrationMode ?? 'open_signup';

  if (!serverId) {
    return {
      state: 'approved',
      registrationMode,
    };
  }

  const request = repos.accessRequests.get(serverId, input.user.id) ?? undefined;
  if (userHasServerRole(repos, { serverId, user: input.user })) {
    return {
      state: 'approved',
      registrationMode,
      request,
    };
  }

  if (request?.status === 'approved') {
    return {
      state: 'approved',
      registrationMode,
      request,
    };
  }

  if (request?.status === 'pending') {
    return {
      state: 'pending',
      registrationMode,
      request,
    };
  }

  if (request?.status === 'denied') {
    return {
      state: 'denied',
      registrationMode,
      request,
    };
  }

  if (registrationMode === 'invite_only') {
    return {
      state: 'invite_required',
      registrationMode,
    };
  }

  if (registrationMode === 'manual_approval') {
    return {
      state: 'not_requested',
      registrationMode,
    };
  }

  return {
    state: 'approved',
    registrationMode,
  };
}

export function buildAccessError(access: ServerAccess) {
  if (access.state === 'denied') {
    return {
      code: 'SERVER_ACCESS_DENIED',
      message: 'Your request to join this server was denied.',
      access,
    };
  }

  if (access.state === 'invite_required') {
    return {
      code: 'SERVER_INVITE_REQUIRED',
      message: 'This server requires an invite.',
      access,
    };
  }

  if (access.state === 'pending') {
    return {
      code: 'SERVER_ACCESS_PENDING',
      message: 'Your request to join this server is pending approval.',
      access,
    };
  }

  return {
    code: 'SERVER_ACCESS_REQUIRED',
    message: 'Request access to join this server.',
    access,
  };
}
