import { describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

describe('voice state service', () => {
  it('joins, patches, and leaves channel state', async () => {
    const { context, db, close } = await createTestApp();

    db.prepare(
      `
      INSERT INTO servers (id, name, slug, registration_mode, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run('srv_1', 'Voice Test Server', 'voice-test', 'invite_only', new Date().toISOString());

    db.prepare(
      `
      INSERT INTO users (id, did, handle, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('voice_user', 'did:plc:voice', 'voice.bsky.social', 'Voice', null, new Date().toISOString(), new Date().toISOString());

    db.prepare(
      `
      INSERT INTO channels (id, server_id, category_id, name, type, topic, slowmode_seconds, locked, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('voice_chan', 'srv_1', null, 'voice', 'voice', null, 0, 0, new Date().toISOString());

    const joined = await context.voice.joinChannel({
      userId: 'voice_user',
      channelId: 'voice_chan',
      pushToTalk: true,
    });

    expect(joined.voiceState.channelId).toBe('voice_chan');
    expect(joined.voiceState.pushToTalk).toBe(true);

    const patched = context.voice.patchState({
      userId: 'voice_user',
      muted: true,
      speaking: true,
    });

    expect(patched?.muted).toBe(true);
    expect(patched?.speaking).toBe(false);

    await context.voice.leaveChannel('voice_user');
    expect(context.voice.patchState({ userId: 'voice_user', speaking: false })).toBeNull();

    await close();
  });
});
