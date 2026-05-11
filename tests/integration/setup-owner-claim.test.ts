import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

describe('setup owner assignment', () => {
  it('rejects unauthenticated first-run setup from remote clients', async () => {
    const { app, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      remoteAddress: '10.22.33.44',
      payload: {
        serverName: 'Remote Setup',
        slug: 'remote-setup',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:remote-takeover',
        adminHandle: 'remote-takeover.bsky.social',
        adminDisplayName: 'Remote Takeover',
      },
    });

    expect(bootstrapResponse.statusCode).toBe(401);
    expect(bootstrapResponse.json()).toMatchObject({
      error: {
        code: 'SETUP_AUTH_REQUIRED',
      },
    });

    await close();
  });

  it('applies onboarding preferences and returns the default landing channel', async () => {
    const { app, db, context, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Onboarding Server',
        slug: 'onboarding-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'manual_approval',
        initialPresenceStatus: 'away',
        media: {
          gifProvider: 'giphy',
          gifFallbackProvider: 'klipy',
          giphyApiKey: 'giphy-onboarding-key',
          maxAttachmentBytes: 12 * 1024 * 1024,
          allowedMimePrefixes: ['image/', 'video/'],
        },
        moderation: {
          defaultSlowmodeSeconds: 5,
          maxMentionsPerMessage: 4,
          linkPolicy: 'allow',
        },
        adminDid: 'did:plc:onboarding-owner',
        adminHandle: 'onboarding-owner.bsky.social',
        adminDisplayName: 'Onboarding Owner',
      },
    });

    expect(bootstrapResponse.statusCode).toBe(201);
    const bootstrapPayload = bootstrapResponse.json() as { serverId: string; defaultChannelId: string };
    expect(bootstrapPayload.serverId).toBeTruthy();
    expect(bootstrapPayload.defaultChannelId).toBeTruthy();

    const config = context.serverConfig.get();
    expect(config.server.registrationMode).toBe('manual_approval');
    expect(config.media.gifProvider).toBe('giphy');
    expect(config.media.gifFallbackProvider).toBe('klipy');
    expect(config.media.giphyApiKey).toBe('giphy-onboarding-key');
    expect(config.media.maxAttachmentBytes).toBe(12 * 1024 * 1024);
    expect(config.media.allowedMimePrefixes).toEqual(['image/', 'video/']);
    expect(config.moderation.defaultSlowmodeSeconds).toBe(5);
    expect(config.moderation.maxMentionsPerMessage).toBe(4);
    expect(config.moderation.linkPolicy).toBe('allow');

    const channels = context.repos.channels.listAll(bootstrapPayload.serverId);
    expect(channels.map((channel) => channel.name)).toEqual(['general', 'lounge']);
    expect(channels[0]?.id).toBe(bootstrapPayload.defaultChannelId);
    expect(channels[0]?.slowmodeSeconds).toBe(5);

    const ownerPresence = db
      .prepare('SELECT selected_presence_status FROM users WHERE did = ?')
      .get('did:plc:onboarding-owner') as { selected_presence_status: string } | undefined;
    expect(ownerPresence?.selected_presence_status).toBe('away');

    await close();
  });

  it('auto-assigns the first authenticated user as owner/admin when no owner exists', async () => {
    const { app, db, close } = await createTestApp();

    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Owner Claim Server',
        slug: 'owner-claim-server',
        publicUrl: 'http://127.0.0.1:8080',
        registrationMode: 'invite_only',
      },
    });
    expect(bootstrapResponse.statusCode).toBe(201);

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, bio, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'usr_owner_claim',
      'did:plc:ownerclaim',
      'ownerclaim.bsky.social',
      'Owner Claim',
      'https://example.com/avatar.png',
      'Ready to claim ownership.',
      nowIso(),
      nowIso(),
    );

    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run('owner_claim_session', 'usr_owner_claim', addHours(1), nowIso());

    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: {
        current_session: 'owner_claim_session',
      },
    });
    expect(sessionResponse.statusCode).toBe(200);
    const sessionPayload = sessionResponse.json() as { user: { roleIds: string[] } };

    const rolesResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      cookies: {
        current_session: 'owner_claim_session',
      },
    });
    expect(rolesResponse.statusCode).toBe(200);
    const rolesPayload = rolesResponse.json() as Array<{ id: string; permissions: string[] }>;
    const adminRole = rolesPayload.find((role) => role.permissions.includes('ADMINISTRATOR'));
    expect(adminRole).toBeTruthy();
    if (!adminRole) {
      throw new Error('Expected bootstrap admin role to exist');
    }

    expect(sessionPayload.user.roleIds).toContain(adminRole.id);

    await close();
  });
});
