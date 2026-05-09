import type { CurrentServer, RegistrationMode } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';

export class ServerRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  getPrimaryServer(): CurrentServer | null {
    const row = this.db.prepare('SELECT * FROM servers ORDER BY created_at ASC LIMIT 1').get() as
      | {
          id: string;
          name: string;
          slug: string;
          registration_mode: RegistrationMode;
          icon_attachment_id: string | null;
          banner_attachment_id: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      registrationMode: row.registration_mode,
      iconAttachmentId: row.icon_attachment_id ?? undefined,
      bannerAttachmentId: row.banner_attachment_id ?? undefined,
      iconUrl: row.icon_attachment_id ? `/api/v1/media/attachments/${row.icon_attachment_id}` : undefined,
      bannerUrl: row.banner_attachment_id ? `/api/v1/media/attachments/${row.banner_attachment_id}` : undefined,
      createdAt: row.created_at,
    };
  }

  create(input: { name: string; slug: string; registrationMode: RegistrationMode }): CurrentServer {
    const serverId = id('srv');
    const createdAt = nowIso();

    this.db
      .prepare(
        `
      INSERT INTO servers (id, name, slug, registration_mode, icon_attachment_id, banner_attachment_id, created_at)
      VALUES (?, ?, ?, ?, NULL, NULL, ?)
    `,
      )
      .run(serverId, input.name, input.slug, input.registrationMode, createdAt);

    return {
      id: serverId,
      name: input.name,
      slug: input.slug,
      registrationMode: input.registrationMode,
      createdAt,
    };
  }

  update(serverId: string, input: Partial<{
    name: string;
    slug: string;
    registrationMode: RegistrationMode;
    iconAttachmentId: string | null;
    bannerAttachmentId: string | null;
  }>): CurrentServer | null {
    const existing = this.getPrimaryServer();
    if (!existing || existing.id !== serverId) {
      return null;
    }

    const next = {
      name: input.name ?? existing.name,
      slug: input.slug ?? existing.slug,
      registrationMode: input.registrationMode ?? existing.registrationMode,
      iconAttachmentId:
        input.iconAttachmentId === undefined ? existing.iconAttachmentId ?? null : input.iconAttachmentId,
      bannerAttachmentId:
        input.bannerAttachmentId === undefined ? existing.bannerAttachmentId ?? null : input.bannerAttachmentId,
    };

    this.db
      .prepare(
        `
      UPDATE servers
      SET name = ?, slug = ?, registration_mode = ?, icon_attachment_id = ?, banner_attachment_id = ?
      WHERE id = ?
    `,
      )
      .run(
        next.name,
        next.slug,
        next.registrationMode,
        next.iconAttachmentId,
        next.bannerAttachmentId,
        serverId,
      );

    return this.getPrimaryServer();
  }

  updateRegistrationMode(serverId: string, registrationMode: RegistrationMode): void {
    this.update(serverId, { registrationMode });
  }
}
