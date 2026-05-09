import type { CurrentUser, PageResponse, UserPresenceStatus } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { nowIso } from '../../utils/time.js';
import { id } from '../../utils/id.js';
import { encodeCursor } from '../../utils/cursor.js';

interface UserRow {
  id: string;
  did: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  selected_presence_status: string;
  created_at: string;
}

const VALID_PRESENCE_STATUSES = new Set<UserPresenceStatus>(['online', 'away', 'dnd', 'invisible']);

function normalizePresenceStatus(value: unknown): UserPresenceStatus {
  return typeof value === 'string' && VALID_PRESENCE_STATUSES.has(value as UserPresenceStatus)
    ? (value as UserPresenceStatus)
    : 'online';
}

export class UsersRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  upsertByDid(input: {
    did: string;
    handle: string;
    displayName: string;
    avatarUrl?: string;
  }): CurrentUser {
    const existing = this.db.prepare('SELECT id FROM users WHERE did = ?').get(input.did) as
      | { id: string }
      | undefined;

    const ts = nowIso();
    const userId = existing?.id ?? id('usr');

    this.db
      .prepare(
        `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(did) DO UPDATE SET
        handle = excluded.handle,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        updated_at = excluded.updated_at
    `,
      )
      .run(userId, input.did, input.handle, input.displayName, input.avatarUrl ?? null, ts, ts);

    return this.findById(userId)!;
  }

  findById(userId: string): CurrentUser | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      | UserRow
      | undefined;
    if (!row) {
      return null;
    }

    const roleRows = this.db
      .prepare(
        `
      SELECT role_id
      FROM user_roles
      WHERE user_id = ?
    `,
      )
      .all(userId) as unknown as Array<{ role_id: string }>;

    return {
      id: row.id,
      did: row.did,
      handle: row.handle,
      displayName: row.display_name,
      avatarUrl: row.avatar_url ?? undefined,
      roleIds: roleRows.map((entry) => entry.role_id),
      createdAt: row.created_at,
    };
  }

  findByDid(did: string): CurrentUser | null {
    const row = this.db.prepare('SELECT id FROM users WHERE did = ?').get(did) as
      | { id: string }
      | undefined;
    return row ? this.findById(row.id) : null;
  }

  getPresenceStatus(userId: string): UserPresenceStatus {
    const row = this.db
      .prepare('SELECT selected_presence_status FROM users WHERE id = ?')
      .get(userId) as { selected_presence_status?: string } | undefined;
    return normalizePresenceStatus(row?.selected_presence_status);
  }

  setPresenceStatus(userId: string, status: UserPresenceStatus): void {
    this.db
      .prepare(
        `
      UPDATE users
      SET selected_presence_status = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(status, nowIso(), userId);
  }

  list(): CurrentUser[] {
    const rows = this.db.prepare('SELECT id FROM users ORDER BY created_at ASC').all() as unknown as Array<{ id: string }>;
    return rows.map((row) => this.findById(row.id)).filter((row): row is CurrentUser => Boolean(row));
  }

  listMembersPage(input: {
    limit: number;
    after?: { displayName: string; handle: string; id: string };
    identityMode?: 'all' | 'lan' | 'atproto';
  }): PageResponse<CurrentUser> {
    return this.listMembersPageFromQuery({
      limit: input.limit,
      after: input.after,
      identityMode: input.identityMode ?? 'all',
      filterSql: '',
      filterParams: [],
    });
  }

  listVisibleMembersPage(input: {
    serverId: string;
    limit: number;
    after?: { displayName: string; handle: string; id: string };
    identityMode?: 'all' | 'lan' | 'atproto';
  }): PageResponse<CurrentUser> {
    return this.listMembersPageFromQuery({
      limit: input.limit,
      after: input.after,
      identityMode: input.identityMode ?? 'all',
      filterSql: `
        NOT EXISTS (
          SELECT 1
          FROM moderation_actions AS mod
          WHERE mod.server_id = ?
            AND mod.target_user_id = users.id
            AND mod.type IN ('ban', 'kick')
        )
      `,
      filterParams: [input.serverId],
    });
  }

  addRole(userId: string, roleId: string): void {
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO user_roles (user_id, role_id)
      VALUES (?, ?)
    `,
      )
      .run(userId, roleId);
  }

  removeRole(userId: string, roleId: string): void {
    this.db
      .prepare(
        `
      DELETE FROM user_roles
      WHERE user_id = ? AND role_id = ?
    `,
      )
      .run(userId, roleId);
  }

  setRoles(userId: string, roleIds: string[]): CurrentUser | null {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
      const insert = this.db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)');
      for (const roleId of roleIds) {
        insert.run(userId, roleId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return this.findById(userId);
  }

  hasAnyAssigneeForRole(roleId: string): boolean {
    const row = this.db
      .prepare(
        `
      SELECT 1
      FROM user_roles
      WHERE role_id = ?
      LIMIT 1
    `,
      )
      .get(roleId) as { 1: number } | undefined;

    return Boolean(row);
  }

  setSession(token: string, userId: string, expiresAt: string): void {
    this.db
      .prepare(
        `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(token, userId, expiresAt, nowIso());
  }

  clearSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  findUserBySession(token: string): CurrentUser | null {
    const row = this.db
      .prepare(
        `
      SELECT user_id, expires_at
      FROM sessions
      WHERE token = ?
    `,
      )
      .get(token) as { user_id: string; expires_at: string } | undefined;

    if (!row) {
      return null;
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.clearSession(token);
      return null;
    }

    return this.findById(row.user_id);
  }

  private listMembersPageFromQuery(input: {
    limit: number;
    after?: { displayName: string; handle: string; id: string };
    identityMode: 'all' | 'lan' | 'atproto';
    filterSql: string;
    filterParams: string[];
  }): PageResponse<CurrentUser> {
    const fetchLimit = input.limit + 1;
    const whereClauses: string[] = [];
    const params: string[] = [];

    if (input.filterSql.trim().length > 0) {
      whereClauses.push(input.filterSql);
      params.push(...input.filterParams);
    }

    if (input.identityMode === 'lan') {
      whereClauses.push(`users.did LIKE ?`);
      params.push('did:current:lan:%');
    } else if (input.identityMode === 'atproto') {
      whereClauses.push(`users.did NOT LIKE ?`);
      params.push('did:current:lan:%');
    }

    if (input.after) {
      whereClauses.push(
        `(
          users.display_name COLLATE NOCASE > ? COLLATE NOCASE
          OR (
            users.display_name COLLATE NOCASE = ? COLLATE NOCASE
            AND users.handle COLLATE NOCASE > ? COLLATE NOCASE
          )
          OR (
            users.display_name COLLATE NOCASE = ? COLLATE NOCASE
            AND users.handle COLLATE NOCASE = ? COLLATE NOCASE
            AND users.id > ?
          )
        )`,
      );
      params.push(
        input.after.displayName,
        input.after.displayName,
        input.after.handle,
        input.after.displayName,
        input.after.handle,
        input.after.id,
      );
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `
        SELECT
          users.id,
          users.did,
          users.handle,
          users.display_name,
          users.avatar_url,
          users.selected_presence_status,
          users.created_at
        FROM users
        ${whereSql}
        ORDER BY users.display_name COLLATE NOCASE ASC, users.handle COLLATE NOCASE ASC, users.id ASC
        LIMIT ?
      `,
      )
      .all(...params, fetchLimit) as unknown as UserRow[];

    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const roleMap = this.loadRoleMap(pageRows.map((row) => row.id));
    const items = pageRows.map((row) => this.toCurrentUser(row, roleMap.get(row.id) ?? []));
    const last = pageRows[pageRows.length - 1];

    return {
      items,
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                displayName: last.display_name,
                handle: last.handle,
                id: last.id,
              })
            : undefined,
      },
    };
  }

  private loadRoleMap(userIds: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const userId of userIds) {
      map.set(userId, []);
    }
    if (userIds.length === 0) {
      return map;
    }

    const placeholders = userIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `
        SELECT user_id, role_id
        FROM user_roles
        WHERE user_id IN (${placeholders})
      `,
      )
      .all(...userIds) as unknown as Array<{ user_id: string; role_id: string }>;

    for (const row of rows) {
      const list = map.get(row.user_id);
      if (list) {
        list.push(row.role_id);
      } else {
        map.set(row.user_id, [row.role_id]);
      }
    }

    return map;
  }

  private toCurrentUser(row: UserRow, roleIds: string[]): CurrentUser {
    return {
      id: row.id,
      did: row.did,
      handle: row.handle,
      displayName: row.display_name,
      avatarUrl: row.avatar_url ?? undefined,
      roleIds,
      createdAt: row.created_at,
    };
  }
}
