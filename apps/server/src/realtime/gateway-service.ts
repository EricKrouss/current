import type { Server as HttpServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GatewayEnvelope } from '@current/protocol';
import { GatewayEvents } from '@current/protocol';
import type { CurrentUser, UserPresence, UserPresenceStatus } from '@current/types';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { AuthService } from '../auth/auth-service.js';
import type { MetricsService } from '../metrics/metrics-service.js';
import { id } from '../utils/id.js';
import { nowIso } from '../utils/time.js';

const MAX_CLIENT_PAYLOAD_BYTES = 64 * 1024;
const TYPING_REFRESH_BROADCAST_MS = 3_500;

interface ClientSession {
  user: CurrentUser;
  lastAckedSeq: number;
}

interface TypingState {
  channelId: string;
  userId: string;
  isTyping: boolean;
  emittedAt: number;
}

export class GatewayService {
  private wsServer?: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientSession>();
  private readonly socketsByUserId = new Map<string, Set<WebSocket>>();
  private readonly selectedPresenceByUserId = new Map<string, UserPresenceStatus>();
  private readonly typingStateByKey = new Map<string, TypingState>();

  constructor(
    private readonly repos: RepositoryBag,
    private readonly auth: AuthService,
    private readonly metrics: MetricsService,
  ) {}

  attach(server: HttpServer): void {
    this.wsServer = new WebSocketServer({
      noServer: true,
      path: '/gateway',
      maxPayload: MAX_CLIENT_PAYLOAD_BYTES,
    });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '', 'http://localhost');
      if (url.pathname !== '/gateway') {
        return;
      }

      this.wsServer?.handleUpgrade(request, socket, head, (client) => {
        this.wsServer?.emit('connection', client, request);
      });
    });

    this.wsServer.on('connection', (socket, request) => {
      const user = this.authenticateWs(request);
      if (!user) {
        socket.close(1008, 'Unauthorized');
        return;
      }

      const url = new URL(request.url ?? '', 'http://localhost');
      const lastSeq = Number(url.searchParams.get('lastEventSeq') ?? '0');

      const clientSession: ClientSession = {
        user,
        lastAckedSeq: 0,
      };

      const hadConnectedClients = this.hasConnectedUser(user.id);
      this.registerClient(socket, clientSession);
      this.metrics.onWsConnected();

      this.send(socket, {
        id: id('evt'),
        type: GatewayEvents.READY,
        payload: {
          userId: user.id,
          serverId: this.repos.servers.getPrimaryServer()?.id,
          lastEventSeq: this.repos.gatewayEvents.latestSeq(),
        },
        sentAt: nowIso(),
      });

      if (lastSeq > 0) {
        this.replaySince(socket, lastSeq);
      }

      if (!hadConnectedClients) {
        this.broadcastPresenceForUser(user.id);
      }

      socket.on('message', (raw) => this.handleClientMessage(socket, raw.toString('utf8')));
      socket.on('close', () => {
        const closingSession = this.unregisterClient(socket);
        this.metrics.onWsDisconnected();
        if (closingSession && !this.hasConnectedUser(closingSession.user.id)) {
          this.clearTypingForUser(closingSession.user.id);
          this.broadcastPresenceForUser(closingSession.user.id);
        }
      });
    });
  }

  getSelectedPresenceStatus(userId: string): UserPresenceStatus {
    const cached = this.selectedPresenceByUserId.get(userId);
    if (cached) {
      return cached;
    }

    const stored = this.repos.users.getPresenceStatus(userId);
    this.selectedPresenceByUserId.set(userId, stored);
    return stored;
  }

  setSelectedPresenceStatus(userId: string, status: UserPresenceStatus): UserPresence {
    this.repos.users.setPresenceStatus(userId, status);
    this.selectedPresenceByUserId.set(userId, status);
    this.broadcastPresenceForUser(userId);
    return this.getPresenceForViewer(userId, userId);
  }

  listPresenceForViewer(viewerUserId: string): UserPresence[] {
    const userIds = new Set<string>([viewerUserId]);
    for (const userId of this.socketsByUserId.keys()) {
      userIds.add(userId);
    }

    return [...userIds]
      .map((userId) => this.getPresenceForViewer(userId, viewerUserId))
      .filter((presence) => presence.status !== 'offline' || presence.userId === viewerUserId);
  }

  broadcast<T>(type: string, payload: T): number {
    const eventId = id('evt');
    const seq = this.repos.gatewayEvents.append({
      eventId,
      type,
      payload: payload as Record<string, unknown>,
    });

    const envelope: GatewayEnvelope = {
      id: eventId,
      type,
      payload,
      seq,
      sentAt: nowIso(),
    };
    const serialized = JSON.stringify(envelope);

    for (const [socket] of this.clients) {
      this.sendSerialized(socket, serialized);
    }

    return seq;
  }

  broadcastEphemeral<T>(type: string, payload: T): void {
    const envelope: GatewayEnvelope = {
      id: id('evt'),
      type,
      payload,
      sentAt: nowIso(),
    };
    const serialized = JSON.stringify(envelope);

    for (const [socket] of this.clients) {
      this.sendSerialized(socket, serialized);
    }
  }

  disconnectAll(reason = 'Server reset'): void {
    for (const socket of this.clients.keys()) {
      socket.close(1012, reason);
    }
    this.clients.clear();
    this.socketsByUserId.clear();
    this.selectedPresenceByUserId.clear();
    this.typingStateByKey.clear();
  }

  sendToUser<T>(userId: string, type: string, payload: T): void {
    const eventId = id('evt');
    const seq = this.repos.gatewayEvents.append({
      eventId,
      type,
      payload: payload as Record<string, unknown>,
    });

    const envelope: GatewayEnvelope = {
      id: eventId,
      type,
      payload,
      seq,
      sentAt: nowIso(),
    };
    const serialized = JSON.stringify(envelope);

    for (const socket of this.socketsByUserId.get(userId) ?? []) {
      this.sendSerialized(socket, serialized);
    }
  }

  broadcastTypingUpdate(input: { channelId: string; userId: string; isTyping: boolean }): void {
    const key = `${input.channelId}:${input.userId}`;
    const now = Date.now();
    const previous = this.typingStateByKey.get(key);

    if (previous && previous.isTyping === input.isTyping) {
      if (!input.isTyping || now - previous.emittedAt < TYPING_REFRESH_BROADCAST_MS) {
        return;
      }
    }

    if (input.isTyping) {
      this.typingStateByKey.set(key, {
        channelId: input.channelId,
        userId: input.userId,
        isTyping: true,
        emittedAt: now,
      });
    } else {
      this.typingStateByKey.delete(key);
    }

    this.broadcastEphemeral(GatewayEvents.TYPING_UPDATE, {
      channelId: input.channelId,
      userId: input.userId,
      isTyping: input.isTyping,
    });
  }

  private hasConnectedUser(userId: string): boolean {
    return (this.socketsByUserId.get(userId)?.size ?? 0) > 0;
  }

  private getPresenceForViewer(userId: string, viewerUserId: string): UserPresence {
    const selectedStatus = this.getSelectedPresenceStatus(userId);
    const connected = this.hasConnectedUser(userId);

    if (!connected) {
      return {
        userId,
        status: 'offline',
        connected: false,
      };
    }

    if (selectedStatus === 'invisible' && userId !== viewerUserId) {
      return {
        userId,
        status: 'offline',
        connected: false,
      };
    }

    return {
      userId,
      status: selectedStatus,
      connected: true,
    };
  }

  private broadcastPresenceForUser(userId: string): void {
    const sentAt = nowIso();
    for (const [socket, session] of this.clients) {
      this.send(socket, {
        id: id('evt'),
        type: GatewayEvents.PRESENCE_UPDATE,
        payload: {
          presence: this.getPresenceForViewer(userId, session.user.id),
        },
        sentAt,
      });
    }
  }

  private clearTypingForUser(userId: string): void {
    for (const [key, state] of this.typingStateByKey) {
      if (state.userId !== userId) {
        continue;
      }

      this.typingStateByKey.delete(key);
      this.broadcastEphemeral(GatewayEvents.TYPING_UPDATE, {
        channelId: state.channelId,
        userId,
        isTyping: false,
      });
    }
  }

  private authenticateWs(request: IncomingMessage): CurrentUser | null {
    const url = new URL(request.url ?? '', 'http://localhost');
    const sessionToken =
      url.searchParams.get('session') ??
      this.readSessionFromCookieHeader(request.headers.cookie ?? undefined);

    return this.auth.getUserBySession(sessionToken ?? undefined);
  }

  private readSessionFromCookieHeader(cookieHeader?: string): string | null {
    if (!cookieHeader) {
      return null;
    }

    for (const part of cookieHeader.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith('current_session=')) {
        return decodeURIComponent(trimmed.slice('current_session='.length));
      }
    }

    return null;
  }

  private replaySince(socket: WebSocket, seq: number): void {
    const records = this.repos.gatewayEvents.listSince(seq);
    for (const record of records) {
      this.send(socket, {
        id: record.eventId,
        type: record.type,
        payload: record.payload,
        seq: record.seq,
        sentAt: record.createdAt,
      });
    }
  }

  private handleClientMessage(socket: WebSocket, raw: string): void {
    let envelope: GatewayEnvelope;
    try {
      envelope = JSON.parse(raw) as GatewayEnvelope;
    } catch {
      this.send(socket, {
        id: id('evt'),
        type: GatewayEvents.ERROR,
        payload: { code: 'BAD_PAYLOAD', message: 'Malformed gateway payload.' },
        sentAt: nowIso(),
      });
      return;
    }

    if (envelope.type === 'ACK') {
      this.recordAck(socket, envelope);
      return;
    }

    if (envelope.type === 'PING') {
      this.send(socket, {
        id: id('evt'),
        type: GatewayEvents.PONG,
        payload: {
          now: Date.now(),
        },
        sentAt: nowIso(),
      });
      return;
    }

    this.send(socket, {
      id: id('evt'),
      type: GatewayEvents.ACK,
      payload: {
        receivedId: envelope.id,
      },
      sentAt: nowIso(),
    });
  }

  private send(socket: WebSocket, envelope: GatewayEnvelope): void {
    this.sendSerialized(socket, JSON.stringify(envelope));
  }

  private sendSerialized(socket: WebSocket, serializedEnvelope: string): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(serializedEnvelope);
    }
  }

  private registerClient(socket: WebSocket, session: ClientSession): void {
    this.clients.set(socket, session);
    let sockets = this.socketsByUserId.get(session.user.id);
    if (!sockets) {
      sockets = new Set<WebSocket>();
      this.socketsByUserId.set(session.user.id, sockets);
    }
    sockets.add(socket);
  }

  private unregisterClient(socket: WebSocket): ClientSession | undefined {
    const session = this.clients.get(socket);
    if (!session) {
      return undefined;
    }

    this.clients.delete(socket);
    const sockets = this.socketsByUserId.get(session.user.id);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        this.socketsByUserId.delete(session.user.id);
      }
    }

    return session;
  }

  private recordAck(socket: WebSocket, envelope: GatewayEnvelope): void {
    const session = this.clients.get(socket);
    if (!session || typeof envelope.payload !== 'object' || !envelope.payload) {
      return;
    }

    const payload = envelope.payload as { seq?: number };
    if (typeof payload.seq === 'number') {
      session.lastAckedSeq = Math.max(payload.seq, session.lastAckedSeq);
    }
  }
}
