import { availableParallelism } from 'node:os';
import { createWorker } from 'mediasoup';
import type { types as mediasoupTypes } from 'mediasoup';
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

const OPUS_MEDIA_CODECS: mediasoupTypes.RouterRtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      useinbandfec: 1,
      usedtx: 1,
    },
  },
];

interface VoiceRoom {
  channelId: string;
  router: mediasoupTypes.Router;
  audioLevelObserver: mediasoupTypes.AudioLevelObserver;
  sessions: Set<string>;
  producers: Map<string, VoiceProducerRecord>;
  speakingUserIds: Set<string>;
}

interface VoiceSession {
  id: string;
  userId: string;
  channelId: string;
  transports: Map<string, VoiceTransportRecord>;
  consumers: Map<string, mediasoupTypes.Consumer>;
  producers: Set<string>;
  lastSeenAt: number;
}

interface VoiceTransportRecord {
  id: string;
  sessionId: string;
  direction: VoiceTransportDirection;
  transport: mediasoupTypes.WebRtcTransport;
}

interface VoiceProducerRecord {
  summary: VoiceProducerSummary;
  producer: mediasoupTypes.Producer;
}

export class MediasoupVoiceSfuAdapter implements VoiceSfuAdapter {
  private readonly rooms = new Map<string, VoiceRoom>();
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly sessionByUserId = new Map<string, string>();
  private readonly workers: mediasoupTypes.Worker[] = [];
  private workerInitPromise: Promise<void> | null = null;
  private nextWorkerIndex = 0;

  constructor(private readonly options: VoiceSfuAdapterOptions) {}

  async join(input: { sessionId: string; userId: string; channelId: string }): Promise<VoiceJoinMedia> {
    await this.closeUserSession(input.userId);
    const room = await this.getOrCreateRoom(input.channelId);
    const session: VoiceSession = {
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
    room.sessions.add(session.id);

    return {
      sessionId: session.id,
      rtpCapabilities: room.router.rtpCapabilities,
      iceServers: this.buildIceServers(),
      producers: this.listChannelProducers(input.channelId).filter((producer) => producer.userId !== input.userId),
    };
  }

  async createTransport(input: {
    sessionId: string;
    direction: VoiceTransportDirection;
  }): Promise<VoiceTransportInfo> {
    const session = this.requireSession(input.sessionId);
    const room = await this.getOrCreateRoom(session.channelId);
    const rtc = this.options.getConfig().rtc;
    const announcedAddress = rtc.announcedIp.trim() || undefined;
    const listenInfos: mediasoupTypes.TransportListenInfo[] = [
      {
        protocol: 'udp',
        ip: rtc.listenIp,
        announcedAddress,
        portRange: {
          min: rtc.udpMinPort,
          max: rtc.udpMaxPort,
        },
      },
      {
        protocol: 'tcp',
        ip: rtc.listenIp,
        announcedAddress,
        portRange: {
          min: rtc.udpMinPort,
          max: rtc.udpMaxPort,
        },
      },
    ];

    const transport = await room.router.createWebRtcTransport({
      listenInfos,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 128_000,
      iceConsentTimeout: 30,
      appData: {
        sessionId: session.id,
        channelId: session.channelId,
        direction: input.direction,
      },
    });

    const record: VoiceTransportRecord = {
      id: transport.id,
      sessionId: session.id,
      direction: input.direction,
      transport,
    };
    session.transports.set(record.id, record);
    transport.observer.on('close', () => {
      session.transports.delete(record.id);
    });

    return this.serializeTransport(record);
  }

  async connectTransport(input: {
    sessionId: string;
    transportId: string;
    dtlsParameters: unknown;
  }): Promise<void> {
    const transport = this.requireTransport(input.sessionId, input.transportId);
    await transport.transport.connect({
      dtlsParameters: input.dtlsParameters as mediasoupTypes.DtlsParameters,
    });
  }

  async restartTransportIce(input: {
    sessionId: string;
    transportId: string;
  }): Promise<VoiceIceRestartInfo> {
    const transport = this.requireTransport(input.sessionId, input.transportId);
    return {
      iceParameters: await transport.transport.restartIce(),
    };
  }

  async produce(input: {
    sessionId: string;
    transportId: string;
    kind: 'audio';
    rtpParameters: unknown;
    paused?: boolean;
  }): Promise<VoiceProducerSummary> {
    const session = this.requireSession(input.sessionId);
    const transport = this.requireTransport(session.id, input.transportId);
    if (transport.direction !== 'send') {
      throw new Error('Audio must be produced on a send transport.');
    }

    const room = await this.getOrCreateRoom(session.channelId);
    const producer = await transport.transport.produce({
      kind: input.kind,
      rtpParameters: input.rtpParameters as mediasoupTypes.RtpParameters,
      paused: Boolean(input.paused),
      appData: {
        sessionId: session.id,
        userId: session.userId,
        channelId: session.channelId,
      },
    });
    const summary: VoiceProducerSummary = {
      id: producer.id,
      userId: session.userId,
      channelId: session.channelId,
      kind: 'audio',
      paused: producer.paused,
    };
    room.producers.set(producer.id, { summary, producer });
    session.producers.add(producer.id);
    await room.audioLevelObserver.addProducer({ producerId: producer.id });

    producer.observer.on('close', () => {
      this.removeProducer(room, session, producer.id, true);
    });

    return summary;
  }

  async consume(input: {
    sessionId: string;
    transportId: string;
    producerId: string;
    rtpCapabilities: unknown;
  }): Promise<VoiceConsumerInfo> {
    const session = this.requireSession(input.sessionId);
    const transport = this.requireTransport(session.id, input.transportId);
    if (transport.direction !== 'recv') {
      throw new Error('Audio must be consumed on a receive transport.');
    }

    const room = await this.getOrCreateRoom(session.channelId);
    const producerRecord = room.producers.get(input.producerId);
    if (!producerRecord) {
      throw new Error('Voice producer not found.');
    }
    if (producerRecord.summary.userId === session.userId) {
      throw new Error('Cannot consume your own producer.');
    }
    if (
      !room.router.canConsume({
        producerId: input.producerId,
        rtpCapabilities: input.rtpCapabilities as mediasoupTypes.RtpCapabilities,
      })
    ) {
      throw new Error('Client cannot consume this producer.');
    }

    const consumer = await transport.transport.consume({
      producerId: input.producerId,
      rtpCapabilities: input.rtpCapabilities as mediasoupTypes.RtpCapabilities,
      paused: true,
      ignoreDtx: true,
    });
    session.consumers.set(consumer.id, consumer);
    consumer.observer.on('close', () => {
      session.consumers.delete(consumer.id);
    });

    return {
      id: consumer.id,
      producerId: input.producerId,
      userId: producerRecord.summary.userId,
      kind: 'audio',
      rtpParameters: consumer.rtpParameters,
      paused: consumer.paused,
    };
  }

  async resumeConsumer(input: { sessionId: string; consumerId: string }): Promise<void> {
    const session = this.requireSession(input.sessionId);
    const consumer = session.consumers.get(input.consumerId);
    if (!consumer) {
      throw new Error('Voice consumer not found.');
    }
    await consumer.resume();
  }

  async closeSession(sessionId: string): Promise<VoiceSessionCloseResult | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const room = this.rooms.get(session.channelId);
    const producers: VoiceProducerSummary[] = [];
    if (room) {
      for (const producerId of [...session.producers]) {
        const summary = this.removeProducer(room, session, producerId, false);
        if (summary) {
          producers.push(summary);
        }
      }
    }

    for (const consumer of session.consumers.values()) {
      consumer.close();
    }
    for (const transport of session.transports.values()) {
      transport.transport.close();
    }

    this.sessions.delete(session.id);
    if (this.sessionByUserId.get(session.userId) === session.id) {
      this.sessionByUserId.delete(session.userId);
    }
    room?.sessions.delete(session.id);
    this.maybeCloseRoom(session.channelId);

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
    const room = await this.getOrCreateRoom(session.channelId);
    const record = room.producers.get(input.producerId);
    if (!record) {
      return null;
    }

    if (input.paused) {
      await record.producer.pause();
    } else {
      await record.producer.resume();
    }

    record.summary = {
      ...record.summary,
      paused: record.producer.paused,
    };
    return record.summary;
  }

  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastSeenAt = Date.now();
    }
  }

  async closeStaleSessions(maxAgeMs: number): Promise<VoiceSessionCloseResult[]> {
    const cutoff = Date.now() - maxAgeMs;
    const staleSessions = [...this.sessions.values()].filter((session) => session.lastSeenAt < cutoff);
    const closed: VoiceSessionCloseResult[] = [];
    for (const session of staleSessions) {
      const result = await this.closeSession(session.id);
      if (result) {
        closed.push(result);
      }
    }
    return closed;
  }

  listChannelProducers(channelId: string): VoiceProducerSummary[] {
    return [...(this.rooms.get(channelId)?.producers.values() ?? [])].map((record) => record.summary);
  }

  diagnostics() {
    let producerCount = 0;
    for (const room of this.rooms.values()) {
      producerCount += room.producers.size;
    }
    return {
      rooms: this.rooms.size,
      sessions: this.sessions.size,
      producers: producerCount,
      workerCount: this.workers.length,
    };
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.keys()];
    for (const sessionId of sessions) {
      await this.closeSession(sessionId);
    }
    for (const worker of this.workers) {
      worker.close();
    }
    this.workers.length = 0;
    this.workerInitPromise = null;
  }

  private async getOrCreateRoom(channelId: string): Promise<VoiceRoom> {
    const existing = this.rooms.get(channelId);
    if (existing) {
      return existing;
    }

    await this.ensureWorkers();
    const worker = this.workers[this.nextWorkerIndex % this.workers.length];
    this.nextWorkerIndex += 1;
    const router = await worker.createRouter({
      mediaCodecs: OPUS_MEDIA_CODECS,
      appData: {
        channelId,
      },
    });
    const audioLevelObserver = await router.createAudioLevelObserver({
      maxEntries: 8,
      threshold: -65,
      interval: 250,
      appData: {
        channelId,
      },
    });

    const room: VoiceRoom = {
      channelId,
      router,
      audioLevelObserver,
      sessions: new Set(),
      producers: new Map(),
      speakingUserIds: new Set(),
    };

    audioLevelObserver.on('volumes', (volumes) => {
      const speakingNow = new Set<string>();
      for (const volume of volumes) {
        const producer = room.producers.get(volume.producer.id);
        if (!producer || producer.summary.paused) {
          continue;
        }
        speakingNow.add(producer.summary.userId);
        this.setSpeaking(room, producer.summary.userId, true, volume.volume);
      }

      for (const userId of [...room.speakingUserIds]) {
        if (!speakingNow.has(userId)) {
          this.setSpeaking(room, userId, false);
        }
      }
    });

    audioLevelObserver.on('silence', () => {
      for (const userId of [...room.speakingUserIds]) {
        this.setSpeaking(room, userId, false);
      }
    });

    this.rooms.set(channelId, room);
    return room;
  }

  private async ensureWorkers(): Promise<void> {
    if (this.workers.length > 0) {
      return;
    }
    if (this.workerInitPromise) {
      return this.workerInitPromise;
    }

    this.workerInitPromise = this.createWorkers();
    return this.workerInitPromise;
  }

  private async createWorkers(): Promise<void> {
    const rtc = this.options.getConfig().rtc;
    const fallbackCount = Math.min(2, Math.max(1, availableParallelism() - 1));
    const workerCount = Math.min(Math.max(rtc.workerCount ?? fallbackCount, 1), 8);

    for (let index = 0; index < workerCount; index += 1) {
      const worker = await createWorker({
        logLevel: 'warn',
        rtcMinPort: rtc.udpMinPort,
        rtcMaxPort: rtc.udpMaxPort,
      });
      worker.on('died', () => {
        worker.close();
        const workerIndex = this.workers.indexOf(worker);
        if (workerIndex >= 0) {
          this.workers.splice(workerIndex, 1);
        }
      });
      this.workers.push(worker);
    }
  }

  private serializeTransport(record: VoiceTransportRecord): VoiceTransportInfo {
    return {
      id: record.id,
      direction: record.direction,
      iceParameters: record.transport.iceParameters,
      iceCandidates: record.transport.iceCandidates,
      dtlsParameters: record.transport.dtlsParameters,
    };
  }

  private requireSession(sessionId: string): VoiceSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Voice session not found.');
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  private requireTransport(sessionId: string, transportId: string): VoiceTransportRecord {
    const session = this.requireSession(sessionId);
    const transport = session.transports.get(transportId);
    if (!transport) {
      throw new Error('Voice transport not found.');
    }
    return transport;
  }

  private removeProducer(
    room: VoiceRoom,
    session: VoiceSession | null,
    producerId: string,
    notify: boolean,
  ): VoiceProducerSummary | null {
    const record = room.producers.get(producerId);
    if (!record) {
      return null;
    }

    room.producers.delete(producerId);
    session?.producers.delete(producerId);
    void room.audioLevelObserver.removeProducer({ producerId }).catch(() => undefined);
    if (!record.producer.closed) {
      record.producer.close();
    }
    this.setSpeaking(room, record.summary.userId, false);
    if (notify) {
      this.options.events?.onProducerClosed?.(record.summary);
    }
    return record.summary;
  }

  private setSpeaking(room: VoiceRoom, userId: string, speaking: boolean, volume?: number): void {
    const alreadySpeaking = room.speakingUserIds.has(userId);
    if (speaking === alreadySpeaking) {
      return;
    }
    if (speaking) {
      room.speakingUserIds.add(userId);
    } else {
      room.speakingUserIds.delete(userId);
    }
    this.options.events?.onSpeaking?.({
      channelId: room.channelId,
      userId,
      speaking,
      volume,
    });
  }

  private maybeCloseRoom(channelId: string): void {
    const room = this.rooms.get(channelId);
    if (!room || room.sessions.size > 0 || room.producers.size > 0) {
      return;
    }

    room.audioLevelObserver.close();
    room.router.close();
    this.rooms.delete(channelId);
  }

  private buildIceServers(): RTCIceServer[] {
    const rtc = this.options.getConfig().rtc;
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
}
