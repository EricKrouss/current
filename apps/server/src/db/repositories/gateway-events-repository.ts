import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { nowIso } from '../../utils/time.js';

const RETAINED_GATEWAY_EVENTS = 5_000;
const GATEWAY_PRUNE_INTERVAL = 256;

export interface GatewayEventRecord {
  seq: number;
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class GatewayEventsRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  append(input: { eventId: string; type: string; payload: Record<string, unknown> }): number {
    this.db
      .prepare(
        `
      INSERT INTO gateway_events (event_id, type, payload, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(input.eventId, input.type, JSON.stringify(input.payload), nowIso());

    const row = this.db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
    const seq = row.id;
    if (seq % GATEWAY_PRUNE_INTERVAL === 0) {
      this.pruneBefore(seq - RETAINED_GATEWAY_EVENTS);
    }
    return seq;
  }

  listSince(seq: number, limit = 300): GatewayEventRecord[] {
    const rows = this.db
      .prepare(
        `
      SELECT seq, event_id, type, payload, created_at
      FROM gateway_events
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `,
      )
      .all(seq, limit) as Array<{
      seq: number;
      event_id: string;
      type: string;
      payload: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      seq: row.seq,
      eventId: row.event_id,
      type: row.type,
      payload: this.json<Record<string, unknown>>(row.payload),
      createdAt: row.created_at,
    }));
  }

  latestSeq(): number {
    const row = this.db.prepare('SELECT seq FROM gateway_events ORDER BY seq DESC LIMIT 1').get() as
      | { seq: number }
      | undefined;
    return row?.seq ?? 0;
  }

  private pruneBefore(cutoffSeq: number): void {
    if (cutoffSeq <= 0) {
      return;
    }

    this.db.prepare('DELETE FROM gateway_events WHERE seq < ?').run(cutoffSeq);
  }
}
