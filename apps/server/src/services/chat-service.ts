import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { lookup as lookupMime } from 'mime-types';
import type { Attachment, Channel, ChannelType, EncryptedMessageContent, Message, PageResponse } from '@current/types';
import type { RepositoryBag } from '../db/repositories/index.js';
import type { MetricsService } from '../metrics/metrics-service.js';
import type { ModerationService } from './moderation-service.js';
import type { CurrentConfig } from '@current/config';
import { containsLink, evaluateAutomod, extractMentionCount } from '../moderation/automod.js';

type GifProvider = CurrentConfig['media']['gifProvider'];

type GifProviderError = {
  provider: GifProvider;
  code: string;
  message: string;
};

type GifSearchResponse = {
  results: Array<{
    id: string;
    content_description: string;
    media_formats: {
      gif?: { url: string };
      tinygif?: { url: string };
      mp4?: { url: string };
    };
  }>;
  provider: GifProvider;
  fallbackProvider?: GifProvider;
  providerError?: GifProviderError;
  providerErrors?: GifProviderError[];
};

const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_PENDING_ATTACHMENTS_PER_USER = 20;
const MIN_PENDING_ATTACHMENT_BYTES_PER_USER = 64 * 1024 * 1024;
const BLOCKED_ATTACHMENT_MIME_TYPES = new Set([
  'application/xhtml+xml',
  'image/svg+xml',
  'text/html',
  'text/xml',
]);

function isPathInsideDirectory(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'GIF search failed.';
}

function getProviderLabel(provider: GifProvider): string {
  return provider === 'giphy' ? 'Giphy' : 'Klipy';
}

function toProviderError(provider: GifProvider, error: unknown): GifProviderError {
  return {
    provider,
    code: `${provider.toUpperCase()}_ERROR`,
    message: getErrorMessage(error),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function fetchJson(url: URL, provider: GifProvider): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${getProviderLabel(provider)} API error: ${text || response.statusText}`);
  }

  return response.json();
}

export class ChatService {
  private readonly lastMessageByUserChannel = new Map<string, number>();

  constructor(
    private readonly repos: RepositoryBag,
    private readonly metrics: MetricsService,
    private readonly moderation: ModerationService,
    private readonly getConfig: () => CurrentConfig,
  ) {
    mkdirSync(this.getConfig().storage.uploadDir, { recursive: true });
  }

  listChannelsPage(input: {
    serverId: string;
    limit: number;
    after?: { position?: number; createdAt: string; id: string };
  }): PageResponse<Channel> {
    return this.repos.channels.listPage(input);
  }

  getChannelById(channelId: string): Channel | null {
    return this.repos.channels.findById(channelId);
  }

  getMessageById(input: {
    messageId: string;
    serverId: string;
    identityMode?: 'all' | 'lan' | 'atproto';
  }): Message | null {
    const message = this.repos.messages.findById(input.messageId);
    if (!message || message.deletedAt) {
      return null;
    }

    const channel = this.repos.channels.findById(message.channelId);
    if (!channel || channel.serverId !== input.serverId) {
      return null;
    }

    const author = this.repos.users.findById(message.authorId);
    if (!author) {
      return null;
    }

    if (input.identityMode === 'lan' && !author.did.startsWith('did:current:lan:')) {
      return null;
    }

    if (input.identityMode === 'atproto' && author.did.startsWith('did:current:lan:')) {
      return null;
    }

    return message;
  }

  createChannel(input: {
    serverId: string;
    name: string;
    type: ChannelType;
    categoryId?: string | null;
    topic?: string;
    slowmodeSeconds?: number;
    position?: number;
    actorId: string;
  }): Channel {
    if (input.type !== 'category' && input.categoryId) {
      this.assertCategoryExists(input.serverId, input.categoryId);
    }

    const channel = this.repos.channels.create({
      ...input,
      categoryId: input.type === 'category' ? null : input.categoryId,
    });
    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'channel.create',
      targetType: 'channel',
      targetId: channel.id,
      payload: channel,
    });
    return channel;
  }

  updateChannel(input: {
    channelId: string;
    serverId: string;
    actorId: string;
    patch: Partial<Omit<Channel, 'id' | 'serverId' | 'categoryId'>> & { categoryId?: string | null };
  }): Channel | null {
    const existing = this.repos.channels.findById(input.channelId);
    if (!existing || existing.serverId !== input.serverId) {
      return null;
    }

    const nextType = input.patch.type ?? existing.type;
    const patch = {
      ...input.patch,
      categoryId: nextType === 'category' ? null : input.patch.categoryId,
    };

    if (nextType !== 'category' && patch.categoryId) {
      if (patch.categoryId === input.channelId) {
        throw new Error('A channel cannot be its own category.');
      }
      this.assertCategoryExists(input.serverId, patch.categoryId);
    }

    const channel = this.repos.channels.update(input.channelId, patch);
    if (!channel) {
      return null;
    }

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'channel.update',
      targetType: 'channel',
      targetId: channel.id,
      payload: input.patch as Record<string, unknown>,
    });

    return channel;
  }

  deleteChannel(input: { channelId: string; serverId: string; actorId: string }): boolean {
    const existing = this.repos.channels.findById(input.channelId);
    if (!existing || existing.serverId !== input.serverId) {
      return false;
    }

    this.repos.channels.delete(input.channelId);
    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'channel.delete',
      targetType: 'channel',
      targetId: input.channelId,
      payload: {},
    });
    return true;
  }

  reorderChannels(input: {
    serverId: string;
    actorId: string;
    items: Array<{ id: string; categoryId?: string | null; position: number }>;
  }): Channel[] {
    const existingChannels = this.repos.channels.listAll(input.serverId);
    const channelsById = new Map(existingChannels.map((channel) => [channel.id, channel]));
    const seen = new Set<string>();

    for (const item of input.items) {
      if (seen.has(item.id)) {
        throw new Error('Channel order contains duplicate items.');
      }
      seen.add(item.id);

      const channel = channelsById.get(item.id);
      if (!channel) {
        throw new Error('Channel order contains an unknown channel.');
      }

      const categoryId = item.categoryId ?? null;
      if (channel.type === 'category' && categoryId) {
        throw new Error('Categories cannot be nested inside categories.');
      }
      if (categoryId) {
        const category = channelsById.get(categoryId);
        if (!category || category.type !== 'category') {
          throw new Error('Channel order references an unknown category.');
        }
        if (category.id === channel.id) {
          throw new Error('A channel cannot be its own category.');
        }
      }
    }

    const channels = this.repos.channels.updateLayout(input.serverId, input.items);
    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'channel.reorder',
      targetType: 'channel',
      payload: {
        items: input.items,
      },
    });

    return channels;
  }

  listMessagesPage(input: {
    channelId: string;
    limit: number;
    before?: { createdAt: string; id: string };
    identityMode?: 'all' | 'lan' | 'atproto';
  }): PageResponse<Message> {
    return this.repos.messages.listByChannelPage(input);
  }

  searchMessages(input: {
    channelId: string;
    query?: string;
    limit: number;
    authorId?: string;
    identityMode?: 'all' | 'lan' | 'atproto';
  }): Message[] {
    return this.repos.messages.searchByChannel({
      channelId: input.channelId,
      query: input.query,
      limit: input.limit,
      authorId: input.authorId,
      identityMode: input.identityMode,
    });
  }

  searchMessagesInServer(input: {
    serverId: string;
    query?: string;
    limit: number;
    authorId?: string;
    channelId?: string;
    channelIds?: string[];
    identityMode?: 'all' | 'lan' | 'atproto';
  }): Message[] {
    return this.repos.messages.searchInServer(input);
  }

  sendMessage(input: {
    serverId: string;
    channelId: string;
    authorId: string;
    content: string;
    encryptedContent?: EncryptedMessageContent;
    parentMessageId?: string;
    gifUrl?: string;
    attachmentIds?: string[];
  }): { message?: Message; blocked?: string[] } {
    const channel = this.repos.channels.findById(input.channelId);
    if (!channel) {
      throw new Error('Channel not found.');
    }

    if (channel.serverId !== input.serverId) {
      return { blocked: ['channel_not_found'] };
    }

    if (channel.type !== 'text' && channel.type !== 'dm') {
      return { blocked: ['unsupported_channel_type'] };
    }

    const blocked = this.moderation.isBlockedFromMessaging(input.serverId, input.authorId);
    if (blocked.blocked) {
      return { blocked: [blocked.reason ?? 'blocked'] };
    }

    if (channel.locked) {
      return { blocked: ['channel_locked'] };
    }

    if (input.parentMessageId) {
      const parentMessage = this.repos.messages.findById(input.parentMessageId);
      if (!parentMessage || parentMessage.deletedAt || parentMessage.channelId !== input.channelId) {
        return { blocked: ['invalid_reply_parent'] };
      }
    }

    const cooldownKey = `${input.authorId}:${input.channelId}`;
    const lastPost = this.lastMessageByUserChannel.get(cooldownKey) ?? 0;
    const requiredDelayMs = channel.slowmodeSeconds * 1000;

    if (requiredDelayMs > 0 && Date.now() - lastPost < requiredDelayMs) {
      return { blocked: ['slowmode'] };
    }

    if (!input.encryptedContent && input.content.trim().length > 0) {
      const serverRules = this.repos.automod.list(input.serverId);
      const evaluation = evaluateAutomod(
        serverRules,
        {
          message: input.content,
          mentionCount: extractMentionCount(input.content),
          containsLink: containsLink(input.content),
          isMemberTrusted: false,
        },
        {
          maxMentionsPerMessage: this.getConfig().moderation.maxMentionsPerMessage,
          linkPolicy: this.getConfig().moderation.linkPolicy,
        },
      );

      if (evaluation.blocked) {
        return { blocked: evaluation.reasons };
      }
    }

    const attachments: Attachment[] = [];
    const attachmentIds = [...new Set(input.attachmentIds ?? [])].slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
    for (const attachmentId of attachmentIds) {
      const attachment = this.getPendingAttachment(attachmentId, input.authorId);
      if (!attachment) {
        return { blocked: ['invalid_attachment'] };
      }
      attachments.push(attachment);
    }

    const message = this.repos.messages.create({
      channelId: input.channelId,
      authorId: input.authorId,
      content: input.content,
      encryptedContent: input.encryptedContent,
      parentMessageId: input.parentMessageId,
      gifUrl: input.gifUrl,
      attachments,
    });

    this.lastMessageByUserChannel.set(cooldownKey, Date.now());
    this.metrics.incrementMessagesCreated();

    return { message };
  }

  editMessage(input: {
    messageId: string;
    content: string;
    encryptedContent?: EncryptedMessageContent;
  }): Message | null {
    return this.repos.messages.edit(input.messageId, {
      content: input.content,
      encryptedContent: input.encryptedContent,
    });
  }

  deleteMessage(input: { messageId: string; serverId: string; actorId: string }): Message | null {
    const message = this.repos.messages.softDelete(input.messageId);
    if (!message) {
      return null;
    }

    this.repos.audit.create({
      serverId: input.serverId,
      actorId: input.actorId,
      action: 'message.delete',
      targetType: 'message',
      targetId: message.id,
      payload: {
        channelId: message.channelId,
        authorId: message.authorId,
      },
    });

    return message;
  }

  toggleReaction(input: { messageId: string; userId: string; emoji: string }): { message: Message | null; added: boolean } {
    return this.repos.messages.toggleReaction(input);
  }

  saveAttachment(input: { fileName: string; mimeType?: string; bytes: Buffer; ownerUserId?: string }): Attachment {
    const config = this.getConfig();
    if (input.bytes.length > config.media.maxAttachmentBytes) {
      throw new Error('Attachment exceeds configured max size.');
    }

    if (input.ownerUserId) {
      const pending = this.repos.messages.getPendingAttachmentUsage(input.ownerUserId);
      const maxPendingBytes = Math.max(
        config.media.maxAttachmentBytes * MAX_ATTACHMENTS_PER_MESSAGE,
        MIN_PENDING_ATTACHMENT_BYTES_PER_USER,
      );
      if (
        pending.count >= MAX_PENDING_ATTACHMENTS_PER_USER ||
        pending.bytes + input.bytes.length > maxPendingBytes
      ) {
        throw new Error('Too many pending attachments. Send or discard existing uploads before adding more.');
      }
    }

    const detectedMime = input.mimeType ?? lookupMime(input.fileName);
    const mimeType = (typeof detectedMime === 'string' ? detectedMime : 'application/octet-stream')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const allowed = config.media.allowedMimePrefixes.some((prefix) => mimeType.startsWith(prefix));

    if (!allowed) {
      throw new Error('Attachment MIME type is not allowed.');
    }
    if (BLOCKED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
      throw new Error('Attachment MIME type is not safe to serve.');
    }

    const safeName = `${Date.now()}-${input.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = resolve(config.storage.uploadDir, safeName);
    writeFileSync(filePath, input.bytes);

    return this.repos.messages.recordUploadedAttachment({
      fileName: input.fileName,
      mimeType,
      byteSize: input.bytes.length,
      path: filePath,
      ownerUserId: input.ownerUserId,
    });
  }

  getAttachment(attachmentId: string): Attachment | null {
    const attachment = this.repos.messages.findAttachmentById(attachmentId);
    if (!attachment || !this.isStoredUploadPath(attachment.path)) {
      return null;
    }
    return attachment;
  }

  private getPendingAttachment(attachmentId: string, ownerUserId: string): Attachment | null {
    const attachment = this.repos.messages.findUnattachedAttachmentById(attachmentId, ownerUserId);
    if (!attachment || !this.isStoredUploadPath(attachment.path)) {
      return null;
    }
    return attachment;
  }

  private isStoredUploadPath(filePath: string): boolean {
    return isPathInsideDirectory(this.getConfig().storage.uploadDir, filePath);
  }

  async searchGifs(query: string, limit = 20): Promise<GifSearchResponse> {
    const config = this.getConfig();
    const primaryProvider = config.media.gifProvider;
    const fallbackProvider =
      config.media.gifFallbackProvider === 'none' || config.media.gifFallbackProvider === primaryProvider
        ? undefined
        : config.media.gifFallbackProvider;
    const providers = fallbackProvider ? [primaryProvider, fallbackProvider] : [primaryProvider];
    const providerErrors: GifProviderError[] = [];

    for (const provider of providers) {
      try {
        const results = await this.searchGifsWithProvider(provider, query, limit, config);
        return {
          results,
          provider,
          fallbackProvider,
          ...(providerErrors[0] ? { providerError: providerErrors[0], providerErrors } : {}),
        };
      } catch (error) {
        providerErrors.push(toProviderError(provider, error));
      }
    }

    return {
      results: [],
      provider: primaryProvider,
      fallbackProvider,
      providerError: providerErrors[0],
      providerErrors,
    };
  }

  private async searchGifsWithProvider(
    provider: GifProvider,
    query: string,
    limit: number,
    config: CurrentConfig,
  ): Promise<GifSearchResponse['results']> {
    if (provider === 'giphy') {
      return this.searchGiphy(query, limit, config);
    }

    return this.searchKlipy(query, limit, config);
  }

  private async searchKlipy(
    query: string,
    limit: number,
    config: CurrentConfig,
  ): Promise<GifSearchResponse['results']> {
    const key = config.media.klipyApiKey.trim();
    if (!key) {
      throw new Error('Klipy API key is not configured.');
    }

    const url = new URL('https://api.klipy.com/v2/search');
    url.searchParams.set('q', query);
    url.searchParams.set('key', key);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('media_filter', 'gif,tinygif,mp4');

    const payload = await fetchJson(url, 'klipy');
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      return [];
    }

    return payload.results
      .map((item, index) => this.normalizeKlipyResult(item, query, index))
      .filter((item): item is GifSearchResponse['results'][number] => Boolean(item));
  }

  private async searchGiphy(
    query: string,
    limit: number,
    config: CurrentConfig,
  ): Promise<GifSearchResponse['results']> {
    const key = config.media.giphyApiKey.trim();
    if (!key) {
      throw new Error('Giphy API key is not configured.');
    }

    const url = new URL('https://api.giphy.com/v1/gifs/search');
    url.searchParams.set('api_key', key);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('rating', 'g');

    const payload = await fetchJson(url, 'giphy');
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      return [];
    }

    return payload.data
      .map((item, index) => this.normalizeGiphyResult(item, query, index))
      .filter((item): item is GifSearchResponse['results'][number] => Boolean(item));
  }

  private normalizeKlipyResult(
    value: unknown,
    query: string,
    index: number,
  ): GifSearchResponse['results'][number] | null {
    if (!isRecord(value)) {
      return null;
    }

    const mediaFormats = isRecord(value.media_formats) ? value.media_formats : {};
    const gif = isRecord(mediaFormats.gif) ? getString(mediaFormats.gif.url) : undefined;
    const tinygif = isRecord(mediaFormats.tinygif) ? getString(mediaFormats.tinygif.url) : undefined;
    const mp4 = isRecord(mediaFormats.mp4) ? getString(mediaFormats.mp4.url) : undefined;
    if (!gif && !mp4) {
      return null;
    }

    return {
      id: getString(value.id) ?? `klipy-${query}-${index}`,
      content_description: getString(value.content_description) ?? query,
      media_formats: {
        ...(gif ? { gif: { url: gif } } : {}),
        ...(tinygif ? { tinygif: { url: tinygif } } : {}),
        ...(mp4 ? { mp4: { url: mp4 } } : {}),
      },
    };
  }

  private assertCategoryExists(serverId: string, categoryId: string): void {
    const category = this.repos.channels.findById(categoryId);
    if (!category || category.serverId !== serverId || category.type !== 'category') {
      throw new Error('Category not found.');
    }
  }

  private normalizeGiphyResult(
    value: unknown,
    query: string,
    index: number,
  ): GifSearchResponse['results'][number] | null {
    if (!isRecord(value)) {
      return null;
    }

    const images = isRecord(value.images) ? value.images : {};
    const original = isRecord(images.original) ? images.original : {};
    const downsized = isRecord(images.downsized) ? images.downsized : {};
    const fixedWidthSmall = isRecord(images.fixed_width_small) ? images.fixed_width_small : {};
    const previewGif = isRecord(images.preview_gif) ? images.preview_gif : {};
    const preview = isRecord(images.preview) ? images.preview : {};

    const gif =
      getString(original.url) ??
      getString(downsized.url) ??
      getString(fixedWidthSmall.url) ??
      getString(previewGif.url);
    const tinygif =
      getString(fixedWidthSmall.url) ??
      getString(previewGif.url) ??
      gif;
    const mp4 =
      getString(original.mp4) ??
      getString(downsized.mp4) ??
      getString(fixedWidthSmall.mp4) ??
      getString(preview.mp4);
    const selectUrl = mp4 ?? gif;
    if (!selectUrl) {
      return null;
    }

    return {
      id: getString(value.id) ?? `giphy-${query}-${index}`,
      content_description: getString(value.title) ?? query,
      media_formats: {
        ...(gif ? { gif: { url: gif } } : {}),
        ...(tinygif ? { tinygif: { url: tinygif } } : {}),
        ...(mp4 ? { mp4: { url: mp4 } } : {}),
      },
    };
  }
}
