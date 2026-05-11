import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

function tableCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

describe('admin settings and insights', () => {
  it('requires MANAGE_SERVER and supports settings, ownership transfer, and shared-ip insights', async () => {
    const { app, db, context, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Admin Server',
        slug: 'admin-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);
    const { serverId } = bootstrapResponse.json() as { serverId: string };

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_admin',
      'did:plc:admin',
      'admin.bsky.social',
      'Admin User',
      null,
      nowIso(),
      nowIso(),
      'usr_member',
      'did:plc:member',
      'member.bsky.social',
      'Member User',
      null,
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `,
    ).run(
      'admin_session',
      'usr_admin',
      addHours(1),
      nowIso(),
      'member_session',
      'usr_member',
      addHours(1),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO roles (id, server_id, name, color, position, permissions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'rol_manage_server',
      serverId,
      'Server Admin',
      '#30b4ff',
      90,
      JSON.stringify(['MANAGE_SERVER']),
      nowIso(),
    );

    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run('usr_admin', 'rol_manage_server');

    const deniedRegistrationMode = await app.inject({
      method: 'PATCH',
      url: '/api/v1/server/registration-mode',
      cookies: {
        current_session: 'member_session',
      },
      payload: {
        registrationMode: 'open_signup',
      },
    });
    expect(deniedRegistrationMode.statusCode).toBe(403);

    const allowedRegistrationMode = await app.inject({
      method: 'PATCH',
      url: '/api/v1/server/registration-mode',
      cookies: {
        current_session: 'admin_session',
      },
      payload: {
        registrationMode: 'manual_approval',
      },
    });
    expect(allowedRegistrationMode.statusCode).toBe(200);

    const deniedSettings = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'member_session',
      },
    });
    expect(deniedSettings.statusCode).toBe(403);

    const allowedSettings = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'admin_session',
      },
    });
    expect(allowedSettings.statusCode).toBe(200);
    const allowedPayload = allowedSettings.json() as {
      auth: { mode: string };
      media: {
        gifProvider: string;
        gifFallbackProvider: string;
        klipyApiKey?: string;
        giphyApiKey?: string;
        klipyApiKeyConfigured: boolean;
        giphyApiKeyConfigured: boolean;
      };
      config: { media: { gifProvider: string; gifFallbackProvider: string; klipyApiKeyConfigured: boolean; giphyApiKeyConfigured: boolean } };
    };
    expect(allowedPayload.auth.mode).toBe('atproto');
    expect(allowedPayload.media.gifProvider).toBe('klipy');
    expect(allowedPayload.media.gifFallbackProvider).toBe('none');
    expect(allowedPayload.media.klipyApiKey).toBeUndefined();
    expect(allowedPayload.media.giphyApiKey).toBeUndefined();
    expect(allowedPayload.config.media.klipyApiKeyConfigured).toBe(true);
    expect(allowedPayload.config.media.giphyApiKeyConfigured).toBe(false);

    const icon = context.chat.saveAttachment({
      fileName: 'server-icon.png',
      mimeType: 'image/png',
      bytes: Buffer.from('fake-png'),
    });
    const messagesBackground = context.chat.saveAttachment({
      fileName: 'messages-background.png',
      mimeType: 'image/png',
      bytes: Buffer.from('fake-background-png'),
    });

    const patchSettings = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'admin_session',
      },
      payload: {
        klipyApiKey: 'new-test-key',
        giphyApiKey: 'giphy-test-key',
        server: {
          name: 'Renamed Admin Server',
          host: '127.0.0.1',
          registrationMode: 'manual_approval',
          iconAttachmentId: icon.id,
        },
        auth: {
          mode: 'lan',
        },
        media: {
          gifProvider: 'giphy',
          gifFallbackProvider: 'klipy',
        },
        appearance: {
          backgroundAttachmentId: messagesBackground.id,
          ownMessageColor: '#6effbf',
          otherMessageColor: '#30b4ff',
        },
      },
    });
    expect(patchSettings.statusCode).toBe(200);
    const patched = patchSettings.json() as {
      media: {
        gifProvider: string;
        gifFallbackProvider: string;
        klipyApiKey?: string;
        giphyApiKey?: string;
        klipyApiKeyConfigured: boolean;
        giphyApiKeyConfigured: boolean;
      };
      server: { name: string; registrationMode: string; iconAttachmentId?: string };
      config: {
        appearance: {
          background: { attachmentId?: string; url?: string };
          ownMessageColor: string;
          otherMessageColor: string;
        };
      };
      auth: { mode: string };
      restartRequiredFields: string[];
    };
    expect(patched.media.gifProvider).toBe('giphy');
    expect(patched.media.gifFallbackProvider).toBe('klipy');
    expect(patched.media.klipyApiKey).toBeUndefined();
    expect(patched.media.giphyApiKey).toBeUndefined();
    expect(patched.media.klipyApiKeyConfigured).toBe(true);
    expect(patched.media.giphyApiKeyConfigured).toBe(true);
    expect(context.serverConfig.get().media.klipyApiKey).toBe('new-test-key');
    expect(context.serverConfig.get().media.giphyApiKey).toBe('giphy-test-key');
    expect(context.serverConfig.get().media.gifProvider).toBe('giphy');
    expect(context.serverConfig.get().media.gifFallbackProvider).toBe('klipy');
    expect(patched.server.name).toBe('Renamed Admin Server');
    expect(patched.server.registrationMode).toBe('manual_approval');
    expect(patched.server.iconAttachmentId).toBe(icon.id);
    expect(patched.config.appearance.background.attachmentId).toBe(messagesBackground.id);
    expect(patched.config.appearance.ownMessageColor).toBe('#6effbf');
    expect(patched.config.appearance.otherMessageColor).toBe('#30b4ff');
    expect(patched.auth.mode).toBe('lan');
    expect(patched.restartRequiredFields).toContain('server.host');
    expect(context.serverConfig.get().appearance.backgroundAttachmentId).toBe(messagesBackground.id);
    expect(context.serverConfig.get().appearance.ownMessageColor).toBe('#6effbf');
    expect(context.serverConfig.get().appearance.otherMessageColor).toBe('#30b4ff');

    const transferOwnership = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/ownership/transfer',
      cookies: {
        current_session: 'admin_session',
      },
      payload: {
        targetUserId: 'usr_member',
      },
    });
    expect(transferOwnership.statusCode).toBe(200);
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('owner_user_id')).toBeTruthy();

    await app.inject({
      method: 'GET',
      url: '/api/v1/members',
      cookies: {
        current_session: 'admin_session',
      },
    });
    await app.inject({
      method: 'GET',
      url: '/api/v1/members',
      cookies: {
        current_session: 'member_session',
      },
    });

    const sharedIps = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/shared-ips',
      cookies: {
        current_session: 'admin_session',
      },
    });
    expect(sharedIps.statusCode).toBe(200);
    const groups = sharedIps.json() as Array<{ ipAddress: string; userCount: number }>;
    expect(groups.length).toBeGreaterThan(0);
    expect(groups[0]?.userCount).toBeGreaterThanOrEqual(2);

    await close();
  });

  it('does not require an optional background wallpaper when saving appearance settings', async () => {
    const { app, db, context, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Appearance Server',
        slug: 'appearance-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:appearance-owner',
        adminHandle: 'appearance-owner.bsky.social',
        adminDisplayName: 'Appearance Owner',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);

    const owner = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:appearance-owner') as { id: string } | undefined;
    expect(owner?.id).toBeTruthy();

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('appearance_owner_session', owner!.id, addHours(1), nowIso());

    const saveWithoutBackground = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'appearance_owner_session',
      },
      payload: {
        appearance: {
          backgroundAttachmentId: null,
          panelColor: '#99b7c1',
        },
      },
    });
    expect(saveWithoutBackground.statusCode).toBe(200);
    const noBackgroundPayload = saveWithoutBackground.json() as {
      config: {
        appearance: {
          background: { attachmentId?: string; url?: string };
          panelColor: string;
        };
      };
    };
    expect(noBackgroundPayload.config.appearance.background.attachmentId).toBeUndefined();
    expect(noBackgroundPayload.config.appearance.background.url).toBeUndefined();
    expect(noBackgroundPayload.config.appearance.panelColor).toBe('#99b7c1');
    expect(context.serverConfig.get().appearance.backgroundAttachmentId).toBe('');

    context.serverConfig.patchFullAdminSettings({
      appearance: {
        backgroundAttachmentId: 'missing-background-asset',
      },
    });

    const staleSettings = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'appearance_owner_session',
      },
    });
    expect(staleSettings.statusCode).toBe(200);
    const stalePayload = staleSettings.json() as {
      config: {
        appearance: {
          background: { attachmentId?: string; url?: string };
        };
      };
    };
    expect(stalePayload.config.appearance.background.attachmentId).toBeUndefined();
    expect(stalePayload.config.appearance.background.url).toBeUndefined();

    const saveWithStaleBackgroundReference = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'appearance_owner_session',
      },
      payload: {
        appearance: {
          backgroundAttachmentId: 'missing-background-asset',
          otherMessageColor: '#2c323b',
        },
      },
    });
    expect(saveWithStaleBackgroundReference.statusCode).toBe(200);
    expect(context.serverConfig.get().appearance.backgroundAttachmentId).toBe('');
    expect(context.serverConfig.get().appearance.otherMessageColor).toBe('#2c323b');

    await close();
  });

  it('lets host machine claim ownership to recover from manage-server lockout', async () => {
    const { app, db, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Recovery Server',
        slug: 'recovery-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_recover',
      'did:current:dev:recover',
      'recover@current',
      'Recover User',
      null,
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run(
      'recover_session',
      'usr_recover',
      addHours(1),
      nowIso(),
    );

    const deniedSettings = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'recover_session',
      },
    });
    expect(deniedSettings.statusCode).toBe(403);

    const remoteClaimDenied = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/ownership/claim-host',
      remoteAddress: '10.20.30.40',
      cookies: {
        current_session: 'recover_session',
      },
    });
    expect(remoteClaimDenied.statusCode).toBe(403);

    const proxiedRemoteDenied = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/ownership/claim-host',
      remoteAddress: '127.0.0.1',
      headers: {
        'x-forwarded-for': '10.20.30.40',
      },
      cookies: {
        current_session: 'recover_session',
      },
    });
    expect(proxiedRemoteDenied.statusCode).toBe(403);

    const claimed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/ownership/claim-host',
      cookies: {
        current_session: 'recover_session',
      },
    });
    expect(claimed.statusCode).toBe(200);
    const claimedPayload = claimed.json() as { ownerUserId: string };
    expect(claimedPayload.ownerUserId).toBe('usr_recover');

    const ownerRecord = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('owner_user_id') as { value: string } | undefined;
    expect(ownerRecord?.value).toBe('usr_recover');

    const allowedSettings = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'recover_session',
      },
    });
    expect(allowedSettings.statusCode).toBe(200);

    await close();
  });

  it('factory resets server data and returns setup to an unconfigured state', async () => {
    const { app, db, context, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Reset Server',
        slug: 'reset-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:reset-owner',
        adminHandle: 'reset-owner.bsky.social',
        adminDisplayName: 'Reset Owner',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);

    const owner = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:reset-owner') as { id: string } | undefined;
    expect(owner?.id).toBeTruthy();

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('reset_owner_session', owner!.id, addHours(1), nowIso());

    const attachment = context.chat.saveAttachment({
      fileName: 'factory-reset.png',
      mimeType: 'image/png',
      bytes: Buffer.from('factory-reset'),
    });
    expect(existsSync(attachment.path)).toBe(true);

    const deniedReset = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/settings/factory-reset',
      cookies: {
        current_session: 'reset_owner_session',
      },
      payload: {
        confirmation: 'reset',
      },
    });
    expect(deniedReset.statusCode).toBe(400);

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/settings/factory-reset',
      cookies: {
        current_session: 'reset_owner_session',
      },
      payload: {
        confirmation: 'RESET CURRENT SERVER',
      },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      configured: false,
      attachmentFilesDeleted: 1,
    });

    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/setup/status',
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      configured: false,
    });

    for (const table of [
      'servers',
      'users',
      'sessions',
      'roles',
      'user_roles',
      'channels',
      'attachments',
      'settings',
    ]) {
      expect(tableCount(db, table)).toBe(0);
    }
    expect(existsSync(attachment.path)).toBe(false);

    const settingsAfterReset = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings',
      cookies: {
        current_session: 'reset_owner_session',
      },
    });
    expect(settingsAfterReset.statusCode).toBe(401);

    await close();
  });
});
