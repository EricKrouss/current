import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';
import { createTestApp } from '../helpers/test-app.js';

function exportedTestKey(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64url');
}

function keyIdForExportedKey(exportedKey: string): string {
  return createHash('sha256').update(Buffer.from(exportedKey, 'base64url')).digest().subarray(0, 12).toString('base64url');
}

describe('E2EE chat messages', () => {
  it('stores and returns encrypted message envelopes without plaintext content', async () => {
    const { app, db, close } = await createTestApp();

    const setupResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Encrypted Integration',
        slug: 'encrypted-integration',
        publicUrl: 'http://localhost:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:encrypted',
        adminHandle: 'encrypted.bsky.social',
        adminDisplayName: 'Encrypted Admin',
      },
    });

    expect(setupResponse.statusCode).toBe(201);

    const user = db.prepare('SELECT id FROM users WHERE did = ?').get('did:plc:encrypted') as {
      id: string;
    };

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('encrypted_session', user.id, addHours(1), nowIso());

    const channelsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: 'encrypted_session',
      },
    });

    expect(channelsResponse.statusCode).toBe(200);
    const channels = channelsResponse.json() as {
      items: Array<{ id: string; type: string }>;
    };
    const textChannel = channels.items.find((channel) => channel.type === 'text');
    expect(textChannel?.id).toBeDefined();

    const encryptedContent = {
      version: 1 as const,
      algorithm: 'AES-GCM' as const,
      keyId: 'abc12345abc12345',
      nonce: 'abcdefghijklmnop',
      ciphertext: 'encrypted-payload-not-plaintext',
    };

    const messageResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${textChannel?.id}/messages`,
      cookies: {
        current_session: 'encrypted_session',
      },
      payload: {
        content: '',
        encryptedContent,
      },
    });

    expect(messageResponse.statusCode).toBe(201);
    const message = messageResponse.json() as {
      id: string;
      content: string;
      encryptedContent?: typeof encryptedContent;
    };
    expect(message.content).toBe('');
    expect(message.encryptedContent).toEqual(encryptedContent);

    const stored = db.prepare('SELECT content, encrypted_content FROM messages WHERE id = ?').get(message.id) as {
      content: string;
      encrypted_content: string;
    };
    expect(stored.content).toBe('');
    expect(stored.encrypted_content).toContain(encryptedContent.ciphertext);

    const messagesResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/channels/${textChannel?.id}/messages`,
      cookies: {
        current_session: 'encrypted_session',
      },
    });

    expect(messagesResponse.statusCode).toBe(200);
    const messages = messagesResponse.json() as {
      items: Array<{ content: string; encryptedContent?: typeof encryptedContent }>;
    };
    expect(messages.items.at(-1)?.content).toBe('');
    expect(messages.items.at(-1)?.encryptedContent).toEqual(encryptedContent);

    await close();
  });

  it('shares one encryption room key with authenticated clients', async () => {
    const { app, db, close } = await createTestApp();

    const setupResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Shared Encryption',
        slug: 'shared-encryption',
        publicUrl: 'http://localhost:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:shared-key-admin',
        adminHandle: 'shared-key-admin.bsky.social',
        adminDisplayName: 'Shared Key Admin',
      },
    });

    expect(setupResponse.statusCode).toBe(201);

    const admin = db.prepare('SELECT id FROM users WHERE did = ?').get('did:plc:shared-key-admin') as {
      id: string;
    };

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('shared_admin_session', admin.id, addHours(1), nowIso());

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_shared_member',
      'did:plc:shared-key-member',
      'shared-key-member.bsky.social',
      'Shared Key Member',
      null,
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('shared_member_session', 'usr_shared_member', addHours(1), nowIso());

    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/server/e2ee-key',
    });

    expect(unauthenticated.statusCode).toBe(401);

    const exportedKey = exportedTestKey(7);
    const claimResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/server/e2ee-key',
      cookies: {
        current_session: 'shared_admin_session',
      },
      payload: {
        exportedKey,
      },
    });

    expect(claimResponse.statusCode).toBe(200);
    expect(claimResponse.json()).toEqual({
      exportedKey,
      keyId: keyIdForExportedKey(exportedKey),
    });

    const fetchedResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/server/e2ee-key',
      cookies: {
        current_session: 'shared_member_session',
      },
    });

    expect(fetchedResponse.statusCode).toBe(200);
    expect(fetchedResponse.json()).toEqual({
      exportedKey,
      keyId: keyIdForExportedKey(exportedKey),
    });

    const secondClaimResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/server/e2ee-key',
      cookies: {
        current_session: 'shared_member_session',
      },
      payload: {
        exportedKey: exportedTestKey(8),
      },
    });

    expect(secondClaimResponse.statusCode).toBe(200);
    expect(secondClaimResponse.json()).toEqual({
      exportedKey,
      keyId: keyIdForExportedKey(exportedKey),
    });

    await close();
  });
});
