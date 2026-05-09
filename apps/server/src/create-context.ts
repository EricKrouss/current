import type { CurrentConfig } from '@current/config';
import type { DatabaseSync } from 'node:sqlite';
import { createRepositories } from './db/repositories/index.js';
import { MetricsService } from './metrics/metrics-service.js';
import { ServerConfigService } from './services/server-config-service.js';
import { AuthService } from './auth/auth-service.js';
import { SetupService } from './setup/setup-service.js';
import { ModerationService } from './services/moderation-service.js';
import { InviteService } from './services/invite-service.js';
import { MemberService } from './services/member-service.js';
import { ChatService } from './services/chat-service.js';
import { VoiceService } from './voice/voice-service.js';
import type { VoiceSfuAdapter } from './voice/voice-sfu-types.js';
import { GatewayService } from './realtime/gateway-service.js';
import type { AppContext } from './types/context.js';
import { GatewayEvents } from '@current/protocol';

export function createAppContext(input: {
  db: DatabaseSync;
  configPath: string;
  config: CurrentConfig;
  voiceSfu?: VoiceSfuAdapter;
}): AppContext {
  const repos = createRepositories(input.db);
  const metrics = new MetricsService();
  const serverConfig = new ServerConfigService(input.configPath, input.config);
  const auth = new AuthService(repos, serverConfig);
  const setup = new SetupService(repos, serverConfig, input.db);
  const moderation = new ModerationService(repos, metrics);
  const invites = new InviteService(repos);
  const members = new MemberService(repos, () => serverConfig.get());
  const chat = new ChatService(repos, metrics, moderation, () => serverConfig.get());
  const gateway = new GatewayService(repos, auth, metrics);
  const voice = new VoiceService(
    repos,
    metrics,
    () => serverConfig.get(),
    {
      onProducerClosed: (producer) => {
        gateway.broadcastEphemeral(GatewayEvents.VOICE_PRODUCER_REMOVED, {
          producerId: producer.id,
          channelId: producer.channelId,
          userId: producer.userId,
        });
      },
      onSpeaking: (event) => {
        gateway.broadcastEphemeral(GatewayEvents.VOICE_SPEAKING, event);
      },
    },
    input.voiceSfu,
  );

  return {
    db: input.db,
    repos,
    config: serverConfig.get(),
    configPath: input.configPath,
    metrics,
    auth,
    setup,
    chat,
    moderation,
    invites,
    members,
    voice,
    gateway,
    serverConfig,
  };
}
