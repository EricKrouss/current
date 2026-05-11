import type { DatabaseSync } from 'node:sqlite';

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      registration_mode TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      did TEXT NOT NULL UNIQUE,
      handle TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      bio TEXT,
      selected_presence_status TEXT NOT NULL DEFAULT 'online',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_ip_activity (
      user_id TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, ip_address),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      position INTEGER NOT NULL,
      permissions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (role_id) REFERENCES roles(id)
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      category_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      topic TEXT,
      slowmode_seconds INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS channel_overwrites (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      allow_permissions TEXT NOT NULL,
      deny_permissions TEXT NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      parent_message_id TEXT,
      gif_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      deleted_at TEXT,
      FOREIGN KEY (channel_id) REFERENCES channels(id),
      FOREIGN KEY (author_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      channel_id TEXT,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (server_id) REFERENCES servers(id),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS access_requests (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      notifications_enabled INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'browser',
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_by TEXT,
      reviewed_at TEXT,
      UNIQUE(server_id, user_id),
      FOREIGN KEY (server_id) REFERENCES servers(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (reviewed_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS automod_rules (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS moderation_actions (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      reason TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS voice_states (
      user_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      muted INTEGER NOT NULL DEFAULT 0,
      deafened INTEGER NOT NULL DEFAULT 0,
      push_to_talk INTEGER NOT NULL DEFAULT 0,
      speaking INTEGER NOT NULL DEFAULT 0,
      connected_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (channel_id) REFERENCES channels(id)
    );

    CREATE TABLE IF NOT EXISTS gateway_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_channel_created_id_not_deleted
      ON messages(channel_id, created_at DESC, id DESC)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_attachments_message_created
      ON attachments(message_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_reactions_message_created
      ON reactions(message_id, created_at ASC, emoji ASC);
    CREATE INDEX IF NOT EXISTS idx_channels_server_created_id ON channels(server_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_users_display_handle_id
      ON users(display_name COLLATE NOCASE, handle COLLATE NOCASE, id ASC);
    CREATE INDEX IF NOT EXISTS idx_user_roles_role_user ON user_roles(role_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_moderation_server_target_type_created
      ON moderation_actions(server_id, target_user_id, type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gateway_events_seq ON gateway_events(seq);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_ip_address ON user_ip_activity(ip_address, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_access_requests_server_status_requested
      ON access_requests(server_id, status, requested_at DESC);
  `);

  db.exec(`
    DELETE FROM reactions
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM reactions
      GROUP BY message_id, user_id, emoji
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_reactions_message_user_emoji
      ON reactions(message_id, user_id, emoji);
  `);

  const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  if (!messageColumns.some((column) => column.name === 'encrypted_content')) {
    db.exec('ALTER TABLE messages ADD COLUMN encrypted_content TEXT;');
  }

  const channelColumns = db.prepare('PRAGMA table_info(channels)').all() as Array<{ name: string }>;
  if (!channelColumns.some((column) => column.name === 'position')) {
    db.exec('ALTER TABLE channels ADD COLUMN position INTEGER NOT NULL DEFAULT 0;');
    const rows = db
      .prepare('SELECT id FROM channels ORDER BY created_at ASC, id ASC')
      .all() as Array<{ id: string }>;
    const update = db.prepare('UPDATE channels SET position = ? WHERE id = ?');

    db.exec('BEGIN');
    try {
      rows.forEach((row, index) => {
        update.run((index + 1) * 1000, row.id);
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_channels_server_position_created_id
      ON channels(server_id, position ASC, created_at ASC, id ASC);
  `);

  const serverColumns = db.prepare('PRAGMA table_info(servers)').all() as Array<{ name: string }>;
  if (!serverColumns.some((column) => column.name === 'icon_attachment_id')) {
    db.exec('ALTER TABLE servers ADD COLUMN icon_attachment_id TEXT;');
  }
  if (!serverColumns.some((column) => column.name === 'banner_attachment_id')) {
    db.exec('ALTER TABLE servers ADD COLUMN banner_attachment_id TEXT;');
  }

  const userColumns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === 'bio')) {
    db.exec('ALTER TABLE users ADD COLUMN bio TEXT;');
  }
  if (!userColumns.some((column) => column.name === 'selected_presence_status')) {
    db.exec("ALTER TABLE users ADD COLUMN selected_presence_status TEXT NOT NULL DEFAULT 'online';");
  }

  const attachmentColumns = db.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>;
  if (!attachmentColumns.some((column) => column.name === 'owner_user_id')) {
    db.exec('ALTER TABLE attachments ADD COLUMN owner_user_id TEXT;');
  }

  const roles = db.prepare('SELECT id, permissions FROM roles').all() as Array<{ id: string; permissions: string }>;
  const updateRolePermissions = db.prepare('UPDATE roles SET permissions = ? WHERE id = ?');
  for (const role of roles) {
    let permissions: unknown;
    try {
      permissions = JSON.parse(role.permissions);
    } catch {
      continue;
    }
    if (!Array.isArray(permissions) || permissions.includes('VIEW_CHANNEL')) {
      continue;
    }
    updateRolePermissions.run(JSON.stringify(['VIEW_CHANNEL', ...permissions]), role.id);
  }
}
