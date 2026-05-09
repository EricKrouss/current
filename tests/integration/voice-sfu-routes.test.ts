import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';
import { addHours, nowIso } from '../../apps/server/src/utils/time.js';

describe('voice SFU signaling routes', () => {
  it('joins voice, produces audio, consumes remote audio, and rejects cross-channel consume', async () => {
    const { app, db, context, close } = await createTestApp();

    const setupResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/bootstrap',
      payload: {
        serverName: 'Voice Server',
        slug: 'voice-server',
        publicUrl: 'http://localhost:8080',
        registrationMode: 'invite_only',
        adminDid: 'did:plc:voice-admin',
        adminHandle: 'voice-admin.bsky.social',
        adminDisplayName: 'Voice Admin',
      },
    });
    expect(setupResponse.statusCode).toBe(201);
    const { serverId } = setupResponse.json() as { serverId: string };

    const admin = db
      .prepare('SELECT id FROM users WHERE did = ?')
      .get('did:plc:voice-admin') as { id: string };
    const memberRole = db
      .prepare("SELECT id FROM roles WHERE server_id = ? AND name = 'Member'")
      .get(serverId) as { id: string };

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('usr_voice_member', 'did:plc:voice-member', 'voice-member.bsky.social', 'Voice Member', null, nowIso(), nowIso());
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run('usr_voice_member', memberRole.id);
    db.prepare(
      `
      INSERT INTO sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `,
    ).run(
      'voice_admin_session',
      admin.id,
      addHours(1),
      nowIso(),
      'voice_member_session',
      'usr_voice_member',
      addHours(1),
      nowIso(),
    );

    const channelsResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/channels',
      cookies: {
        current_session: 'voice_admin_session',
      },
    });
    expect(channelsResponse.statusCode).toBe(200);
    const channels = channelsResponse.json() as {
      items: Array<{ id: string; type: 'text' | 'voice' | 'dm' }>;
    };
    const voiceChannel = channels.items.find((channel) => channel.type === 'voice');
    expect(voiceChannel?.id).toBeDefined();

    const otherVoiceChannel = context.repos.channels.create({
      serverId,
      name: 'other-voice',
      type: 'voice',
    });

    const adminJoinResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/channels/${voiceChannel?.id}/join`,
      cookies: {
        current_session: 'voice_admin_session',
      },
      payload: {
        muted: false,
        pushToTalk: false,
      },
    });
    expect(adminJoinResponse.statusCode).toBe(200);
    const adminJoin = adminJoinResponse.json() as { sessionId: string; producers: unknown[] };
    expect(adminJoin.sessionId).toBeTruthy();
    expect(adminJoin.producers).toEqual([]);

    const sendTransportResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/channels/${voiceChannel?.id}/transports`,
      cookies: {
        current_session: 'voice_admin_session',
      },
      payload: {
        sessionId: adminJoin.sessionId,
        direction: 'send',
      },
    });
    expect(sendTransportResponse.statusCode).toBe(200);
    const sendTransport = sendTransportResponse.json() as { id: string; iceParameters: { usernameFragment: string } };

    const restartIceResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/transports/${sendTransport.id}/restart-ice`,
      cookies: {
        current_session: 'voice_admin_session',
      },
      payload: {
        sessionId: adminJoin.sessionId,
      },
    });
    expect(restartIceResponse.statusCode).toBe(200);
    const restartIce = restartIceResponse.json() as { iceParameters: { usernameFragment: string } };
    expect(restartIce.iceParameters.usernameFragment).toBeTruthy();
    expect(restartIce.iceParameters.usernameFragment).not.toBe(sendTransport.iceParameters.usernameFragment);

    const produceResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/transports/${sendTransport.id}/produce`,
      cookies: {
        current_session: 'voice_admin_session',
      },
      payload: {
        sessionId: adminJoin.sessionId,
        kind: 'audio',
        rtpParameters: {},
      },
    });
    expect(produceResponse.statusCode).toBe(200);
    const { producer } = produceResponse.json() as { producer: { id: string; userId: string } };
    expect(producer.userId).toBe(admin.id);

    const memberJoinResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/channels/${voiceChannel?.id}/join`,
      cookies: {
        current_session: 'voice_member_session',
      },
      payload: {
        muted: true,
      },
    });
    expect(memberJoinResponse.statusCode).toBe(200);
    const memberJoin = memberJoinResponse.json() as { sessionId: string; producers: Array<{ id: string }> };
    expect(memberJoin.producers.map((item) => item.id)).toContain(producer.id);

    const recvTransportResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/channels/${voiceChannel?.id}/transports`,
      cookies: {
        current_session: 'voice_member_session',
      },
      payload: {
        sessionId: memberJoin.sessionId,
        direction: 'recv',
      },
    });
    expect(recvTransportResponse.statusCode).toBe(200);
    const recvTransport = recvTransportResponse.json() as { id: string };

    const consumeResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/transports/${recvTransport.id}/consume`,
      cookies: {
        current_session: 'voice_member_session',
      },
      payload: {
        sessionId: memberJoin.sessionId,
        producerId: producer.id,
        rtpCapabilities: {},
      },
    });
    expect(consumeResponse.statusCode).toBe(200);
    const { consumer } = consumeResponse.json() as { consumer: { producerId: string; userId: string } };
    expect(consumer.producerId).toBe(producer.id);
    expect(consumer.userId).toBe(admin.id);

    const otherJoinResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/channels/${otherVoiceChannel.id}/join`,
      cookies: {
        current_session: 'voice_member_session',
      },
      payload: {},
    });
    expect(otherJoinResponse.statusCode).toBe(200);
    const otherJoin = otherJoinResponse.json() as { sessionId: string };

    const otherRecvTransportResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/channels/${otherVoiceChannel.id}/transports`,
      cookies: {
        current_session: 'voice_member_session',
      },
      payload: {
        sessionId: otherJoin.sessionId,
        direction: 'recv',
      },
    });
    expect(otherRecvTransportResponse.statusCode).toBe(200);
    const otherRecvTransport = otherRecvTransportResponse.json() as { id: string };

    const crossChannelConsume = await app.inject({
      method: 'POST',
      url: `/api/v1/voice/transports/${otherRecvTransport.id}/consume`,
      cookies: {
        current_session: 'voice_member_session',
      },
      payload: {
        sessionId: otherJoin.sessionId,
        producerId: producer.id,
        rtpCapabilities: {},
      },
    });
    expect(crossChannelConsume.statusCode).toBe(400);

    await close();
  });
});
