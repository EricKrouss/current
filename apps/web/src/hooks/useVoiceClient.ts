import { useCallback, useEffect, useRef, useState } from 'react';
import { Device } from 'mediasoup-client';
import type { types as mediasoupClientTypes } from 'mediasoup-client';
import type { VoiceProducer, VoiceState } from '@current/types';
import { apiPost, apiPatch } from '../lib/api';
import type { GatewayEnvelope } from './useGateway';

type VoiceConnectionStatus =
  | 'idle'
  | 'requesting_microphone'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'permission_denied'
  | 'insecure_origin'
  | 'failed';

const VOICE_STATS_INTERVAL_MS = 2_000;
const VOICE_ICE_RESTART_BASE_DELAY_MS = 700;
const VOICE_ICE_RESTART_MAX_ATTEMPTS = 4;

interface VoiceJoinResponse {
  voiceState: VoiceState;
  sessionId: string;
  rtpCapabilities: mediasoupClientTypes.RtpCapabilities;
  iceServers: RTCIceServer[];
  producers: VoiceProducer[];
}

interface VoiceTransportInfo {
  id: string;
  direction: 'send' | 'recv';
  iceParameters: mediasoupClientTypes.IceParameters;
  iceCandidates: mediasoupClientTypes.IceCandidate[];
  dtlsParameters: mediasoupClientTypes.DtlsParameters;
}

interface VoiceConsumerInfo {
  id: string;
  producerId: string;
  userId: string;
  kind: 'audio';
  rtpParameters: mediasoupClientTypes.RtpParameters;
}

interface VoiceProducerResponse {
  producer: VoiceProducer;
}

interface VoiceConsumerResponse {
  consumer: VoiceConsumerInfo;
}

interface VoiceIceRestartResponse {
  iceParameters: mediasoupClientTypes.IceParameters;
}

export interface VoiceRemoteStream {
  producerId: string;
  userId: string;
  stream: MediaStream;
}

export interface VoiceNetworkDiagnostics {
  sendState: string;
  recvState: string;
  transportProtocol: 'udp' | 'tcp' | 'unknown';
  candidateType: 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';
  roundTripMs?: number;
  jitterMs?: number;
  packetLossPct?: number;
  restarts: number;
  recovering: boolean;
}

interface VoiceSessionRef {
  sessionId: string;
  channelId: string;
  iceServers: RTCIceServer[];
}

type MediasoupDevice = Device;
type MediasoupTransport = ReturnType<Device['createSendTransport']>;
type MediasoupProducer = Awaited<ReturnType<MediasoupTransport['produce']>>;
type MediasoupConsumer = Awaited<ReturnType<MediasoupTransport['consume']>>;

const DEFAULT_VOICE_DIAGNOSTICS: VoiceNetworkDiagnostics = {
  sendState: 'idle',
  recvState: 'idle',
  transportProtocol: 'unknown',
  candidateType: 'unknown',
  restarts: 0,
  recovering: false,
};

function canUseMicrophoneOnThisOrigin(): boolean {
  if (window.isSecureContext) {
    return true;
  }

  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isPermissionDenied(error: unknown): boolean {
  return error instanceof DOMException && (
    error.name === 'NotAllowedError' ||
    error.name === 'PermissionDeniedError' ||
    error.name === 'SecurityError'
  );
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return filtered.length > 0 ? Math.max(...filtered) : undefined;
}

function roundOptional(value: number | undefined, digits = 0): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function collectTransportDiagnostics(report: RTCStatsReport): Partial<VoiceNetworkDiagnostics> {
  const statsById = new Map<string, Record<string, unknown>>();
  let selectedPair: Record<string, unknown> | undefined;
  let selectedPairId: string | undefined;
  let jitterMs: number | undefined;
  let roundTripMs: number | undefined;
  let packetLossPct: number | undefined;

  report.forEach((stat) => {
    const record = stat as Record<string, unknown>;
    const id = readString(record.id);
    if (id) {
      statsById.set(id, record);
    }
    if (record.type === 'transport') {
      selectedPairId = readString(record.selectedCandidatePairId);
    }
    if (record.type === 'candidate-pair') {
      const selected = readBoolean(record.selected) || (readBoolean(record.nominated) && record.state === 'succeeded');
      if (selected) {
        selectedPair = record;
      }
    }
    if (record.type === 'inbound-rtp' && (record.kind === 'audio' || record.mediaType === 'audio')) {
      const received = readNumber(record.packetsReceived);
      const lost = Math.max(0, readNumber(record.packetsLost) ?? 0);
      if (received !== undefined && received + lost > 0) {
        packetLossPct = roundOptional((lost / (received + lost)) * 100, 1);
      }
      jitterMs = maxDefined(jitterMs, (readNumber(record.jitter) ?? 0) * 1000);
    }
    if (record.type === 'remote-inbound-rtp' && (record.kind === 'audio' || record.mediaType === 'audio')) {
      roundTripMs = maxDefined(roundTripMs, (readNumber(record.roundTripTime) ?? 0) * 1000);
      jitterMs = maxDefined(jitterMs, (readNumber(record.jitter) ?? 0) * 1000);
    }
  });

  if (selectedPairId) {
    const pair = statsById.get(selectedPairId);
    if (pair) {
      selectedPair = pair;
    }
  }

  const localCandidateId = readString(selectedPair?.localCandidateId);
  const localCandidate = localCandidateId ? statsById.get(localCandidateId) : undefined;
  const pairRoundTripMs = (readNumber(selectedPair?.currentRoundTripTime) ?? 0) * 1000;

  return {
    transportProtocol: readString(localCandidate?.protocol) === 'tcp' ? 'tcp' : readString(localCandidate?.protocol) === 'udp' ? 'udp' : 'unknown',
    candidateType: ['host', 'srflx', 'prflx', 'relay'].includes(readString(localCandidate?.candidateType) ?? '')
      ? readString(localCandidate?.candidateType) as VoiceNetworkDiagnostics['candidateType']
      : 'unknown',
    roundTripMs: roundOptional(maxDefined(roundTripMs, pairRoundTripMs)),
    jitterMs: roundOptional(jitterMs, 1),
    packetLossPct,
  };
}

export function useVoiceClient({ currentUserId }: { currentUserId?: string }) {
  const [status, setStatus] = useState<VoiceConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<VoiceRemoteStream[]>([]);
  const [inputLevel, setInputLevel] = useState(0);
  const [diagnostics, setDiagnostics] = useState<VoiceNetworkDiagnostics>(DEFAULT_VOICE_DIAGNOSTICS);
  const sessionRef = useRef<VoiceSessionRef | null>(null);
  const deviceRef = useRef<MediasoupDevice | null>(null);
  const sendTransportRef = useRef<MediasoupTransport | null>(null);
  const recvTransportRef = useRef<MediasoupTransport | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localProducerRef = useRef<MediasoupProducer | null>(null);
  const localProducerTrackRef = useRef<MediaStreamTrack | null>(null);
  const localProducerPausedRef = useRef<boolean | null>(null);
  const remoteConsumersRef = useRef<Map<string, { userId: string; stream: MediaStream; consumer: MediasoupConsumer }>>(new Map());
  const heartbeatTimerRef = useRef<number | null>(null);
  const diagnosticsTimerRef = useRef<number | null>(null);
  const recoveryTimersRef = useRef<Map<string, number>>(new Map());
  const recoveryAttemptsRef = useRef<Map<string, number>>(new Map());
  const iceRestartInFlightRef = useRef<Set<string>>(new Set());
  const iceRestartCountRef = useRef(0);
  const transportStatesRef = useRef<{ send: string; recv: string }>({ send: 'idle', recv: 'idle' });
  const inputMeterRef = useRef<{
    analyser: AnalyserNode;
    context: AudioContext;
    data: Uint8Array;
    rafId: number;
    source: MediaStreamAudioSourceNode;
  } | null>(null);
  const inputLevelRef = useRef(0);
  const inputLevelEmitRef = useRef(0);
  const joinGenerationRef = useRef(0);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current !== null) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  const sampleVoiceDiagnostics = useCallback(async () => {
    const sendTransport = sendTransportRef.current;
    const recvTransport = recvTransportRef.current;
    const getTransportDiagnostics = (transport: MediasoupTransport | null): Promise<Partial<VoiceNetworkDiagnostics>> => (
      transport && !transport.closed
        ? transport.getStats().then(collectTransportDiagnostics).catch(() => ({}))
        : Promise.resolve({})
    );
    const [sendStats, recvStats] = await Promise.all([
      getTransportDiagnostics(sendTransport),
      getTransportDiagnostics(recvTransport),
    ]);

    const transportProtocol =
      recvStats.transportProtocol && recvStats.transportProtocol !== 'unknown'
        ? recvStats.transportProtocol
        : sendStats.transportProtocol ?? 'unknown';
    const candidateType =
      recvStats.candidateType && recvStats.candidateType !== 'unknown'
        ? recvStats.candidateType
        : sendStats.candidateType ?? 'unknown';

    setDiagnostics({
      sendState: transportStatesRef.current.send,
      recvState: transportStatesRef.current.recv,
      transportProtocol,
      candidateType,
      roundTripMs: roundOptional(maxDefined(sendStats.roundTripMs, recvStats.roundTripMs)),
      jitterMs: roundOptional(maxDefined(sendStats.jitterMs, recvStats.jitterMs), 1),
      packetLossPct: roundOptional(maxDefined(sendStats.packetLossPct, recvStats.packetLossPct), 1),
      restarts: iceRestartCountRef.current,
      recovering: iceRestartInFlightRef.current.size > 0,
    });
  }, []);

  const clearDiagnosticsTimer = useCallback(() => {
    if (diagnosticsTimerRef.current !== null) {
      window.clearInterval(diagnosticsTimerRef.current);
      diagnosticsTimerRef.current = null;
    }
  }, []);

  const startDiagnosticsTimer = useCallback(() => {
    clearDiagnosticsTimer();
    void sampleVoiceDiagnostics();
    diagnosticsTimerRef.current = window.setInterval(() => {
      void sampleVoiceDiagnostics();
    }, VOICE_STATS_INTERVAL_MS);
  }, [clearDiagnosticsTimer, sampleVoiceDiagnostics]);

  const clearRecoveryTimers = useCallback(() => {
    for (const timer of recoveryTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    recoveryTimersRef.current.clear();
    recoveryAttemptsRef.current.clear();
    iceRestartInFlightRef.current.clear();
  }, []);

  const restartTransportIce = useCallback(async (
    transport: MediasoupTransport,
    sessionId: string,
  ) => {
    if (transport.closed || iceRestartInFlightRef.current.has(transport.id)) {
      return;
    }

    iceRestartInFlightRef.current.add(transport.id);
    setStatus((current) => current === 'failed' || current === 'idle' ? current : 'reconnecting');
    setDiagnostics((current) => ({
      ...current,
      recovering: true,
    }));

    try {
      const { iceParameters } = await apiPost<VoiceIceRestartResponse>(
        `/api/v1/voice/transports/${transport.id}/restart-ice`,
        { sessionId },
      );
      await transport.restartIce({ iceParameters });
      iceRestartCountRef.current += 1;
      void sampleVoiceDiagnostics();
    } finally {
      iceRestartInFlightRef.current.delete(transport.id);
      setDiagnostics((current) => ({
        ...current,
        restarts: iceRestartCountRef.current,
        recovering: iceRestartInFlightRef.current.size > 0,
      }));
    }
  }, [sampleVoiceDiagnostics]);

  const scheduleTransportIceRestart = useCallback((
    transport: MediasoupTransport,
    sessionId: string,
  ) => {
    if (transport.closed || recoveryTimersRef.current.has(transport.id)) {
      return;
    }

    const attempt = (recoveryAttemptsRef.current.get(transport.id) ?? 0) + 1;
    recoveryAttemptsRef.current.set(transport.id, attempt);
    if (attempt > VOICE_ICE_RESTART_MAX_ATTEMPTS) {
      setError('Voice connection could not recover. Try rejoining the channel.');
      setStatus('failed');
      return;
    }

    const delay = attempt === 1
      ? 0
      : Math.min(5_000, VOICE_ICE_RESTART_BASE_DELAY_MS * 2 ** (attempt - 2));
    setStatus((current) => current === 'failed' || current === 'idle' ? current : 'reconnecting');
    setDiagnostics((current) => ({
      ...current,
      recovering: true,
    }));

    const timer = window.setTimeout(() => {
      recoveryTimersRef.current.delete(transport.id);
      void restartTransportIce(transport, sessionId).catch((error) => {
        if (!transport.closed) {
          setError(error instanceof Error ? error.message : 'Voice ICE restart failed.');
          scheduleTransportIceRestart(transport, sessionId);
        }
      });
    }, delay);
    recoveryTimersRef.current.set(transport.id, timer);
  }, [restartTransportIce]);

  const bindTransportRecovery = useCallback((
    transport: MediasoupTransport,
    sessionId: string,
    direction: 'send' | 'recv',
  ) => {
    transport.on('connectionstatechange', (state) => {
      transportStatesRef.current = {
        ...transportStatesRef.current,
        [direction]: state,
      };
      void sampleVoiceDiagnostics();

      if (state === 'connected') {
        const timer = recoveryTimersRef.current.get(transport.id);
        if (timer) {
          window.clearTimeout(timer);
          recoveryTimersRef.current.delete(transport.id);
        }
        recoveryAttemptsRef.current.delete(transport.id);
        setError(null);
        setStatus((current) => current === 'failed' || current === 'idle' ? current : 'connected');
        setDiagnostics((current) => ({
          ...current,
          recovering: iceRestartInFlightRef.current.size > 0,
        }));
        return;
      }

      if (state === 'disconnected' || state === 'failed') {
        scheduleTransportIceRestart(transport, sessionId);
        return;
      }

      if (state === 'connecting') {
        setStatus((current) => current === 'connected' ? 'reconnecting' : current);
      }
    });

    transport.on('icecandidateerror', () => {
      scheduleTransportIceRestart(transport, sessionId);
    });
  }, [sampleVoiceDiagnostics, scheduleTransportIceRestart]);

  const resetInputLevel = useCallback(() => {
    inputLevelRef.current = 0;
    inputLevelEmitRef.current = 0;
    setInputLevel(0);
  }, []);

  const stopInputMeter = useCallback(() => {
    const meter = inputMeterRef.current;
    if (!meter) {
      resetInputLevel();
      return;
    }
    window.cancelAnimationFrame(meter.rafId);
    meter.source.disconnect();
    meter.analyser.disconnect();
    void meter.context.close().catch(() => undefined);
    inputMeterRef.current = null;
    resetInputLevel();
  }, [resetInputLevel]);

  const startInputMeter = useCallback((stream: MediaStream) => {
    stopInputMeter();
    const AudioContextConstructor =
      window.AudioContext ??
      (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) {
      resetInputLevel();
      return;
    }

    const context = new AudioContextConstructor();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);

    const data = new Uint8Array(analyser.fftSize);
    let lastEmitAt = 0;
    const tick = (time: number) => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const sample of data) {
        const centered = (sample - 128) / 128;
        sum += centered * centered;
      }

      const rms = Math.sqrt(sum / data.length);
      const normalized = Math.min(1, Math.max(0, (rms - 0.006) / 0.075));
      const smoothed = inputLevelRef.current * 0.58 + normalized * 0.42;
      inputLevelRef.current = smoothed < 0.006 ? 0 : smoothed;

      if (
        time - lastEmitAt > 66 &&
        Math.abs(inputLevelRef.current - inputLevelEmitRef.current) > 0.012
      ) {
        lastEmitAt = time;
        inputLevelEmitRef.current = inputLevelRef.current;
        setInputLevel(Number(inputLevelRef.current.toFixed(2)));
      }

      const meter = inputMeterRef.current;
      if (meter) {
        if (meter.context.state === 'suspended') {
          void meter.context.resume().catch(() => undefined);
        }
        meter.rafId = window.requestAnimationFrame(tick);
      }
    };

    inputMeterRef.current = {
      analyser,
      context,
      data,
      rafId: window.requestAnimationFrame(tick),
      source,
    };
    void context.resume().catch(() => undefined);
  }, [resetInputLevel, stopInputMeter]);

  const refreshRemoteStreams = useCallback(() => {
    setRemoteStreams(
      [...remoteConsumersRef.current.entries()].map(([producerId, entry]) => ({
        producerId,
        userId: entry.userId,
        stream: entry.stream,
      })),
    );
  }, []);

  const removeRemoteProducer = useCallback((producerId: string) => {
    const existing = remoteConsumersRef.current.get(producerId);
    if (!existing) {
      return;
    }
    existing.consumer.close();
    for (const track of existing.stream.getTracks()) {
      track.stop();
    }
    remoteConsumersRef.current.delete(producerId);
    refreshRemoteStreams();
  }, [refreshRemoteStreams]);

  const cleanupLocal = useCallback((stopMicrophone: boolean) => {
    clearHeartbeat();
    clearDiagnosticsTimer();
    clearRecoveryTimers();
    for (const [producerId] of remoteConsumersRef.current) {
      removeRemoteProducer(producerId);
    }
    localProducerRef.current?.close();
    localProducerRef.current = null;
    localProducerTrackRef.current?.stop();
    localProducerTrackRef.current = null;
    localProducerPausedRef.current = null;
    sendTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current?.close();
    recvTransportRef.current = null;
    deviceRef.current = null;
    if (stopMicrophone) {
      stopInputMeter();
      for (const track of localStreamRef.current?.getTracks() ?? []) {
        track.stop();
      }
      localStreamRef.current = null;
    }
    sessionRef.current = null;
    transportStatesRef.current = { send: 'idle', recv: 'idle' };
    iceRestartCountRef.current = 0;
    setDiagnostics(DEFAULT_VOICE_DIAGNOSTICS);
    setRemoteStreams([]);
  }, [clearDiagnosticsTimer, clearHeartbeat, clearRecoveryTimers, removeRemoteProducer, stopInputMeter]);

  const createTransport = useCallback(async (
    channelId: string,
    sessionId: string,
    direction: 'send' | 'recv',
  ): Promise<MediasoupTransport> => {
    const device = deviceRef.current;
    if (!device) {
      throw new Error('Voice device is not ready.');
    }

    const transportOptions = await apiPost<VoiceTransportInfo>(
      `/api/v1/voice/channels/${channelId}/transports`,
      {
        sessionId,
        direction,
      },
    );

    const iceServers = sessionRef.current?.sessionId === sessionId ? sessionRef.current.iceServers : [];
    const transport = direction === 'send'
      ? device.createSendTransport({ ...transportOptions, iceServers })
      : device.createRecvTransport({ ...transportOptions, iceServers });

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      void apiPost<void>(`/api/v1/voice/transports/${transport.id}/connect`, {
        sessionId,
        dtlsParameters,
      })
        .then(callback)
        .catch(errback);
    });
    bindTransportRecovery(transport, sessionId, direction);

    return transport;
  }, [bindTransportRecovery]);

  const ensureRecvTransport = useCallback(async (channelId: string, sessionId: string) => {
    if (recvTransportRef.current) {
      return recvTransportRef.current;
    }
    const transport = await createTransport(channelId, sessionId, 'recv');
    recvTransportRef.current = transport;
    return transport;
  }, [createTransport]);

  const consumeProducer = useCallback(async (producer: VoiceProducer) => {
    const session = sessionRef.current;
    const device = deviceRef.current;
    if (!session || !device || producer.channelId !== session.channelId || producer.userId === currentUserId) {
      return;
    }
    if (remoteConsumersRef.current.has(producer.id)) {
      return;
    }

    const recvTransport = await ensureRecvTransport(session.channelId, session.sessionId);
    const { consumer: consumerOptions } = await apiPost<VoiceConsumerResponse>(
      `/api/v1/voice/transports/${recvTransport.id}/consume`,
      {
        sessionId: session.sessionId,
        producerId: producer.id,
        rtpCapabilities: device.rtpCapabilities,
      },
    );
    const consumer = await recvTransport.consume({
      id: consumerOptions.id,
      producerId: consumerOptions.producerId,
      kind: consumerOptions.kind,
      rtpParameters: consumerOptions.rtpParameters,
    });
    const stream = new MediaStream([consumer.track]);
    remoteConsumersRef.current.set(producer.id, {
      userId: consumerOptions.userId,
      stream,
      consumer,
    });
    refreshRemoteStreams();
    await apiPost<void>(`/api/v1/voice/consumers/${consumer.id}/resume`, {
      sessionId: session.sessionId,
    });
  }, [currentUserId, ensureRecvTransport, refreshRemoteStreams]);

  const setInputEnabled = useCallback((enabled: boolean) => {
    const producerTrack = localProducerTrackRef.current;
    if (producerTrack) {
      producerTrack.enabled = enabled;
    }

    const session = sessionRef.current;
    const producer = localProducerRef.current;
    const paused = !enabled;
    if (!session || !producer || localProducerPausedRef.current === paused) {
      return;
    }
    localProducerPausedRef.current = paused;
    void apiPatch(`/api/v1/voice/producers/${producer.id}`, {
      sessionId: session.sessionId,
      paused,
    }).catch(() => undefined);
  }, []);

  const join = useCallback(async (
    channelId: string,
    input: Pick<VoiceState, 'muted' | 'deafened' | 'pushToTalk'>,
  ): Promise<VoiceJoinResponse> => {
    joinGenerationRef.current += 1;
    const generation = joinGenerationRef.current;
    cleanupLocal(true);
    setError(null);

    if (!canUseMicrophoneOnThisOrigin()) {
      setStatus('insecure_origin');
      throw new Error('Voice requires HTTPS for non-localhost browser clients.');
    }

    try {
      setStatus('requesting_microphone');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
        video: false,
      });
      if (generation !== joinGenerationRef.current) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        throw new Error('Voice join was superseded.');
      }
      localStreamRef.current = stream;
      startInputMeter(stream);

      setStatus('connecting');
      const joined = await apiPost<VoiceJoinResponse>(`/api/v1/voice/channels/${channelId}/join`, {
        muted: input.muted,
        deafened: input.deafened,
        pushToTalk: input.pushToTalk,
      });
      sessionRef.current = {
        sessionId: joined.sessionId,
        channelId,
        iceServers: joined.iceServers,
      };

      const device = new Device();
      await device.load({
        routerRtpCapabilities: joined.rtpCapabilities,
      });
      deviceRef.current = device;

      const sendTransport = await createTransport(channelId, joined.sessionId, 'send');
      sendTransportRef.current = sendTransport;
      sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
        void apiPost<VoiceProducerResponse>(`/api/v1/voice/transports/${sendTransport.id}/produce`, {
          sessionId: joined.sessionId,
          kind,
          rtpParameters,
          paused: input.muted || input.pushToTalk,
        })
          .then(({ producer }) => {
            callback({ id: producer.id });
          })
          .catch(errback);
      });

      const sourceAudioTrack = stream.getAudioTracks()[0];
      if (!sourceAudioTrack) {
        throw new Error('No microphone audio track was returned.');
      }
      const producerTrack = sourceAudioTrack.clone();
      producerTrack.enabled = !input.muted && !input.pushToTalk;
      localProducerTrackRef.current = producerTrack;
      localProducerRef.current = await sendTransport.produce({
        track: producerTrack,
        codecOptions: {
          opusDtx: true,
          opusFec: true,
          opusMaxAverageBitrate: 28_000,
          opusPtime: 20,
          opusStereo: false,
        },
      });
      localProducerPausedRef.current = input.muted || input.pushToTalk;

      for (const producer of joined.producers) {
        void consumeProducer(producer).catch(() => undefined);
      }

      clearHeartbeat();
      heartbeatTimerRef.current = window.setInterval(() => {
        const current = sessionRef.current;
        if (current) {
          void apiPost<void>(`/api/v1/voice/sessions/${current.sessionId}/heartbeat`).catch(() => undefined);
        }
      }, 10_000);
      startDiagnosticsTimer();

      setStatus('connected');
      return joined;
    } catch (error) {
      cleanupLocal(true);
      const message = error instanceof Error ? error.message : 'Voice connection failed.';
      setError(message);
      setStatus(isPermissionDenied(error) ? 'permission_denied' : 'failed');
      throw error;
    }
  }, [cleanupLocal, clearHeartbeat, consumeProducer, createTransport, startDiagnosticsTimer, startInputMeter]);

  const leave = useCallback(async (fallbackChannelId?: string): Promise<void> => {
    joinGenerationRef.current += 1;
    const channelId = sessionRef.current?.channelId ?? fallbackChannelId;
    cleanupLocal(true);
    setStatus('idle');
    setError(null);
    if (channelId) {
      await apiPost<void>(`/api/v1/voice/channels/${channelId}/leave`).catch(() => undefined);
    }
  }, [cleanupLocal]);

  const handleGatewayEvent = useCallback((event: GatewayEnvelope) => {
    if (event.type === 'VOICE_PRODUCER_ADDED') {
      const payload = event.payload as { producer?: VoiceProducer };
      if (payload.producer) {
        void consumeProducer(payload.producer).catch(() => undefined);
      }
    }

    if (event.type === 'VOICE_PRODUCER_REMOVED') {
      const payload = event.payload as { producerId?: string };
      if (payload.producerId) {
        removeRemoteProducer(payload.producerId);
      }
    }
  }, [consumeProducer, removeRemoteProducer]);

  useEffect(() => () => cleanupLocal(true), [cleanupLocal]);

  return {
    status,
    error,
    inputLevel,
    diagnostics,
    remoteStreams,
    join,
    leave,
    setInputEnabled,
    handleGatewayEvent,
  };
}
