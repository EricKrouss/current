import type { Message } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';

export type CurrentNotificationKind = 'current_mention' | 'current_reply';

export interface CurrentMessageNotificationPayload {
  mentionHandles?: string[];
  replyToUserId?: string;
}

export interface CurrentNotificationEventPayload {
  message: Message;
  notification?: CurrentMessageNotificationPayload;
}

export interface CurrentNotificationEventRecord {
  seq: number;
  eventId: string;
  userId: string;
  serverId: string;
  channelId: string;
  messageId: string;
  kind: CurrentNotificationKind;
  payload: CurrentNotificationEventPayload;
  createdAt: string;
}

interface NotificationEventRow {
  gateway_seq: number;
  event_id: string;
  user_id: string;
  server_id: string;
  channel_id: string;
  message_id: string;
  kind: string;
  payload: string;
  created_at: string;
}

function coerceKind(value: string): CurrentNotificationKind {
  return value === 'current_reply' ? 'current_reply' : 'current_mention';
}

export class NotificationEventsRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  append(input: {
    gatewaySeq: number;
    userId: string;
    serverId: string;
    channelId: string;
    messageId: string;
    kind: CurrentNotificationKind;
    payload: CurrentNotificationEventPayload;
  }): void {
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO notification_events (
          gateway_seq,
          event_id,
          user_id,
          server_id,
          channel_id,
          message_id,
          kind,
          payload,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.gatewaySeq,
        id('ntf_evt'),
        input.userId,
        input.serverId,
        input.channelId,
        input.messageId,
        input.kind,
        JSON.stringify(input.payload),
        nowIso(),
      );
  }

  listForUserSince(input: {
    userId: string;
    afterSeq: number;
    limit: number;
  }): CurrentNotificationEventRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          gateway_seq,
          event_id,
          user_id,
          server_id,
          channel_id,
          message_id,
          kind,
          payload,
          created_at
        FROM notification_events
        WHERE user_id = ?
          AND gateway_seq > ?
        ORDER BY gateway_seq ASC, seq ASC
        LIMIT ?
      `,
      )
      .all(input.userId, input.afterSeq, input.limit) as unknown as NotificationEventRow[];

    return rows.map((row) => ({
      seq: row.gateway_seq,
      eventId: row.event_id,
      userId: row.user_id,
      serverId: row.server_id,
      channelId: row.channel_id,
      messageId: row.message_id,
      kind: coerceKind(row.kind),
      payload: this.json<CurrentNotificationEventPayload>(row.payload),
      createdAt: row.created_at,
    }));
  }
}
