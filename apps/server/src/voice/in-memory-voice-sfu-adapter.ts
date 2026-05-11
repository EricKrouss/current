import { id } from '../utils/id.js';
import type {
  VoiceConsumerInfo,
  VoiceIceRestartInfo,
  VoiceJoinMedia,
  VoiceProducerSummary,
  VoiceSessionCloseResult,
  VoiceSfuAdapter,
  VoiceSfuAdapterOptions,
  VoiceTransportDirection,
  VoiceTransportInfo,
} from './voice-sfu-types.js';

interface FakeSession {
  id: string;
  userId: string;
  channelId: string;
  transports: Map<string, VoiceTransportInfo>;
  consumers: Map<string, VoiceConsumerInfo>;
  producers: Set<string>;
  lastSeenAt: number;
}

export class InMemoryVoiceSfuAdapter implements VoiceSfuAdapter {
  private readonly sessions = new Map<string, FakeSession>();
  private readonly sessionByUserId = new Map<string, string>();
  private readonly producers = new Map<string, VoiceProducerSummary>();

  constructor(private readonly options: VoiceSfuAdapterOptions) {}

  async join(input: { sessionId: string; userId: string; channelId: string }): Promise<VoiceJoinMedia> {
    await this.closeUserSession(input.userId);
    const session: FakeSession = {
      id: input.sessionId,
      userId: input.userId,
      channelId: input.channelId,
      transports: new Map(),
      consumers: new Map(),
      producers: new Set(),
      lastSeenAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.sessionByUserId.set(session.userId, session.id);

    return {
      sessionId: session.id,
      rtpCapabilities: {
        codecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
        headerExtensions: [],
      },
      iceServers: buildIceServers(this.options.getConfig().rtc),
      producers: this.listChannelProducers(input.channelId).filter((producer) => producer.userId !== input.userId),
    };
  }

  async createTransport(input: {
    sessionId: string;
    direction: VoiceTransportDirection;
  }): Promise<VoiceTransportInfo> {
    const session = this.requireSession(input.sessionId);
    const transport: VoiceTransportInfo = {
      id: id('vtr'),
      direction: input.direction,
      iceParameters: { usernameFragment: id('ice'), password: id('ice'), iceLite: true },
      iceCandidates: [],
      dtlsParameters: { role: 'auto', fingerprints: [] },
    };
    session.transports.set(transport.id, transport);
    return transport;
  }

  async connectTransport(input: { sessionId: string; transportId: string }): Promise<void> {
    const session = this.requireSession(input.sessionId);
    if (!session.transports.has(input.transportId)) {
      throw new Error('Voice transport not found.');
    }
  }

  async restartTransportIce(input: { sessionId: string; transportId: string }): Promise<VoiceIceRestartInfo> {
    const session = this.requireSession(input.sessionId);
    const transport = session.transports.get(input.transportId);
    if (!transport) {
      throw new Error('Voice transport not found.');
    }

    const iceParameters = { usernameFragment: id('ice'), password: id('ice'), iceLite: true };
    session.transports.set(transport.id, {
      ...transport,
      iceParameters,
    });
    return { iceParameters };
  }

  async produce(input: {
    sessionId: string;
    transportId: string;
    kind: 'audio';
    paused?: boolean;
  }): Promise<VoiceProducerSummary> {
    const session = this.requireSession(input.sessionId);
    if (!session.transports.has(input.transportId)) {
      throw new Error('Voice transport not found.');
    }

    const producer: VoiceProducerSummary = {
      id: id('vpr'),
      userId: session.userId,
      channelId: session.channelId,
      kind: input.kind,
      paused: Boolean(input.paused),
    };
    this.producers.set(producer.id, producer);
    session.producers.add(producer.id);
    return producer;
  }

  async consume(input: {
    sessionId: string;
    transportId: string;
    producerId: string;
  }): Promise<VoiceConsumerInfo> {
    const session = this.requireSession(input.sessionId);
    if (!session.transports.has(input.transportId)) {
      throw new Error('Voice transport not found.');
    }
    const producer = this.producers.get(input.producerId);
    if (!producer || producer.channelId !== session.channelId) {
      throw new Error('Voice producer not found.');
    }
    if (producer.userId === session.userId) {
      throw new Error('Cannot consume your own producer.');
    }

    const consumer: VoiceConsumerInfo = {
      id: id('vcn'),
      producerId: producer.id,
      userId: producer.userId,
      kind: producer.kind,
      rtpParameters: {},
      paused: true,
    };
    session.consumers.set(consumer.id, consumer);
    return consumer;
  }

  async resumeConsumer(input: { sessionId: string; consumerId: string }): Promise<void> {
    const consumer = await this.setConsumerPaused({
      ...input,
      paused: false,
    });
    if (!consumer) {
      throw new Error('Voice consumer not found.');
    }
  }

  async setConsumerPaused(input: {
    sessionId: string;
    consumerId: string;
    paused: boolean;
  }): Promise<VoiceConsumerInfo | null> {
    const session = this.requireSession(input.sessionId);
    const consumer = session.consumers.get(input.consumerId);
    if (!consumer) {
      return null;
    }
    const next = { ...consumer, paused: input.paused };
    session.consumers.set(consumer.id, next);
    return next;
  }

  async closeSession(sessionId: string): Promise<VoiceSessionCloseResult | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const producers = [...session.producers]
      .map((producerId) => this.producers.get(producerId))
      .filter((producer): producer is VoiceProducerSummary => Boolean(producer));

    for (const producer of producers) {
      this.producers.delete(producer.id);
      this.options.events?.onProducerClosed?.(producer);
      this.options.events?.onSpeaking?.({
        channelId: producer.channelId,
        userId: producer.userId,
        speaking: false,
      });
    }

    this.sessions.delete(session.id);
    if (this.sessionByUserId.get(session.userId) === session.id) {
      this.sessionByUserId.delete(session.userId);
    }

    return {
      sessionId: session.id,
      userId: session.userId,
      channelId: session.channelId,
      producers,
    };
  }

  closeUserSession(userId: string): Promise<VoiceSessionCloseResult | null> {
    const sessionId = this.sessionByUserId.get(userId);
    return sessionId ? this.closeSession(sessionId) : Promise.resolve(null);
  }

  async setProducerPaused(input: {
    sessionId: string;
    producerId: string;
    paused: boolean;
  }): Promise<VoiceProducerSummary | null> {
    const session = this.requireSession(input.sessionId);
    if (!session.producers.has(input.producerId)) {
      return null;
    }
    const producer = this.producers.get(input.producerId);
    if (!producer) {
      return null;
    }
    const next = { ...producer, paused: input.paused };
    this.producers.set(producer.id, next);
    return next;
  }

  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastSeenAt = Date.now();
    }
  }

  async closeStaleSessions(maxAgeMs: number): Promise<VoiceSessionCloseResult[]> {
    const cutoff = Date.now() - maxAgeMs;
    const stale = [...this.sessions.values()].filter((session) => session.lastSeenAt < cutoff);
    const closed: VoiceSessionCloseResult[] = [];
    for (const session of stale) {
      const result = await this.closeSession(session.id);
      if (result) {
        closed.push(result);
      }
    }
    return closed;
  }

  listChannelProducers(channelId: string): VoiceProducerSummary[] {
    return [...this.producers.values()].filter((producer) => producer.channelId === channelId);
  }

  diagnostics() {
    return {
      rooms: new Set([...this.sessions.values()].map((session) => session.channelId)).size,
      sessions: this.sessions.size,
      producers: this.producers.size,
      workerCount: 0,
    };
  }

  async close(): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    for (const sessionId of sessionIds) {
      await this.closeSession(sessionId);
    }
  }

  private requireSession(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Voice session not found.');
    }
    session.lastSeenAt = Date.now();
    return session;
  }
}

function buildIceServers(rtc: { turnUrls: string[]; turnUsername?: string; turnCredential?: string }): RTCIceServer[] {
  if (rtc.turnUrls.length === 0) {
    return [];
  }
  return [
    {
      urls: rtc.turnUrls,
      username: rtc.turnUsername,
      credential: rtc.turnCredential,
    },
  ];
}
