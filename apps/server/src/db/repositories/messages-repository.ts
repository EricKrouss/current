import type { Attachment, EncryptedMessageContent, Message, MessageReaction, PageResponse } from '@current/types';
import type { DatabaseSync } from 'node:sqlite';
import { BaseRepository } from './base-repository.js';
import { id } from '../../utils/id.js';
import { nowIso } from '../../utils/time.js';
import { encodeCursor } from '../../utils/cursor.js';

interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  encrypted_content: string | null;
  parent_message_id: string | null;
  gif_url: string | null;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

interface AttachmentRow {
  id: string;
  message_id: string | null;
  file_name: string;
  mime_type: string;
  byte_size: number;
  path: string;
}

interface ReactionAggregateRow {
  message_id: string;
  emoji: string;
  count: number;
  user_ids: string | null;
}

export class MessagesRepository extends BaseRepository {
  constructor(db: DatabaseSync) {
    super(db);
  }

  listByChannelPage(input: {
    channelId: string;
    limit: number;
    before?: { createdAt: string; id: string };
    identityMode?: 'all' | 'lan' | 'atproto';
  }): PageResponse<Message> {
    const fetchLimit = input.limit + 1;
    const identityFilterSql =
      input.identityMode === 'lan'
        ? "AND author_id IN (SELECT id FROM users WHERE did LIKE 'did:current:lan:%')"
        : input.identityMode === 'atproto'
          ? "AND author_id IN (SELECT id FROM users WHERE did NOT LIKE 'did:current:lan:%')"
          : '';
    const rows = input.before
      ? (this.db
          .prepare(
            `
          SELECT *
          FROM messages
          WHERE channel_id = ?
            AND deleted_at IS NULL
            ${identityFilterSql}
            AND (
              created_at < ?
              OR (created_at = ? AND id < ?)
            )
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
          )
          .all(
            input.channelId,
            input.before.createdAt,
            input.before.createdAt,
            input.before.id,
            fetchLimit,
          ) as unknown as MessageRow[])
      : (this.db
          .prepare(
            `
          SELECT *
          FROM messages
          WHERE channel_id = ? AND deleted_at IS NULL
          ${identityFilterSql}
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
          )
          .all(input.channelId, fetchLimit) as unknown as MessageRow[]);

    const hasMore = rows.length > input.limit;
    const pageRowsDescending = hasMore ? rows.slice(0, input.limit) : rows;
    const pageRowsAscending = pageRowsDescending.reverse();
    const items = this.toMessages(pageRowsAscending);
    const oldest = pageRowsAscending[0];

    return {
      items,
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && oldest
            ? encodeCursor({
                createdAt: oldest.created_at,
                id: oldest.id,
              })
            : undefined,
      },
    };
  }

  searchByChannel(input: {
    channelId: string;
    query?: string;
    limit: number;
    authorId?: string;
    identityMode?: 'all' | 'lan' | 'atproto';
  }): Message[] {
    const normalizedQuery = input.query?.trim();
    const params: string[] = [input.channelId];
    const where: string[] = ['channel_id = ?', 'deleted_at IS NULL'];

    if (input.authorId) {
      where.push('author_id = ?');
      params.push(input.authorId);
    }

    if (input.identityMode === 'lan') {
      where.push(`author_id IN (SELECT id FROM users WHERE did LIKE 'did:current:lan:%')`);
    } else if (input.identityMode === 'atproto') {
      where.push(`author_id IN (SELECT id FROM users WHERE did NOT LIKE 'did:current:lan:%')`);
    }

    if (normalizedQuery && normalizedQuery.length > 0) {
      where.push(`(
        LOWER(id) LIKE LOWER(?)
        OR LOWER(content) LIKE LOWER(?)
        OR LOWER(COALESCE(gif_url, '')) LIKE LOWER(?)
      )`);
      params.push(`%${normalizedQuery}%`, `%${normalizedQuery}%`, `%${normalizedQuery}%`);
    }

    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM messages
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
      )
      .all(...params, input.limit) as unknown as MessageRow[];

    return this.toMessages(rows);
  }

  searchInServer(input: {
    serverId: string;
    query?: string;
    limit: number;
    authorId?: string;
    channelId?: string;
    identityMode?: 'all' | 'lan' | 'atproto';
  }): Message[] {
    const normalizedQuery = input.query?.trim();
    const params: string[] = [input.serverId];
    const where: string[] = ['channels.server_id = ?', 'messages.deleted_at IS NULL'];

    if (input.channelId) {
      where.push('messages.channel_id = ?');
      params.push(input.channelId);
    }

    if (input.authorId) {
      where.push('messages.author_id = ?');
      params.push(input.authorId);
    }

    if (input.identityMode === 'lan') {
      where.push(`users.did LIKE 'did:current:lan:%'`);
    } else if (input.identityMode === 'atproto') {
      where.push(`users.did NOT LIKE 'did:current:lan:%'`);
    }

    if (normalizedQuery && normalizedQuery.length > 0) {
      where.push(`(
        LOWER(messages.id) LIKE LOWER(?)
        OR LOWER(messages.content) LIKE LOWER(?)
        OR LOWER(COALESCE(messages.gif_url, '')) LIKE LOWER(?)
      )`);
      params.push(`%${normalizedQuery}%`, `%${normalizedQuery}%`, `%${normalizedQuery}%`);
    }

    const rows = this.db
      .prepare(
        `
          SELECT messages.*
          FROM messages
          INNER JOIN channels ON channels.id = messages.channel_id
          INNER JOIN users ON users.id = messages.author_id
          WHERE ${where.join(' AND ')}
          ORDER BY messages.created_at DESC, messages.id DESC
          LIMIT ?
        `,
      )
      .all(...params, input.limit) as unknown as MessageRow[];

    return this.toMessages(rows);
  }

  create(input: {
    channelId: string;
    authorId: string;
    content: string;
    encryptedContent?: EncryptedMessageContent;
    parentMessageId?: string;
    gifUrl?: string;
    attachments?: Attachment[];
  }): Message {
    const messageId = id('msg');
    const createdAt = nowIso();

    this.db
      .prepare(
        `
      INSERT INTO messages (id, channel_id, author_id, content, encrypted_content, parent_message_id, gif_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        messageId,
        input.channelId,
        input.authorId,
        input.content,
        input.encryptedContent ? JSON.stringify(input.encryptedContent) : null,
        input.parentMessageId ?? null,
        input.gifUrl ?? null,
        createdAt,
      );

    for (const attachment of input.attachments ?? []) {
      this.attachToMessage(attachment, messageId);
    }

    return {
      id: messageId,
      channelId: input.channelId,
      authorId: input.authorId,
      content: input.content,
      encryptedContent: input.encryptedContent,
      parentMessageId: input.parentMessageId,
      gifUrl: input.gifUrl,
      attachments: input.attachments ?? [],
      createdAt,
      reactions: [],
    };
  }

  findById(messageId: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
      | MessageRow
      | undefined;
    return row ? this.toMessage(row) : null;
  }

  edit(messageId: string, input: { content: string; encryptedContent?: EncryptedMessageContent }): Message | null {
    this.db
      .prepare(
        `
      UPDATE messages
      SET content = ?, encrypted_content = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `,
      )
      .run(
        input.content,
        input.encryptedContent ? JSON.stringify(input.encryptedContent) : null,
        nowIso(),
        messageId,
      );

    return this.findById(messageId);
  }

  softDelete(messageId: string): Message | null {
    this.db
      .prepare(
        `
      UPDATE messages
      SET deleted_at = ?
      WHERE id = ?
    `,
      )
      .run(nowIso(), messageId);

    return this.findById(messageId);
  }

  toggleReaction(input: { messageId: string; userId: string; emoji: string }): { message: Message | null; added: boolean } {
    const existing = this.db
      .prepare('SELECT id FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .get(input.messageId, input.userId, input.emoji) as { id: string } | undefined;

    if (existing) {
      this.db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
      return {
        message: this.findById(input.messageId),
        added: false,
      };
    }

    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO reactions (id, message_id, user_id, emoji, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(id('rct'), input.messageId, input.userId, input.emoji, nowIso());

    return {
      message: this.findById(input.messageId),
      added: true,
    };
  }

  findAttachmentById(attachmentId: string): Attachment | null {
    const row = this.db
      .prepare('SELECT id, file_name, mime_type, byte_size, path FROM attachments WHERE id = ?')
      .get(attachmentId) as AttachmentRow | undefined;
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      path: row.path,
    };
  }

  recordUploadedAttachment(input: {
    fileName: string;
    mimeType: string;
    byteSize: number;
    path: string;
  }): Attachment {
    const attachmentId = id('att');
    this.db
      .prepare(
        `
      INSERT INTO attachments (id, message_id, file_name, mime_type, byte_size, path, created_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?)
    `,
      )
      .run(attachmentId, input.fileName, input.mimeType, input.byteSize, input.path, nowIso());

    return {
      id: attachmentId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      path: input.path,
    };
  }

  private attachToMessage(attachment: Attachment, messageId: string): void {
    this.db
      .prepare(
        `
      UPDATE attachments
      SET message_id = ?
      WHERE id = ?
    `,
      )
      .run(messageId, attachment.id);
  }

  private loadAttachments(messageId: string): Attachment[] {
    const rows = this.db
      .prepare('SELECT id, file_name, mime_type, byte_size, path FROM attachments WHERE message_id = ?')
      .all(messageId) as unknown as AttachmentRow[];

    return rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      path: row.path,
    }));
  }

  private loadAttachmentsForMessages(messageIds: string[]): Map<string, Attachment[]> {
    const map = new Map<string, Attachment[]>();
    for (const messageId of messageIds) {
      map.set(messageId, []);
    }
    if (messageIds.length === 0) {
      return map;
    }

    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `
          SELECT id, message_id, file_name, mime_type, byte_size, path
          FROM attachments
          WHERE message_id IN (${placeholders})
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(...messageIds) as unknown as AttachmentRow[];

    for (const row of rows) {
      if (!row.message_id) {
        continue;
      }

      const attachments = map.get(row.message_id);
      if (!attachments) {
        continue;
      }

      attachments.push({
        id: row.id,
        fileName: row.file_name,
        mimeType: row.mime_type,
        byteSize: row.byte_size,
        path: row.path,
      });
    }

    return map;
  }

  private loadReactions(messageId: string): MessageReaction[] {
    const rows = this.db
      .prepare(
        `
          SELECT message_id, emoji, COUNT(*) AS count, GROUP_CONCAT(user_id) AS user_ids
          FROM reactions
          WHERE message_id = ?
          GROUP BY message_id, emoji
          ORDER BY MIN(created_at) ASC, emoji ASC
        `,
      )
      .all(messageId) as unknown as ReactionAggregateRow[];

    return rows.map((row) => ({
      emoji: row.emoji,
      count: row.count,
      userIds: row.user_ids ? row.user_ids.split(',').filter(Boolean) : [],
    }));
  }

  private loadReactionsForMessages(messageIds: string[]): Map<string, MessageReaction[]> {
    const map = new Map<string, MessageReaction[]>();
    for (const messageId of messageIds) {
      map.set(messageId, []);
    }
    if (messageIds.length === 0) {
      return map;
    }

    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `
          SELECT message_id, emoji, COUNT(*) AS count, GROUP_CONCAT(user_id) AS user_ids
          FROM reactions
          WHERE message_id IN (${placeholders})
          GROUP BY message_id, emoji
          ORDER BY message_id ASC, MIN(created_at) ASC, emoji ASC
        `,
      )
      .all(...messageIds) as unknown as ReactionAggregateRow[];

    for (const row of rows) {
      const reactions = map.get(row.message_id);
      if (!reactions) {
        continue;
      }

      reactions.push({
        emoji: row.emoji,
        count: row.count,
        userIds: row.user_ids ? row.user_ids.split(',').filter(Boolean) : [],
      });
    }

    return map;
  }

  private toMessages(rows: MessageRow[]): Message[] {
    const messageIds = rows.map((row) => row.id);
    const attachments = this.loadAttachmentsForMessages(messageIds);
    const reactions = this.loadReactionsForMessages(messageIds);

    return rows.map((row) =>
      this.toMessage(
        row,
        attachments.get(row.id) ?? [],
        reactions.get(row.id) ?? [],
      ),
    );
  }

  private toMessage(row: MessageRow, attachments?: Attachment[], reactions?: MessageReaction[]): Message {
    return {
      id: row.id,
      channelId: row.channel_id,
      authorId: row.author_id,
      content: row.content,
      encryptedContent: this.parseEncryptedContent(row.encrypted_content),
      parentMessageId: row.parent_message_id ?? undefined,
      gifUrl: row.gif_url ?? undefined,
      attachments: attachments ?? this.loadAttachments(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
      deletedAt: row.deleted_at ?? undefined,
      reactions: reactions ?? this.loadReactions(row.id),
    };
  }

  private parseEncryptedContent(raw: string | null): EncryptedMessageContent | undefined {
    if (!raw) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<EncryptedMessageContent>;
      if (
        parsed.version !== 1 ||
        parsed.algorithm !== 'AES-GCM' ||
        typeof parsed.keyId !== 'string' ||
        typeof parsed.nonce !== 'string' ||
        typeof parsed.ciphertext !== 'string'
      ) {
        return undefined;
      }
      return {
        version: 1,
        algorithm: 'AES-GCM',
        keyId: parsed.keyId,
        nonce: parsed.nonce,
        ciphertext: parsed.ciphertext,
      };
    } catch {
      return undefined;
    }
  }
}
