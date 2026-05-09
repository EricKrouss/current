import type { CurrentConfig } from '@current/config';
import type { VoiceState } from '@current/types';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { MetricsService } from '../metrics/metrics-service.js';
import { id } from '../utils/id.js';
import { MediasoupVoiceSfuAdapter } from './mediasoup-voice-sfu-adapter.js';
import type {
  VoiceConsumerInfo,
  VoiceIceRestartInfo,
  VoiceJoinMedia,
  VoiceProducerSummary,
  VoiceSessionCloseResult,
  VoiceSfuAdapter,
  VoiceSfuEvents,
  VoiceTransportDirection,
  VoiceTransportInfo,
} from './voice-sfu-types.js';

export interface VoiceJoinResponse extends VoiceJoinMedia {
  voiceState: VoiceState;
}

export class VoiceService {
  private readonly sfu: VoiceSfuAdapter;
  private readonly cleanupInterval?: NodeJS.Timeout;
  private readonly sessionByUserId = new Map<string, string>();
  private readonly sessionUserById = new Map<string, string>();

  constructor(
    private readonly repos: RepositoryBag,
    private readonly metrics: MetricsService,
    private readonly getConfig: () => CurrentConfig,
    events: VoiceSfuEvents = {},
    sfu?: VoiceSfuAdapter,
  ) {
    this.sfu =
      sfu ??
      new MediasoupVoiceSfuAdapter({
        getConfig,
        events,
      });
    this.cleanupInterval = setInterval(() => {
      void this.cleanupStaleSessions();
    }, 30_000);
    this.cleanupInterval.unref?.();
  }

  issueChannelToken(input: { userId: string; channelId: string }): {
    token: string;
    channelId: string;
    userId: string;
    rtc: {
      mode: 'mediasoup_sfu';
      listenIp: string;
      announcedIp: string;
      udpMinPort: number;
      udpMaxPort: number;
      workerCount: number;
      turn: {
        urls: string[];
        username?: string;
        credential?: string;
      };
    };
  } {
    const config = this.getConfig();
    return {
      token: id('voice'),
      channelId: input.channelId,
      userId: input.userId,
      rtc: {
        mode: 'mediasoup_sfu',
        listenIp: config.rtc.listenIp,
        announcedIp: config.rtc.announcedIp,
        udpMinPort: config.rtc.udpMinPort,
        udpMaxPort: config.rtc.udpMaxPort,
        workerCount: config.rtc.workerCount,
        turn: {
          urls: config.rtc.turnUrls,
          username: config.rtc.turnUsername,
          credential: config.rtc.turnCredential,
        },
      },
    };
  }

  async joinChannel(input: {
    userId: string;
    channelId: string;
    muted?: boolean;
    deafened?: boolean;
    pushToTalk?: boolean;
  }): Promise<VoiceJoinResponse> {
    this.metrics.incrementVoiceJoins();
    const previousSessionId = this.sessionByUserId.get(input.userId);
    await this.sfu.closeUserSession(input.userId);
    if (previousSessionId) {
      this.forgetSession(previousSessionId);
    }
    const voiceState = this.repos.voiceStates.upsert({
      userId: input.userId,
      channelId: input.channelId,
      muted: Boolean(input.muted),
      deafened: Boolean(input.deafened),
      pushToTalk: Boolean(input.pushToTalk),
      speaking: false,
    });
    const media = await this.sfu.join({
      sessionId: id('vse'),
      userId: input.userId,
      channelId: input.channelId,
    });
    this.sessionByUserId.set(input.userId, media.sessionId);
    this.sessionUserById.set(media.sessionId, input.userId);

    return {
      ...media,
      voiceState,
    };
  }

  async leaveChannel(userId: string): Promise<VoiceSessionCloseResult | null> {
    const closed = await this.sfu.closeUserSession(userId);
    const sessionId = this.sessionByUserId.get(userId);
    if (sessionId) {
      this.forgetSession(sessionId);
    }
    this.repos.voiceStates.remove(userId);
    return closed;
  }

  sessionBelongsToUser(sessionId: string, userId: string): boolean {
    return this.sessionUserById.get(sessionId) === userId;
  }

  async createTransport(input: {
    sessionId: string;
    direction: VoiceTransportDirection;
  }): Promise<VoiceTransportInfo> {
    return this.sfu.createTransport(input);
  }

  async connectTransport(input: {
    sessionId: string;
    transportId: string;
    dtlsParameters: unknown;
  }): Promise<void> {
    await this.sfu.connectTransport(input);
  }

  async restartTransportIce(input: {
    sessionId: string;
    transportId: string;
  }): Promise<VoiceIceRestartInfo> {
    return this.sfu.restartTransportIce(input);
  }

  async produce(input: {
    sessionId: string;
    transportId: string;
    kind: 'audio';
    rtpParameters: unknown;
    paused?: boolean;
  }): Promise<VoiceProducerSummary> {
    return this.sfu.produce(input);
  }

  async consume(input: {
    sessionId: string;
    transportId: string;
    producerId: string;
    rtpCapabilities: unknown;
  }): Promise<VoiceConsumerInfo> {
    return this.sfu.consume(input);
  }

  async resumeConsumer(input: {
    sessionId: string;
    consumerId: string;
  }): Promise<void> {
    await this.sfu.resumeConsumer(input);
  }

  async setProducerPaused(input: {
    sessionId: string;
    producerId: string;
    paused: boolean;
  }): Promise<VoiceProducerSummary | null> {
    return this.sfu.setProducerPaused(input);
  }

  touchSession(sessionId: string): void {
    this.sfu.touchSession(sessionId);
  }

  patchState(input: {
    userId: string;
    muted?: boolean;
    deafened?: boolean;
    pushToTalk?: boolean;
    speaking?: boolean;
  }): VoiceState | null {
    const current = this.repos.voiceStates.getByUser(input.userId);
    if (!current) {
      return null;
    }

    return this.repos.voiceStates.upsert({
      userId: current.userId,
      channelId: current.channelId,
      muted: input.muted ?? current.muted,
      deafened: input.deafened ?? current.deafened,
      pushToTalk: input.pushToTalk ?? current.pushToTalk,
      speaking: current.speaking,
      connectedAt: current.connectedAt,
    });
  }

  getUserState(userId: string): VoiceState | null {
    return this.repos.voiceStates.getByUser(userId);
  }

  listState(): VoiceState[] {
    return this.repos.voiceStates.listAll();
  }

  listChannelState(channelId: string): VoiceState[] {
    return this.repos.voiceStates.listByChannel(channelId);
  }

  async cleanupStaleSessions(): Promise<VoiceSessionCloseResult[]> {
    const timeoutMs = this.getConfig().rtc.sessionTimeoutMs;
    const closed = await this.sfu.closeStaleSessions(timeoutMs);
    for (const session of closed) {
      this.forgetSession(session.sessionId);
      this.repos.voiceStates.remove(session.userId);
    }
    return closed;
  }

  diagnostics() {
    const config = this.getConfig();
    const sfu = this.sfu.diagnostics();
    return {
      transport: 'webrtc_sfu',
      codec: 'opus',
      provider: 'mediasoup',
      announcedIp: config.rtc.announcedIp,
      udpPortRange: {
        min: config.rtc.udpMinPort,
        max: config.rtc.udpMaxPort,
      },
      workerCount: config.rtc.workerCount,
      activeRooms: sfu.rooms,
      activeSessions: sfu.sessions,
      activeProducers: sfu.producers,
      turnUrls: config.rtc.turnUrls,
      turnConfigured: config.rtc.turnUrls.length > 0,
      tlsEnabled: config.server.tls.enabled,
    };
  }

  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    await this.sfu.close();
    this.sessionByUserId.clear();
    this.sessionUserById.clear();
  }

  private forgetSession(sessionId: string): void {
    const userId = this.sessionUserById.get(sessionId);
    this.sessionUserById.delete(sessionId);
    if (userId && this.sessionByUserId.get(userId) === sessionId) {
      this.sessionByUserId.delete(userId);
    }
  }
}
