import { existsSync, mkdirSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { CurrentUser, RegistrationMode, UserPresenceStatus } from '@current/types';
import { ALL_PERMISSIONS } from '../moderation/permissions.js';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { ServerConfigService } from '../services/server-config-service.js';
import { nowIso } from '../utils/time.js';

export interface SetupStatus {
  configured: boolean;
  serverId?: string;
  authMode: 'atproto' | 'lan';
}

export interface BootstrapInput {
  serverName: string;
  slug: string;
  publicUrl: string;
  registrationMode: RegistrationMode;
  initialPresenceStatus?: UserPresenceStatus;
  media?: {
    gifProvider?: 'klipy' | 'giphy';
    gifFallbackProvider?: 'none' | 'klipy' | 'giphy';
    klipyApiKey?: string;
    giphyApiKey?: string;
    maxAttachmentBytes?: number;
    allowedMimePrefixes?: string[];
  };
  moderation?: {
    defaultSlowmodeSeconds?: number;
    maxMentionsPerMessage?: number;
    linkPolicy?: 'allow' | 'members_only' | 'deny';
  };
  adminDid?: string;
  adminHandle?: string;
  adminDisplayName?: string;
  adminAvatarUrl?: string;
}

export interface EnsureOwnerOptions {
  allowLanOwnershipRecovery?: boolean;
}

export interface FactoryResetResult {
  resetAt: string;
  attachmentFilesDeleted: number;
}

export class SetupService {
  constructor(
    private readonly repos: RepositoryBag,
    private readonly serverConfig: ServerConfigService,
    private readonly db: DatabaseSync,
  ) {}

  status(): SetupStatus {
    const configured = Boolean(this.repos.settings.get<boolean>('setup_complete'));
    const server = this.repos.servers.getPrimaryServer();

    return {
      configured,
      serverId: server?.id,
      authMode: this.serverConfig.get().auth.mode,
    };
  }

  bootstrap(input: BootstrapInput): { serverId: string; defaultChannelId: string } {
    const existing = this.status();
    if (existing.configured || existing.serverId) {
      throw new Error('Server is already configured.');
    }

    const server = this.repos.servers.create({
      name: input.serverName,
      slug: input.slug,
      registrationMode: input.registrationMode,
    });

    const adminRole = this.repos.roles.create({
      serverId: server.id,
      name: 'Admin',
      color: '#ff6a3d',
      position: 100,
      permissions: ALL_PERMISSIONS,
    });

    const memberRole = this.repos.roles.create({
      serverId: server.id,
      name: 'Member',
      color: '#6bd7ff',
      position: 1,
      permissions: ['SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE', 'ATTACH_FILES', 'USE_GIFS'],
    });

    const generalChannel = this.repos.channels.create({
      serverId: server.id,
      name: 'general',
      type: 'text',
      topic: 'Welcome to Current',
      slowmodeSeconds: input.moderation?.defaultSlowmodeSeconds ?? 0,
    });

    this.repos.channels.create({
      serverId: server.id,
      name: 'lounge',
      type: 'voice',
    });

    if (input.adminDid && input.adminHandle && input.adminDisplayName) {
      const adminUser = this.repos.users.upsertByDid({
        did: input.adminDid,
        handle: input.adminHandle,
        displayName: input.adminDisplayName,
        avatarUrl: input.adminAvatarUrl,
      });
      if (input.initialPresenceStatus) {
        this.repos.users.setPresenceStatus(adminUser.id, input.initialPresenceStatus);
      }
      this.repos.users.addRole(adminUser.id, adminRole.id);
      this.repos.users.addRole(adminUser.id, memberRole.id);
      this.repos.settings.set('owner_user_id', adminUser.id);
    }

    this.repos.settings.set('setup_complete', true);
    this.repos.settings.set('server_id', server.id);

    this.serverConfig.patchFromSetup({
      serverName: input.serverName,
      slug: input.slug,
      publicUrl: input.publicUrl,
      registrationMode: input.registrationMode,
      media: input.media,
      moderation: input.moderation,
    });

    return { serverId: server.id, defaultChannelId: generalChannel.id };
  }

  ensureOwnerForUser(user: CurrentUser, options: EnsureOwnerOptions = {}): CurrentUser {
    const status = this.status();
    if (!status.serverId) {
      return user;
    }

    const roles = this.repos.roles.list(status.serverId);
    const adminRole = roles.find((role) => role.permissions.includes('ADMINISTRATOR'));
    const memberRole = roles.find((role) => role.name.toLowerCase() === 'member');
    if (!adminRole) {
      return user;
    }

    const authMode = this.serverConfig.get().auth.mode;
    const allowLanOwnershipRecovery = Boolean(options.allowLanOwnershipRecovery);
    const hasAdminAssigned = this.repos.users.hasAnyAssigneeForRole(adminRole.id);
    if (authMode === 'lan') {
      const ownerUserId = this.getOwnerUserId();
      const shouldRecoverLanOwnership =
        allowLanOwnershipRecovery &&
        (!ownerUserId ||
          ownerUserId !== user.id ||
          !hasAdminAssigned ||
          !user.roleIds.includes(adminRole.id));

      if (shouldRecoverLanOwnership) {
        if (!user.roleIds.includes(adminRole.id)) {
          this.repos.users.addRole(user.id, adminRole.id);
        }
        if (memberRole && !user.roleIds.includes(memberRole.id)) {
          this.repos.users.addRole(user.id, memberRole.id);
        }
        this.repos.settings.set('owner_user_id', user.id);
        return this.repos.users.findById(user.id) ?? user;
      }

      if (
        !allowLanOwnershipRecovery &&
        (!ownerUserId || ownerUserId !== user.id || !hasAdminAssigned || !user.roleIds.includes(adminRole.id))
      ) {
        return this.repos.users.findById(user.id) ?? user;
      }
    }

    if (!hasAdminAssigned) {
      this.repos.users.addRole(user.id, adminRole.id);
      if (memberRole) {
        this.repos.users.addRole(user.id, memberRole.id);
      }
    }

    if (!this.getOwnerUserId()) {
      this.repos.settings.set('owner_user_id', user.id);
    }

    return this.repos.users.findById(user.id) ?? user;
  }

  getOwnerUserId(): string | null {
    return this.repos.settings.get<string>('owner_user_id');
  }

  transferOwnership(input: { serverId: string; actorId: string; targetUserId: string }): CurrentUser {
    const previousOwnerUserId = this.getOwnerUserId();
    const target = this.repos.users.findById(input.targetUserId);
    if (!target) {
      throw new Error('Target user not found.');
    }

    const roles = this.repos.roles.list(input.serverId);
    const adminRole = roles.find((role) => role.permissions.includes('ADMINISTRATOR'));
    if (!adminRole) {
      throw new Error('Admin role is missing.');
    }

    this.repos.users.addRole(target.id, adminRole.id);
    this.repos.settings.set('owner_user_id', target.id);

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'server.owner.transfer',
      targetType: 'user',
      targetId: target.id,
      payload: {
        previousOwnerUserId,
        newOwnerUserId: target.id,
      },
    });

    return this.repos.users.findById(target.id) ?? target;
  }

  factoryReset(): FactoryResetResult {
    const attachmentPaths = this.listAttachmentPaths();
    this.clearServerData();
    const attachmentFilesDeleted = this.deleteAttachmentFiles(attachmentPaths);
    mkdirSync(this.serverConfig.get().storage.uploadDir, { recursive: true });

    return {
      resetAt: nowIso(),
      attachmentFilesDeleted,
    };
  }

  private listAttachmentPaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM attachments').all() as Array<{ path: string | null }>;
    return rows
      .map((row) => row.path?.trim())
      .filter((path): path is string => Boolean(path));
  }

  private deleteAttachmentFiles(paths: string[]): number {
    let deleted = 0;
    for (const path of new Set(paths)) {
      if (!existsSync(path)) {
        continue;
      }
      rmSync(path, { force: true });
      deleted += 1;
    }
    return deleted;
  }

  private clearServerData(): void {
    this.db.exec('BEGIN');
    try {
      for (const table of [
        'voice_states',
        'reactions',
        'attachments',
        'messages',
        'channel_overwrites',
        'invites',
        'automod_rules',
        'moderation_actions',
        'audit_logs',
        'gateway_events',
        'user_ip_activity',
        'sessions',
        'user_roles',
        'channels',
        'roles',
        'users',
        'servers',
        'settings',
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      const hasSqliteSequence = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'")
        .get();
      if (hasSqliteSequence) {
        this.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'gateway_events'").run();
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
