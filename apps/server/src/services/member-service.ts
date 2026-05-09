import type { CurrentUser, PageResponse } from '@current/types';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { CurrentConfig } from '@current/config';

export class MemberService {
  constructor(
    private readonly repos: RepositoryBag,
    private readonly getConfig: () => CurrentConfig,
  ) {}

  private resolveIdentityMode(): 'lan' | 'atproto' {
    return this.getConfig().auth.mode === 'lan' ? 'lan' : 'atproto';
  }

  listMembersPage(input: {
    serverId?: string;
    limit: number;
    after?: { displayName: string; handle: string; id: string };
  }): PageResponse<CurrentUser> {
    const identityMode = this.resolveIdentityMode();
    if (!input.serverId) {
      return this.repos.users.listMembersPage({
        limit: input.limit,
        after: input.after,
        identityMode,
      });
    }

    return this.repos.users.listVisibleMembersPage({
      serverId: input.serverId,
      limit: input.limit,
      after: input.after,
      identityMode,
    });
  }

  recordClientIp(userId: string, ipAddress: string): void {
    this.repos.userIps.observe(userId, ipAddress);
  }

  listSharedIpGroups() {
    const byId = new Map(this.repos.users.list().map((user) => [user.id, user]));
    return this.repos.userIps.listSharedGroups().map((group) => ({
      ipAddress: group.ipAddress,
      userCount: group.userCount,
      lastSeenAt: group.lastSeenAt,
      totalHits: group.totalHits,
      users: group.userIds
        .map((id) => byId.get(id))
        .filter((user): user is CurrentUser => Boolean(user))
        .map((user) => ({
          id: user.id,
          handle: user.handle,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
        })),
    }));
  }
}
