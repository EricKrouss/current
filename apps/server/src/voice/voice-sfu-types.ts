import type { CurrentConfig } from '@current/config';

export type VoiceTransportDirection = 'send' | 'recv';

export interface VoiceProducerSummary {
  id: string;
  userId: string;
  channelId: string;
  kind: 'audio';
  paused: boolean;
}

export interface VoiceTransportInfo {
  id: string;
  direction: VoiceTransportDirection;
  iceParameters: unknown;
  iceCandidates: unknown[];
  dtlsParameters: unknown;
}

export interface VoiceIceRestartInfo {
  iceParameters: unknown;
}

export interface VoiceConsumerInfo {
  id: string;
  producerId: string;
  userId: string;
  kind: 'audio';
  rtpParameters: unknown;
  paused: boolean;
}

export interface VoiceJoinMedia {
  sessionId: string;
  rtpCapabilities: unknown;
  iceServers: RTCIceServer[];
  producers: VoiceProducerSummary[];
}

export interface VoiceSessionCloseResult {
  sessionId: string;
  userId: string;
  channelId: string;
  producers: VoiceProducerSummary[];
}

export interface VoiceSfuEvents {
  onProducerClosed?: (producer: VoiceProducerSummary) => void;
  onSpeaking?: (event: { channelId: string; userId: string; speaking: boolean; volume?: number }) => void;
}

export interface VoiceSfuAdapter {
  join(input: { sessionId: string; userId: string; channelId: string }): Promise<VoiceJoinMedia>;
  createTransport(input: {
    sessionId: string;
    direction: VoiceTransportDirection;
  }): Promise<VoiceTransportInfo>;
  connectTransport(input: {
    sessionId: string;
    transportId: string;
    dtlsParameters: unknown;
  }): Promise<void>;
  restartTransportIce(input: {
    sessionId: string;
    transportId: string;
  }): Promise<VoiceIceRestartInfo>;
  produce(input: {
    sessionId: string;
    transportId: string;
    kind: 'audio';
    rtpParameters: unknown;
    paused?: boolean;
  }): Promise<VoiceProducerSummary>;
  consume(input: {
    sessionId: string;
    transportId: string;
    producerId: string;
    rtpCapabilities: unknown;
  }): Promise<VoiceConsumerInfo>;
  resumeConsumer(input: {
    sessionId: string;
    consumerId: string;
  }): Promise<void>;
  closeSession(sessionId: string): Promise<VoiceSessionCloseResult | null>;
  closeUserSession(userId: string): Promise<VoiceSessionCloseResult | null>;
  setProducerPaused(input: {
    sessionId: string;
    producerId: string;
    paused: boolean;
  }): Promise<VoiceProducerSummary | null>;
  touchSession(sessionId: string): void;
  closeStaleSessions(maxAgeMs: number): Promise<VoiceSessionCloseResult[]>;
  listChannelProducers(channelId: string): VoiceProducerSummary[];
  diagnostics(): {
    rooms: number;
    sessions: number;
    producers: number;
    workerCount: number;
  };
  close(): Promise<void>;
}

export interface VoiceSfuAdapterOptions {
  getConfig: () => CurrentConfig;
  events?: VoiceSfuEvents;
}
