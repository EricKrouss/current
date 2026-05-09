import type {
  AutomodRule,
  ChannelPermissionOverwrite,
  CurrentUser,
  ModerationAction,
  Permission,
  Role,
} from '@current/types';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { MetricsService } from '../metrics/metrics-service.js';
import { nowIso } from '../utils/time.js';

export class ModerationService {
  constructor(
    private readonly repos: RepositoryBag,
    private readonly metrics: MetricsService,
  ) {}

  listRoles(serverId: string): Role[] {
    return this.repos.roles.list(serverId);
  }

  createRole(input: {
    serverId: string;
    name: string;
    color: string;
    position: number;
    permissions: Permission[];
    actorId: string;
  }): Role {
    const role = this.repos.roles.create(input);
    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'role.create',
      targetType: 'role',
      targetId: role.id,
      payload: role,
    });
    return role;
  }

  updateRole(input: {
    roleId: string;
    serverId: string;
    actorId: string;
    name?: string;
    color?: string;
    position?: number;
    permissions?: Permission[];
  }): Role | null {
    const role = this.repos.roles.update(input.roleId, {
      name: input.name,
      color: input.color,
      position: input.position,
      permissions: input.permissions,
    });

    if (!role) {
      return null;
    }

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'role.update',
      targetType: 'role',
      targetId: role.id,
      payload: role,
    });

    return role;
  }

  deleteRole(input: { roleId: string; serverId: string; actorId: string }): void {
    this.repos.roles.delete(input.roleId);
    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'role.delete',
      targetType: 'role',
      targetId: input.roleId,
      payload: {},
    });
  }

  setMemberRoles(input: {
    serverId: string;
    actorId: string;
    targetUserId: string;
    roleIds: string[];
  }): CurrentUser | null {
    const user = this.repos.users.setRoles(input.targetUserId, input.roleIds);
    if (!user) {
      return null;
    }

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'member.roles.update',
      targetType: 'user',
      targetId: input.targetUserId,
      payload: {
        roleIds: input.roleIds,
      },
    });

    return user;
  }

  replaceChannelOverwrites(input: {
    serverId: string;
    actorId: string;
    channelId: string;
    overwrites: Array<{
      targetType: 'role' | 'user';
      targetId: string;
      allow: Permission[];
      deny: Permission[];
    }>;
  }): ChannelPermissionOverwrite[] {
    const overwrites = this.repos.channels.replaceOverwrites(input.channelId, input.overwrites);
    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'channel.permissions.update',
      targetType: 'channel',
      targetId: input.channelId,
      payload: {
        overwrites,
      },
    });
    return overwrites;
  }

  deleteChannelOverwrite(input: {
    serverId: string;
    actorId: string;
    channelId: string;
    overwriteId: string;
  }): void {
    this.repos.channels.deleteOverwrite(input.overwriteId);
    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'channel.permissions.delete',
      targetType: 'channel',
      targetId: input.channelId,
      payload: {
        overwriteId: input.overwriteId,
      },
    });
  }

  applyAction(input: Omit<ModerationAction, 'id' | 'createdAt'>): ModerationAction {
    const action = this.repos.moderation.create(input);
    this.metrics.incrementModerationActions();

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: `moderation.${input.type}`,
      targetType: 'user',
      targetId: input.targetUserId,
      payload: {
        reason: input.reason,
        expiresAt: input.expiresAt,
      },
    });

    return action;
  }

  listActions(serverId: string, targetUserId?: string): ModerationAction[] {
    return this.repos.moderation.list(serverId, targetUserId);
  }

  isBlockedFromMessaging(serverId: string, userId: string): { blocked: boolean; reason?: string } {
    if (this.repos.moderation.isBanned(serverId, userId)) {
      return { blocked: true, reason: 'banned' };
    }

    const timeoutUntil = this.repos.moderation.activeTimeoutUntil(serverId, userId);
    if (timeoutUntil) {
      return { blocked: true, reason: `timeout_until:${timeoutUntil}` };
    }

    return { blocked: false };
  }

  lockChannel(input: {
    channelId: string;
    serverId: string;
    actorId: string;
    locked: boolean;
    slowmodeSeconds?: number;
  }) {
    const channel = this.repos.channels.update(input.channelId, {
      locked: input.locked,
      slowmodeSeconds: input.slowmodeSeconds,
    });

    if (!channel) {
      return null;
    }

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'channel.moderation.update',
      targetType: 'channel',
      targetId: input.channelId,
      payload: {
        locked: input.locked,
        slowmodeSeconds: channel.slowmodeSeconds,
        at: nowIso(),
      },
    });

    return channel;
  }

  listAutomodRules(serverId: string): AutomodRule[] {
    return this.repos.automod.list(serverId);
  }

  createAutomodRule(input: {
    serverId: string;
    actorId: string;
    name: string;
    type: AutomodRule['type'];
    enabled: boolean;
    payload: Record<string, unknown>;
  }): AutomodRule {
    const rule = this.repos.automod.create({
      serverId: input.serverId,
      name: input.name,
      type: input.type,
      enabled: input.enabled,
      payload: input.payload,
    });

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'automod.create',
      targetType: 'automod_rule',
      targetId: rule.id,
      payload: rule,
    });

    return rule;
  }

  updateAutomodRule(input: {
    ruleId: string;
    serverId: string;
    actorId: string;
    patch: Partial<Omit<AutomodRule, 'id' | 'serverId' | 'createdAt'>>;
  }): AutomodRule | null {
    const rule = this.repos.automod.update(input.ruleId, input.patch);
    if (!rule) {
      return null;
    }

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'automod.update',
      targetType: 'automod_rule',
      targetId: rule.id,
      payload: input.patch as Record<string, unknown>,
    });

    return rule;
  }

  deleteAutomodRule(input: { ruleId: string; serverId: string; actorId: string }): void {
    this.repos.automod.delete(input.ruleId);
    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'automod.delete',
      targetType: 'automod_rule',
      targetId: input.ruleId,
      payload: {},
    });
  }

  listAuditLogs(serverId: string, limit = 100) {
    return this.repos.audit.list(serverId, limit);
  }
}
