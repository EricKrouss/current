import type { ChannelPermissionOverwrite, Permission, Role } from '@current/types';

export const ALL_PERMISSIONS: Permission[] = [
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
];

export interface PermissionContext {
  roleIds: string[];
  roles: Role[];
  channelOverwrites: ChannelPermissionOverwrite[];
  userId: string;
}

export function resolvePermissions(context: PermissionContext): Set<Permission> {
  const roleMap = new Map(context.roles.map((role) => [role.id, role]));
  const granted = new Set<Permission>();

  for (const roleId of context.roleIds) {
    const role = roleMap.get(roleId);
    if (!role) {
      continue;
    }

    for (const permission of role.permissions) {
      granted.add(permission);
    }
  }

  if (granted.has('ADMINISTRATOR')) {
    return new Set(ALL_PERMISSIONS);
  }

  const overwrites = context.channelOverwrites;
  const roleDeny = new Set<Permission>();
  const roleAllow = new Set<Permission>();
  const userDeny = new Set<Permission>();
  const userAllow = new Set<Permission>();

  for (const overwrite of overwrites) {
    if (overwrite.targetType === 'role' && context.roleIds.includes(overwrite.targetId)) {
      for (const deny of overwrite.deny) {
        roleDeny.add(deny);
      }
      for (const allow of overwrite.allow) {
        roleAllow.add(allow);
      }
    }

    if (overwrite.targetType === 'user' && overwrite.targetId === context.userId) {
      for (const deny of overwrite.deny) {
        userDeny.add(deny);
      }
      for (const allow of overwrite.allow) {
        userAllow.add(allow);
      }
    }
  }

  for (const deny of roleDeny) {
    granted.delete(deny);
  }
  for (const allow of roleAllow) {
    granted.add(allow);
  }
  for (const deny of userDeny) {
    granted.delete(deny);
  }
  for (const allow of userAllow) {
    granted.add(allow);
  }

  return granted;
}

export function hasPermission(permissionSet: Set<Permission>, permission: Permission): boolean {
  return permissionSet.has('ADMINISTRATOR') || permissionSet.has(permission);
}
