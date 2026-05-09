export type ISODate = string;

export type RegistrationMode = 'invite_only' | 'open_signup' | 'manual_approval';

export interface PageInfo {
  hasMore: boolean;
  nextCursor?: string;
}

export interface PageResponse<T> {
  items: T[];
  pageInfo: PageInfo;
}

export interface CurrentUser {
  id: string;
  did: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  roleIds: string[];
  createdAt: ISODate;
}

export interface PanelBackgroundAppearance {
  attachmentId?: string;
  url?: string;
}

export interface ServerAppearance {
  background: PanelBackgroundAppearance;
  panelColor?: string;
  ownMessageColor?: string;
  otherMessageColor?: string;
}

export type UserPresenceStatus = 'online' | 'away' | 'dnd' | 'invisible';
export type UserPresenceDisplayStatus = UserPresenceStatus | 'offline';

export interface UserPresence {
  userId: string;
  status: UserPresenceDisplayStatus;
  connected: boolean;
}

export interface CurrentServer {
  id: string;
  name: string;
  slug: string;
  registrationMode: RegistrationMode;
  iconAttachmentId?: string;
  bannerAttachmentId?: string;
  iconUrl?: string;
  bannerUrl?: string;
  appearance?: ServerAppearance;
  createdAt: ISODate;
}

export type ChannelType = 'category' | 'text' | 'voice' | 'dm';

export interface Channel {
  id: string;
  serverId: string;
  categoryId?: string;
  name: string;
  type: ChannelType;
  topic?: string;
  slowmodeSeconds: number;
  locked: boolean;
  position: number;
}

export interface EncryptedMessageContent {
  version: 1;
  algorithm: 'AES-GCM';
  keyId: string;
  nonce: string;
  ciphertext: string;
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  encryptedContent?: EncryptedMessageContent;
  parentMessageId?: string;
  attachments?: Attachment[];
  gifUrl?: string;
  createdAt: ISODate;
  updatedAt?: ISODate;
  deletedAt?: ISODate;
  reactions?: MessageReaction[];
}

export interface MessageReaction {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface Attachment {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  path: string;
}

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color: string;
  position: number;
  permissions: Permission[];
}

export type Permission =
  | 'ADMINISTRATOR'
  | 'MANAGE_SERVER'
  | 'MANAGE_CHANNELS'
  | 'MANAGE_ROLES'
  | 'MODERATE_MEMBERS'
  | 'MANAGE_MESSAGES'
  | 'SEND_MESSAGES'
  | 'CONNECT_VOICE'
  | 'SPEAK_VOICE'
  | 'ATTACH_FILES'
  | 'USE_GIFS';

export interface ChannelPermissionOverwrite {
  id: string;
  channelId: string;
  targetType: 'role' | 'user';
  targetId: string;
  allow: Permission[];
  deny: Permission[];
}

export interface Invite {
  code: string;
  serverId: string;
  channelId?: string;
  maxUses?: number;
  usedCount: number;
  expiresAt?: ISODate;
  createdBy: string;
  revoked?: boolean;
}

export interface AutomodRule {
  id: string;
  serverId: string;
  name: string;
  type: 'keyword' | 'regex' | 'mention_spam' | 'link_policy';
  enabled: boolean;
  payload: Record<string, unknown>;
  createdAt: ISODate;
}

export interface ModerationAction {
  id: string;
  serverId: string;
  actorId: string;
  targetUserId: string;
  type: 'ban' | 'mute' | 'timeout' | 'kick' | 'warn';
  reason?: string;
  expiresAt?: ISODate;
  createdAt: ISODate;
}

export interface VoiceState {
  userId: string;
  channelId: string;
  muted: boolean;
  deafened: boolean;
  pushToTalk: boolean;
  speaking: boolean;
  connectedAt: ISODate;
}

export interface VoiceProducer {
  id: string;
  userId: string;
  channelId: string;
  kind: 'audio';
  paused: boolean;
}

export interface AckEnvelope<TType extends string, TPayload> {
  id: string;
  type: TType;
  payload: TPayload;
  sentAt: ISODate;
}
