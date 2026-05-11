import type {
  ServerAccessRequest,
  ServerAccessRequestSource,
  ServerAccessRequestStatus,
} from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';

interface AccessRequestRow {
  id: string;
  server_id: string;
  user_id: string;
  status: string;
  notifications_enabled: number;
  source: string;
  requested_at: string;
  updated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  user_did?: string | null;
  user_handle?: string | null;
  user_display_name?: string | null;
  user_avatar_url?: string | null;
  user_bio?: string | null;
}

const VALID_STATUSES = new Set<ServerAccessRequestStatus>(['pending', 'approved', 'denied']);
const VALID_SOURCES = new Set<ServerAccessRequestSource>(['browser', 'gaia_launcher', 'unknown']);

function normalizeStatus(value: string): ServerAccessRequestStatus {
  return VALID_STATUSES.has(value as ServerAccessRequestStatus)
    ? (value as ServerAccessRequestStatus)
    : 'pending';
}

function normalizeSource(value: string): ServerAccessRequestSource {
  return VALID_SOURCES.has(value as ServerAccessRequestSource)
    ? (value as ServerAccessRequestSource)
    : 'unknown';
}

export class AccessRequestsRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  get(serverId: string, userId: string): ServerAccessRequest | null {
    const row = this.baseSelect('WHERE access_requests.server_id = ? AND access_requests.user_id = ?').get(
      serverId,
      userId,
    ) as AccessRequestRow | undefined;
    return row ? this.toRequest(row) : null;
  }

  list(serverId: string, status?: ServerAccessRequestStatus): ServerAccessRequest[] {
    const where = status
      ? 'WHERE access_requests.server_id = ? AND access_requests.status = ?'
      : 'WHERE access_requests.server_id = ?';
    const rows = (status
      ? this.baseSelect(`${where} ORDER BY access_requests.requested_at DESC`).all(serverId, status)
      : this.baseSelect(`${where} ORDER BY access_requests.requested_at DESC`).all(serverId)) as unknown as AccessRequestRow[];
    return rows.map((row) => this.toRequest(row));
  }

  upsertPending(input: {
    serverId: string;
    userId: string;
    notificationsEnabled: boolean;
    source: ServerAccessRequestSource;
  }): ServerAccessRequest {
    const existing = this.get(input.serverId, input.userId);
    if (existing?.status === 'approved' || existing?.status === 'denied') {
      return existing;
    }

    const ts = nowIso();
    if (existing) {
      this.db
        .prepare(
          `
          UPDATE access_requests
          SET notifications_enabled = ?,
              source = ?,
              updated_at = ?
          WHERE server_id = ? AND user_id = ?
        `,
        )
        .run(input.notificationsEnabled ? 1 : 0, input.source, ts, input.serverId, input.userId);
      return this.get(input.serverId, input.userId)!;
    }

    this.db
      .prepare(
        `
        INSERT INTO access_requests (
          id,
          server_id,
          user_id,
          status,
          notifications_enabled,
          source,
          requested_at,
          updated_at
        )
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
      `,
      )
      .run(id('acc_req'), input.serverId, input.userId, input.notificationsEnabled ? 1 : 0, input.source, ts, ts);

    return this.get(input.serverId, input.userId)!;
  }

  setNotifications(input: {
    serverId: string;
    userId: string;
    notificationsEnabled: boolean;
  }): ServerAccessRequest | null {
    this.db
      .prepare(
        `
        UPDATE access_requests
        SET notifications_enabled = ?,
            updated_at = ?
        WHERE server_id = ? AND user_id = ?
      `,
      )
      .run(input.notificationsEnabled ? 1 : 0, nowIso(), input.serverId, input.userId);
    return this.get(input.serverId, input.userId);
  }

  setStatus(input: {
    serverId: string;
    userId: string;
    status: ServerAccessRequestStatus;
    reviewedBy?: string;
    notificationsEnabled?: boolean;
    source?: ServerAccessRequestSource;
  }): ServerAccessRequest {
    const existing = this.get(input.serverId, input.userId);
    const ts = nowIso();
    const reviewedBy = input.reviewedBy ?? null;
    const reviewedAt = input.status === 'pending' ? null : ts;
    const notificationsEnabled = input.notificationsEnabled ?? existing?.notificationsEnabled ?? false;

    if (existing) {
      this.db
        .prepare(
          `
          UPDATE access_requests
          SET status = ?,
              notifications_enabled = ?,
              source = ?,
              updated_at = ?,
              reviewed_by = ?,
              reviewed_at = ?
          WHERE server_id = ? AND user_id = ?
        `,
        )
        .run(
          input.status,
          notificationsEnabled ? 1 : 0,
          input.source ?? existing.source,
          ts,
          reviewedBy,
          reviewedAt,
          input.serverId,
          input.userId,
        );
      return this.get(input.serverId, input.userId)!;
    }

    this.db
      .prepare(
        `
        INSERT INTO access_requests (
          id,
          server_id,
          user_id,
          status,
          notifications_enabled,
          source,
          requested_at,
          updated_at,
          reviewed_by,
          reviewed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id('acc_req'),
        input.serverId,
        input.userId,
        input.status,
        input.notificationsEnabled ? 1 : 0,
        input.source ?? 'unknown',
        ts,
        ts,
        reviewedBy,
        reviewedAt,
      );

    return this.get(input.serverId, input.userId)!;
  }

  delete(serverId: string, userId: string): void {
    this.db
      .prepare('DELETE FROM access_requests WHERE server_id = ? AND user_id = ?')
      .run(serverId, userId);
  }

  private baseSelect(whereSql: string) {
    return this.db.prepare(`
      SELECT
        access_requests.*,
        users.did AS user_did,
        users.handle AS user_handle,
        users.display_name AS user_display_name,
        users.avatar_url AS user_avatar_url,
        users.bio AS user_bio
      FROM access_requests
      LEFT JOIN users ON users.id = access_requests.user_id
      ${whereSql}
    `);
  }

  private toRequest(row: AccessRequestRow): ServerAccessRequest {
    return {
      id: row.id,
      serverId: row.server_id,
      userId: row.user_id,
      status: normalizeStatus(row.status),
      notificationsEnabled: Boolean(row.notifications_enabled),
      source: normalizeSource(row.source),
      requestedAt: row.requested_at,
      updatedAt: row.updated_at,
      reviewedBy: row.reviewed_by ?? undefined,
      reviewedAt: row.reviewed_at ?? undefined,
      user: row.user_did
        ? {
            id: row.user_id,
            did: row.user_did,
            handle: row.user_handle ?? row.user_did,
            displayName: row.user_display_name ?? row.user_handle ?? row.user_did,
            avatarUrl: row.user_avatar_url ?? undefined,
            bio: row.user_bio ?? undefined,
          }
        : undefined,
    };
  }
}
