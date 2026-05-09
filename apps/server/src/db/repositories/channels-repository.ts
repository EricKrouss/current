import type { Channel, ChannelPermissionOverwrite, ChannelType, PageResponse, Permission } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';
import { encodeCursor } from '../../utils/cursor.js';

interface ChannelRow {
  id: string;
  server_id: string;
  category_id: string | null;
  name: string;
  type: ChannelType;
  topic: string | null;
  slowmode_seconds: number;
  locked: number;
  position: number;
  created_at: string;
}

type ChannelCursor = {
  position?: number;
  createdAt: string;
  id: string;
};

type ChannelUpdateInput = Partial<Omit<Channel, 'id' | 'serverId' | 'categoryId'>> & {
  categoryId?: string | null;
};

interface OverwriteRow {
  id: string;
  channel_id: string;
  target_type: 'role' | 'user';
  target_id: string;
  allow_permissions: string;
  deny_permissions: string;
}

export class ChannelsRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  listPage(input: {
    serverId: string;
    limit: number;
    after?: ChannelCursor;
  }): PageResponse<Channel> {
    const fetchLimit = input.limit + 1;
    const rows = input.after && typeof input.after.position === 'number'
      ? (this.db
          .prepare(
            `
          SELECT *
          FROM channels
          WHERE server_id = ?
            AND (
              position > ?
              OR (position = ? AND created_at > ?)
              OR (position = ? AND created_at = ? AND id > ?)
            )
          ORDER BY position ASC, created_at ASC, id ASC
          LIMIT ?
        `,
          )
          .all(
            input.serverId,
            input.after.position,
            input.after.position,
            input.after.createdAt,
            input.after.position,
            input.after.createdAt,
            input.after.id,
            fetchLimit,
          ) as unknown as ChannelRow[])
      : input.after
        ? (this.db
            .prepare(
              `
          SELECT *
          FROM channels
          WHERE server_id = ?
            AND (
              created_at > ?
              OR (created_at = ? AND id > ?)
            )
          ORDER BY created_at ASC, id ASC
          LIMIT ?
        `,
            )
            .all(
              input.serverId,
              input.after.createdAt,
              input.after.createdAt,
              input.after.id,
              fetchLimit,
            ) as unknown as ChannelRow[])
      : (this.db
          .prepare(
            `
          SELECT *
          FROM channels
          WHERE server_id = ?
          ORDER BY position ASC, created_at ASC, id ASC
          LIMIT ?
        `,
          )
          .all(input.serverId, fetchLimit) as unknown as ChannelRow[]);

    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const items = pageRows.map((row) => this.toChannel(row));
    const last = pageRows[pageRows.length - 1];

    return {
      items,
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                position: last.position,
                createdAt: last.created_at,
                id: last.id,
              })
            : undefined,
      },
    };
  }

  findById(channelId: string): Channel | null {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId) as
      | ChannelRow
      | undefined;
    return row ? this.toChannel(row) : null;
  }

  listAll(serverId: string): Channel[] {
    const rows = this.db
      .prepare(
        `
      SELECT *
      FROM channels
      WHERE server_id = ?
      ORDER BY position ASC, created_at ASC, id ASC
    `,
      )
      .all(serverId) as unknown as ChannelRow[];

    return rows.map((row) => this.toChannel(row));
  }

  create(input: {
    serverId: string;
    categoryId?: string | null;
    name: string;
    type: ChannelType;
    topic?: string;
    slowmodeSeconds?: number;
    position?: number;
  }): Channel {
    const channelId = id('chn');
    const channelType = input.type;
    const categoryId = channelType === 'category' ? null : input.categoryId ?? null;
    const position = input.position ?? this.nextPosition(input.serverId);
    this.db
      .prepare(
        `
      INSERT INTO channels (id, server_id, category_id, name, type, topic, slowmode_seconds, locked, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `,
      )
      .run(
        channelId,
        input.serverId,
        categoryId,
        input.name,
        channelType,
        input.topic ?? null,
        input.slowmodeSeconds ?? 0,
        position,
        nowIso(),
      );

    return this.findById(channelId)!;
  }

  update(channelId: string, input: ChannelUpdateInput): Channel | null {
    const existing = this.findById(channelId);
    if (!existing) {
      return null;
    }

    const type = input.type ?? existing.type;
    const merged = {
      categoryId:
        type === 'category'
          ? undefined
          : input.categoryId === undefined
            ? existing.categoryId
            : input.categoryId ?? undefined,
      name: input.name ?? existing.name,
      type,
      topic: input.topic ?? existing.topic,
      slowmodeSeconds: input.slowmodeSeconds ?? existing.slowmodeSeconds,
      locked: input.locked ?? existing.locked,
      position: input.position ?? existing.position,
    };

    if (existing.type === 'category' && merged.type !== 'category') {
      this.db.prepare('UPDATE channels SET category_id = NULL WHERE category_id = ?').run(channelId);
    }

    this.db
      .prepare(
        `
      UPDATE channels
      SET category_id = ?, name = ?, type = ?, topic = ?, slowmode_seconds = ?, locked = ?, position = ?
      WHERE id = ?
    `,
      )
      .run(
        merged.categoryId ?? null,
        merged.name,
        merged.type,
        merged.topic ?? null,
        merged.slowmodeSeconds,
        merged.locked ? 1 : 0,
        merged.position,
        channelId,
      );

    return this.findById(channelId);
  }

  delete(channelId: string): void {
    const existing = this.findById(channelId);
    this.db.exec('BEGIN');
    try {
      if (existing?.type === 'category') {
        this.db.prepare('UPDATE channels SET category_id = NULL WHERE category_id = ?').run(channelId);
      }

      this.db
        .prepare(
          `
        DELETE FROM reactions
        WHERE message_id IN (
          SELECT id FROM messages WHERE channel_id = ?
        )
      `,
        )
        .run(channelId);

      this.db
        .prepare(
          `
        DELETE FROM attachments
        WHERE message_id IN (
          SELECT id FROM messages WHERE channel_id = ?
        )
      `,
        )
        .run(channelId);

      this.db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
      this.db.prepare('DELETE FROM voice_states WHERE channel_id = ?').run(channelId);
      this.db.prepare('DELETE FROM invites WHERE channel_id = ?').run(channelId);
      this.db.prepare('DELETE FROM channel_overwrites WHERE channel_id = ?').run(channelId);
      this.db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updateLayout(
    serverId: string,
    items: Array<{ id: string; categoryId?: string | null; position: number }>,
  ): Channel[] {
    const update = this.db.prepare(
      `
      UPDATE channels
      SET category_id = ?, position = ?
      WHERE server_id = ? AND id = ?
    `,
    );

    this.db.exec('BEGIN');
    try {
      for (const item of items) {
        update.run(item.categoryId ?? null, item.position, serverId, item.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return this.listAll(serverId);
  }

  listOverwrites(channelId: string): ChannelPermissionOverwrite[] {
    const rows = this.db
      .prepare('SELECT * FROM channel_overwrites WHERE channel_id = ?')
      .all(channelId) as unknown as OverwriteRow[];

    return rows.map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      targetType: row.target_type,
      targetId: row.target_id,
      allow: this.json<Permission[]>(row.allow_permissions),
      deny: this.json<Permission[]>(row.deny_permissions),
    }));
  }

  upsertOverwrite(input: {
    channelId: string;
    targetType: 'role' | 'user';
    targetId: string;
    allow: Permission[];
    deny: Permission[];
  }): ChannelPermissionOverwrite {
    const existing = this.db
      .prepare(
        `
      SELECT id FROM channel_overwrites
      WHERE channel_id = ? AND target_type = ? AND target_id = ?
    `,
      )
      .get(input.channelId, input.targetType, input.targetId) as { id: string } | undefined;

    const overwriteId = existing?.id ?? id('ovr');

    this.db
      .prepare(
        `
      INSERT INTO channel_overwrites (id, channel_id, target_type, target_id, allow_permissions, deny_permissions)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        allow_permissions = excluded.allow_permissions,
        deny_permissions = excluded.deny_permissions
    `,
      )
      .run(
        overwriteId,
        input.channelId,
        input.targetType,
        input.targetId,
        JSON.stringify(input.allow),
        JSON.stringify(input.deny),
      );

    return {
      id: overwriteId,
      channelId: input.channelId,
      targetType: input.targetType,
      targetId: input.targetId,
      allow: input.allow,
      deny: input.deny,
    };
  }

  replaceOverwrites(channelId: string, overwrites: Array<{
    targetType: 'role' | 'user';
    targetId: string;
    allow: Permission[];
    deny: Permission[];
  }>): ChannelPermissionOverwrite[] {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM channel_overwrites WHERE channel_id = ?').run(channelId);
      const next = overwrites.map((overwrite) => this.upsertOverwrite({
        channelId,
        ...overwrite,
      }));
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteOverwrite(overwriteId: string): void {
    this.db.prepare('DELETE FROM channel_overwrites WHERE id = ?').run(overwriteId);
  }

  private toChannel(row: ChannelRow): Channel {
    return {
      id: row.id,
      serverId: row.server_id,
      categoryId: row.category_id ?? undefined,
      name: row.name,
      type: row.type,
      topic: row.topic ?? undefined,
      slowmodeSeconds: row.slowmode_seconds,
      locked: Boolean(row.locked),
      position: row.position,
    };
  }

  private nextPosition(serverId: string): number {
    const row = this.db
      .prepare('SELECT MAX(position) as position FROM channels WHERE server_id = ?')
      .get(serverId) as { position: number | null } | undefined;
    return (row?.position ?? 0) + 1000;
  }
}
