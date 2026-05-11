import type { DatabaseSync } from 'node:sqlite';
import { AccessRequestsRepository } from './access-requests-repository.js';
import { AuditRepository } from './audit-repository.js';
import { AutomodRepository } from './automod-repository.js';
import { ChannelsRepository } from './channels-repository.js';
import { GatewayEventsRepository } from './gateway-events-repository.js';
import { InvitesRepository } from './invites-repository.js';
import { MessagesRepository } from './messages-repository.js';
import { ModerationRepository } from './moderation-repository.js';
import { NotificationEventsRepository } from './notification-events-repository.js';
import { RolesRepository } from './roles-repository.js';
import { ServerRepository } from './server-repository.js';
import { SettingsRepository } from './settings-repository.js';
import { UserIpRepository } from './user-ip-repository.js';
import { UsersRepository } from './users-repository.js';
import { VoiceStatesRepository } from './voice-states-repository.js';

export interface RepositoryBag {
  settings: SettingsRepository;
  servers: ServerRepository;
  users: UsersRepository;
  userIps: UserIpRepository;
  roles: RolesRepository;
  channels: ChannelsRepository;
  messages: MessagesRepository;
  invites: InvitesRepository;
  accessRequests: AccessRequestsRepository;
  automod: AutomodRepository;
  moderation: ModerationRepository;
  notificationEvents: NotificationEventsRepository;
  audit: AuditRepository;
  gatewayEvents: GatewayEventsRepository;
  voiceStates: VoiceStatesRepository;
}

export function createRepositories(db: DatabaseSync): RepositoryBag {
  return {
    settings: new SettingsRepository(db),
    servers: new ServerRepository(db),
    users: new UsersRepository(db),
    userIps: new UserIpRepository(db),
    roles: new RolesRepository(db),
    channels: new ChannelsRepository(db),
    messages: new MessagesRepository(db),
    invites: new InvitesRepository(db),
    accessRequests: new AccessRequestsRepository(db),
    automod: new AutomodRepository(db),
    moderation: new ModerationRepository(db),
    notificationEvents: new NotificationEventsRepository(db),
    audit: new AuditRepository(db),
    gatewayEvents: new GatewayEventsRepository(db),
    voiceStates: new VoiceStatesRepository(db),
  };
}
