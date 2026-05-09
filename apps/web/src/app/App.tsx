import {
  Fragment,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  Channel,
  Message,
  PageResponse,
  ServerAppearance,
  UserPresence,
  UserPresenceDisplayStatus,
  UserPresenceStatus,
  VoiceState,
} from '@current/types';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, uploadAttachment } from '../lib/api';
import {
  decryptMessageContent,
  encryptMessageContent,
  importE2eeKey,
  loadOrCreateE2eeKey,
  type E2eeKeyState,
} from '../lib/e2ee';
import { useGateway } from '../hooks/useGateway';
import { useVoiceClient, type VoiceNetworkDiagnostics, type VoiceRemoteStream } from '../hooks/useVoiceClient';
import { ServerSettingsModal } from './server-settings-modal';
import { ActionModalHost, useActionModal } from './action-modal';
import {
  ContextMenuHost,
  type ContextMenuSection,
  useContextMenu,
} from './context-menu';
import { LiquidGlassBackdrop } from './liquid-glass-backdrop';
import type { EmojiEntry } from './emoji-catalog';
import {
  buildEmojiToneIndex,
  getEmojiToneGroupForEntry,
  getPreferredEmojiForEntry,
  shouldShowEmojiEntry,
  type EmojiToneGroup,
  type EmojiToneVariant,
} from './emoji-skin-tones';

const CURRENT_LOGO_URL = new URL('../../../../assets/logo_grayscale.svg', import.meta.url).href;

type AuthMode = 'atproto' | 'lan';
type RegistrationMode = 'invite_only' | 'open_signup' | 'manual_approval';
type GifProvider = 'klipy' | 'giphy';
type GifFallbackProvider = 'none' | GifProvider;
type LinkPolicy = 'allow' | 'members_only' | 'deny';
type AppearanceMode = 'auto' | 'light' | 'dark';
type ResolvedAppearanceMode = 'light' | 'dark';

type CurrentDesktopAppearancePayload = {
  mode: AppearanceMode;
  resolvedMode: ResolvedAppearanceMode;
};

type CurrentDesktopAppearanceRuntime = {
  getAppearanceMode?: () => Promise<CurrentDesktopAppearancePayload>;
  onAppearanceModeChange?: (callback: (payload: CurrentDesktopAppearancePayload) => void) => () => void;
};

const APPEARANCE_TRANSITION_MS = 680;

type SetupStatus = {
  configured: boolean;
  serverId?: string;
  authMode?: AuthMode;
};

type SetupBootstrapResponse = {
  serverId: string;
  defaultChannelId?: string;
};

type SessionPayload = {
  user: {
    id: string;
    did: string;
    handle: string;
    displayName: string;
    avatarUrl?: string;
    roleIds: string[];
  };
  server: {
    name: string;
    registrationMode: RegistrationMode;
    appearance?: ServerAppearance;
  };
  ownership?: {
    ownerUserId?: string;
  };
};

type OAuthLanHandoffPayload = {
  handoffId: string;
  hostAuthUrl: string;
  expiresAt: string;
  message?: string;
};

type OAuthStartPayload = {
  authorizationUrl?: string;
  lanHandoff?: OAuthLanHandoffPayload;
};

type OAuthLanHandoffStatusPayload = {
  status: 'pending' | 'ready' | 'claimed' | 'expired';
  expiresAt?: string;
};

type MemberPayload = {
  id: string;
  did: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  roleIds: string[];
  createdAt: string;
};

type RolePayload = {
  id: string;
  serverId?: string;
  name: string;
  color: string;
  position: number;
  permissions: string[];
};

type ChannelListItem = {
  id: string;
  channel: Channel;
  kind: 'category' | 'channel';
  nested: boolean;
};

type ChannelDropTarget = {
  channelId: string;
  edge: 'before' | 'after';
};

type AppContextMenu =
  | {
      kind: 'server';
    }
  | {
      kind: 'channel';
      channel: Channel;
    }
  | {
      kind: 'member';
      member: SessionPayload['user'] | MemberPayload;
    }
  | {
      kind: 'message';
      message: Message;
    };

type GifSearchResult = {
  id?: string;
  content_description?: string;
  media_formats?: {
    gif?: { url?: string };
    tinygif?: { url?: string };
    mp4?: { url?: string };
  };
};

type GifSearchResponse = {
  results?: GifSearchResult[];
  provider?: 'klipy' | 'giphy';
  fallbackProvider?: 'klipy' | 'giphy';
  providerError?: {
    provider?: 'klipy' | 'giphy';
    code?: string;
    message?: string;
  };
};

type GifTile = {
  id: string;
  selectUrl: string;
  previewUrl: string;
  label: string;
};

type MessageSearchResponse = {
  items: Message[];
};

type PresenceResponse = {
  items: UserPresence[];
  selfStatus: UserPresenceStatus;
};

type PresencePatchResponse = {
  presence: UserPresence;
  selfStatus: UserPresenceStatus;
};

type LocalE2eeState = E2eeKeyState | { status: 'loading' };

type DecryptedMessageState =
  | {
      status: 'ready';
      content: string;
    }
  | {
      status: 'error';
      reason: string;
    };

type ComposerReferenceMatch = {
  trigger: '@' | '#';
  query: string;
  start: number;
  end: number;
};

type MentionSuggestion =
  | {
      kind: 'member';
      member: SessionPayload['user'] | MemberPayload;
    }
  | {
      kind: 'channel';
      channel: Channel;
    };

type ReplyDraftState = {
  channelId: string;
  messageId: string;
} | null;

type MemberRosterEntry = {
  member: SessionPayload['user'] | MemberPayload;
  topRole?: RolePayload;
  presence: UserPresence;
};

type EmojiTonePickerState = {
  group: EmojiToneGroup;
  x: number;
  y: number;
} | null;

type MessageToolbarPlacement = 'top' | 'bottom';

function isVideoMediaUrl(url: string): boolean {
  if (/\.(mp4|webm|mov)(?:[?#]|$)/i.test(url)) {
    return true;
  }

  try {
    const parsed = new URL(url);
    const format = parsed.searchParams.get('format')?.toLowerCase();
    return format === 'mp4' || format === 'webm' || format === 'mov';
  } catch {
    return false;
  }
}

function isGifImageUrl(url: string): boolean {
  if (/\.gif(?:[?#]|$)/i.test(url)) {
    return true;
  }

  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.searchParams.get('format')?.toLowerCase() === 'gif';
  } catch {
    return false;
  }
}

function useWindowAnimationFocus() {
  const getIsActive = useCallback(() => (
    document.visibilityState === 'visible' &&
    (typeof document.hasFocus === 'function' ? document.hasFocus() : true)
  ), []);
  const [isActive, setIsActive] = useState(getIsActive);

  useEffect(() => {
    const update = () => setIsActive(getIsActive());

    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    window.addEventListener('pageshow', update);
    window.addEventListener('pagehide', update);
    document.addEventListener('visibilitychange', update);

    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      window.removeEventListener('pageshow', update);
      window.removeEventListener('pagehide', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [getIsActive]);

  return isActive;
}

function useElementVisibility(rootMargin = '96px') {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [isVisible, setIsVisible] = useState(true);
  const ref = useCallback((nextNode: HTMLElement | null) => {
    setNode(nextNode);
  }, []);

  useEffect(() => {
    if (!node || !('IntersectionObserver' in window)) {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { root: null, rootMargin, threshold: 0.01 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [node, rootMargin]);

  return { isVisible, ref };
}

function PausableGifVideo({
  className,
  onLoadedMetadata,
  playWhenAllowed,
  src,
}: {
  className: string;
  onLoadedMetadata?: () => void;
  playWhenAllowed: boolean;
  src: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { isVisible, ref: visibilityRef } = useElementVisibility();
  const shouldPlay = playWhenAllowed && isVisible;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (!shouldPlay) {
      video.pause();
      return;
    }

    void video.play().catch(() => {
      // Browsers can reject autoplay during focus transitions; the next state tick retries.
    });
  }, [shouldPlay, src]);

  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    visibilityRef(node);
  }, [visibilityRef]);

  return (
    <video
      ref={setVideoRef}
      className={className}
      autoPlay={shouldPlay}
      loop
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={onLoadedMetadata}
    >
      <source src={src} />
    </video>
  );
}

function PausableGifImage({
  alt,
  className,
  loading = 'lazy',
  onLoad,
  playWhenAllowed,
  src,
}: {
  alt: string;
  className: string;
  loading?: 'eager' | 'lazy';
  onLoad?: () => void;
  playWhenAllowed: boolean;
  src: string;
}) {
  const { isVisible, ref } = useElementVisibility();
  const shouldLoad = playWhenAllowed && isVisible;

  if (!shouldLoad) {
    return (
      <span
        ref={ref}
        className={`${className} paused-gif-placeholder`}
        role="img"
        aria-label={`${alt} paused`}
      >
        GIF paused
      </span>
    );
  }

  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      onLoad={onLoad}
    />
  );
}

function StaticMessageGlassBackdrop({ overLight }: { overLight: boolean }) {
  return (
    <span
      className={`liquid-glass-backdrop message-liquid-glass message-liquid-glass-static ${overLight ? 'over-light' : ''}`}
      aria-hidden="true"
    />
  );
}

function isRendererPerfProbeEnabled(storageKey: string): boolean {
  const params = new URLSearchParams(window.location.search);
  const values = [
    params.get('perfProbe'),
    params.get('fpsProbe'),
    params.get('glassPerf'),
    window.localStorage.getItem(storageKey),
    window.localStorage.getItem('glassPerfProbe'),
  ];

  return values.some((value) => {
    if (!value) {
      return false;
    }
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  });
}

function countVisibleMessageBodies(): number {
  let visible = 0;
  document.querySelectorAll<HTMLElement>('.message-body').forEach((element) => {
    const rect = element.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.top <= window.innerHeight &&
      rect.right >= 0 &&
      rect.left <= window.innerWidth
    ) {
      visible += 1;
    }
  });
  return visible;
}

function getPercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.max(0, Math.ceil(sortedValues.length * percentile) - 1);
  return sortedValues[index] ?? 0;
}

function hasActiveStyleValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'none' && normalized !== 'initial';
}

function countComputedStyleMatches(isMatch: (style: CSSStyleDeclaration) => boolean): number {
  let count = 0;
  document.querySelectorAll<HTMLElement>('*').forEach((element) => {
    if (isMatch(window.getComputedStyle(element))) {
      count += 1;
    }
  });
  return count;
}

function getComputedStyleValue(style: CSSStyleDeclaration, propertyNames: string[]): string {
  for (const propertyName of propertyNames) {
    const value = style.getPropertyValue(propertyName);
    if (hasActiveStyleValue(value)) {
      return value;
    }
  }
  return '';
}

function useRendererPerfProbe(label: string, storageKey: string) {
  useEffect(() => {
    if (!isRendererPerfProbeEnabled(storageKey)) {
      return undefined;
    }

    let frameCount = 0;
    let lastFrameAt = performance.now();
    let windowStartedAt = lastFrameAt;
    let animationFrameId = 0;
    const frameTimes: number[] = [];

    const tick = (now: number) => {
      const frameTime = now - lastFrameAt;
      lastFrameAt = now;
      if (frameTime > 0 && frameTime < 1000) {
        frameTimes.push(frameTime);
      }
      frameCount += 1;

      const elapsed = now - windowStartedAt;
      if (elapsed >= 2000) {
        const sortedFrameTimes = [...frameTimes].sort((a, b) => a - b);
        const totalFrameTime = frameTimes.reduce((sum, value) => sum + value, 0);
        const averageFrameMs = frameTimes.length ? totalFrameTime / frameTimes.length : 0;
        const p95FrameMs = getPercentile(sortedFrameTimes, 0.95);
        const p99FrameMs = getPercentile(sortedFrameTimes, 0.99);
        console.info(`[${label} perf]`, {
          fps: Math.round((frameCount * 1000) / elapsed),
          averageFrameMs: Number(averageFrameMs.toFixed(2)),
          p95FrameMs: Number(p95FrameMs.toFixed(2)),
          p99FrameMs: Number(p99FrameMs.toFixed(2)),
          framesOver8_33Ms: frameTimes.filter((value) => value > 8.33).length,
          framesOver10Ms: frameTimes.filter((value) => value > 10).length,
          framesOver12Ms: frameTimes.filter((value) => value > 12).length,
          framesOver16_67Ms: frameTimes.filter((value) => value > 16.67).length,
          framesOver20Ms: frameTimes.filter((value) => value > 20).length,
          visibleMessages: countVisibleMessageBodies(),
          liquidGlassLayers: document.querySelectorAll('.liquid-glass-layer').length,
          messageLiquidGlassLayers: document.querySelectorAll('.message-body .message-liquid-glass .liquid-glass-layer').length,
          staticMessageGlass: document.querySelectorAll('.message-liquid-glass-static').length,
          backdropFilterNodes: countComputedStyleMatches((style) =>
            hasActiveStyleValue(getComputedStyleValue(style, ['backdrop-filter', '-webkit-backdrop-filter'])),
          ),
          cssFilterNodes: countComputedStyleMatches((style) =>
            hasActiveStyleValue(getComputedStyleValue(style, ['filter'])),
          ),
          maskedNodes: countComputedStyleMatches((style) =>
            hasActiveStyleValue(getComputedStyleValue(style, ['mask-image', '-webkit-mask-image'])),
          ),
        });
        frameCount = 0;
        frameTimes.length = 0;
        windowStartedAt = now;
      }

      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrameId);
  }, [label, storageKey]);
}

const GIF_QUICK_TOPICS = [
  'Favorites',
  'Trending GIFs',
  'tired bunny',
  'monday face',
  'masters',
  'morning coffee',
];

const MAX_GIF_RESULTS = 9;
const MAX_SEARCH_RESULTS = 10;
const MAX_MENTION_RESULTS = 8;
const MESSAGES_PAGE_LIMIT = 40;
const CHANNELS_PAGE_LIMIT = 75;
const MEMBERS_PAGE_LIMIT = 100;
const PAGE_SCROLL_THRESHOLD_PX = 120;
const MESSAGE_BOTTOM_THRESHOLD_PX = 96;
const MESSAGE_HOVER_TOOLBAR_MIN_TOP_SPACE = 44;
const TYPING_IDLE_MS = 4_500;
const TYPING_HEARTBEAT_MS = 2_200;
const TYPING_TTL_MS = 5_200;
const RECENT_REACTION_STORAGE_KEY = 'current.recentReactionEmojis';
const EMOJI_TONE_DEFAULTS_STORAGE_KEY = 'current.emojiToneDefaults';
const CHANNELS_PANE_WIDTH_STORAGE_KEY = 'current.channelsPaneWidth';
const MEMBERS_PANE_WIDTH_STORAGE_KEY = 'current.membersPaneWidth';
const EMOJI_LONG_PRESS_MS = 450;
const DEFAULT_RECENT_REACTION_EMOJIS = ['👍', '❤️', '😂'];
const DEFAULT_CHANNELS_PANE_WIDTH = 260;
const MIN_CHANNELS_PANE_WIDTH = 220;
const MAX_CHANNELS_PANE_WIDTH = 420;
const DEFAULT_MEMBERS_PANE_WIDTH = 300;
const MIN_MEMBERS_PANE_WIDTH = 240;
const MAX_MEMBERS_PANE_WIDTH = 420;

const PRESENCE_STATUS_OPTIONS: Array<{ value: UserPresenceStatus; label: string }> = [
  { value: 'online', label: 'Online' },
  { value: 'away', label: 'Away' },
  { value: 'dnd', label: 'Do Not Disturb' },
  { value: 'invisible', label: 'Invisible' },
];

type TypingUpdateEventPayload = {
  channelId?: string;
  userId?: string;
  isTyping?: boolean;
};

function formatTypingSummary(names: string[]): string {
  if (names.length === 0) {
    return '';
  }

  if (names.length === 1) {
    return `${names[0]} is typing...`;
  }

  if (names.length === 2) {
    return `${names[0]} and ${names[1]} are typing...`;
  }

  if (names.length === 3) {
    return `${names[0]}, ${names[1]}, and ${names[2]} are typing...`;
  }

  return `${names[0]}, ${names[1]}, and ${names.length - 2} others are typing...`;
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function isMessageChannel(channel: Channel | null | undefined): channel is Channel & { type: 'text' | 'dm' } {
  return channel?.type === 'text' || channel?.type === 'dm';
}

function cssImageUrl(url?: string): string | undefined {
  return url ? `url("${url.replace(/"/g, '\\"')}")` : undefined;
}

function currentDesktopAppearanceRuntime(): CurrentDesktopAppearanceRuntime | undefined {
  return (window as Window & { currentDesktop?: CurrentDesktopAppearanceRuntime }).currentDesktop;
}

function resolveSystemAppearanceMode(): ResolvedAppearanceMode {
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}

function normalizeAppearanceModePayload(
  payload?: Partial<CurrentDesktopAppearancePayload> | null,
): CurrentDesktopAppearancePayload {
  const mode = payload?.mode === 'light' || payload?.mode === 'dark' || payload?.mode === 'auto' ? payload.mode : 'auto';
  const resolvedMode =
    payload?.resolvedMode === 'light' || payload?.resolvedMode === 'dark'
      ? payload.resolvedMode
      : mode === 'auto'
        ? resolveSystemAppearanceMode()
        : mode;
  return { mode, resolvedMode };
}

function isBrightImageData(imageData: ImageData): boolean {
  const data = imageData.data;
  let luminanceTotal = 0;
  let brightPixels = 0;
  let sampledPixels = 0;

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] / 255;
    if (alpha < 0.2) {
      continue;
    }

    const red = data[index] / 255;
    const green = data[index + 1] / 255;
    const blue = data[index + 2] / 255;
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) * alpha;
    luminanceTotal += luminance;
    brightPixels += luminance > 0.58 ? 1 : 0;
    sampledPixels += 1;
  }

  if (sampledPixels === 0) {
    return false;
  }

  const averageLuminance = luminanceTotal / sampledPixels;
  const brightPixelRatio = brightPixels / sampledPixels;
  return averageLuminance > 0.46 || brightPixelRatio > 0.28;
}

function detectBrightBackgroundImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';

    image.onload = () => {
      const canvas = document.createElement('canvas');
      const sampleSize = 32;
      canvas.width = sampleSize;
      canvas.height = sampleSize;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        resolve(false);
        return;
      }

      context.drawImage(image, 0, 0, sampleSize, sampleSize);
      try {
        resolve(isBrightImageData(context.getImageData(0, 0, sampleSize, sampleSize)));
      } catch {
        resolve(false);
      }
    };

    image.onerror = () => resolve(false);
    image.src = url;
  });
}

function buildAppearanceStyle(
  appearance: ServerAppearance | undefined,
  resolvedAppearanceMode: ResolvedAppearanceMode,
): Record<string, string> {
  const style: Record<string, string> = {};
  const background = cssImageUrl(appearance?.background.url);
  const panelColor = hexToRgbTriplet(appearance?.panelColor);
  const ownMessageColor = hexToRgbTriplet(appearance?.ownMessageColor);
  const otherMessageColor = hexToRgbTriplet(appearance?.otherMessageColor);
  const panelColorDark = darkenHexToRgbTriplet(appearance?.panelColor);
  const ownMessageColorDark = darkenHexToRgbTriplet(appearance?.ownMessageColor);
  const otherMessageColorDark = darkenHexToRgbTriplet(appearance?.otherMessageColor);

  if (background) {
    style['--current-app-bg'] = background;
  }

  if (panelColor) {
    style['--side-panel-color-rgb'] = panelColor;
    style['--side-panel-surface-rgb'] =
      resolvedAppearanceMode === 'dark' ? panelColorDark ?? panelColor : panelColor;
  }

  if (panelColorDark) {
    style['--side-panel-color-dark-rgb'] = panelColorDark;
  }

  if (ownMessageColor) {
    style['--own-message-color-rgb'] = ownMessageColor;
    style['--own-message-surface-rgb'] =
      resolvedAppearanceMode === 'dark' ? ownMessageColorDark ?? ownMessageColor : ownMessageColor;
  }

  if (ownMessageColorDark) {
    style['--own-message-color-dark-rgb'] = ownMessageColorDark;
  }

  if (otherMessageColor) {
    style['--other-message-color-rgb'] = otherMessageColor;
    style['--other-message-surface-rgb'] =
      resolvedAppearanceMode === 'dark' ? otherMessageColorDark ?? otherMessageColor : otherMessageColor;
  }

  if (otherMessageColorDark) {
    style['--other-message-color-dark-rgb'] = otherMessageColorDark;
  }

  return style;
}

function parseHexRgb(value?: string): [number, number, number] | null {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) {
    return null;
  }
  const red = Number.parseInt(value.slice(1, 3), 16);
  const green = Number.parseInt(value.slice(3, 5), 16);
  const blue = Number.parseInt(value.slice(5, 7), 16);
  return [red, green, blue];
}

function hexToRgbTriplet(value?: string): string | null {
  const rgb = parseHexRgb(value);
  if (!rgb) {
    return null;
  }
  const [red, green, blue] = rgb;
  return `${red} ${green} ${blue}`;
}

function darkenHexToRgbTriplet(value?: string): string | null {
  const rgb = parseHexRgb(value);
  if (!rgb) {
    return null;
  }
  return rgb.map((channel) => Math.max(0, Math.round(channel * 0.58))).join(' ');
}

function getChannelPosition(channel: Channel): number {
  return Number.isFinite(channel.position) ? channel.position : 0;
}

function compareChannelsForSidebar(a: Channel, b: Channel): number {
  return getChannelPosition(a) - getChannelPosition(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function buildChannelListItems(channels: Channel[]): ChannelListItem[] {
  const sortedChannels = [...channels].sort(compareChannelsForSidebar);
  const categoriesById = new Map(
    sortedChannels
      .filter((channel) => channel.type === 'category')
      .map((channel) => [channel.id, channel]),
  );
  const childrenByCategory = new Map<string, Channel[]>();

  for (const channel of sortedChannels) {
    if (channel.type === 'category' || !channel.categoryId || !categoriesById.has(channel.categoryId)) {
      continue;
    }
    const children = childrenByCategory.get(channel.categoryId) ?? [];
    children.push(channel);
    childrenByCategory.set(channel.categoryId, children);
  }

  for (const children of childrenByCategory.values()) {
    children.sort(compareChannelsForSidebar);
  }

  const items: ChannelListItem[] = [];
  for (const channel of sortedChannels) {
    if (channel.type === 'category') {
      items.push({
        id: channel.id,
        channel,
        kind: 'category',
        nested: false,
      });
      for (const child of childrenByCategory.get(channel.id) ?? []) {
        items.push({
          id: child.id,
          channel: child,
          kind: 'channel',
          nested: true,
        });
      }
      continue;
    }

    if (channel.categoryId && categoriesById.has(channel.categoryId)) {
      continue;
    }

    items.push({
      id: channel.id,
      channel,
      kind: 'channel',
      nested: false,
    });
  }

  return items;
}

function getChannelLabelPrefix(channel: Channel): string {
  if (channel.type === 'voice') {
    return '◉';
  }
  if (channel.type === 'dm') {
    return '@';
  }
  return '#';
}

function getChannelsPaneMaxWidth(): number {
  if (typeof window === 'undefined') {
    return MAX_CHANNELS_PANE_WIDTH;
  }
  return Math.max(
    MIN_CHANNELS_PANE_WIDTH,
    Math.min(MAX_CHANNELS_PANE_WIDTH, window.innerWidth - MIN_MEMBERS_PANE_WIDTH - 520),
  );
}

function clampChannelsPaneWidth(width: number): number {
  const maxWidth = getChannelsPaneMaxWidth();
  return Math.round(Math.min(Math.max(width, MIN_CHANNELS_PANE_WIDTH), maxWidth));
}

function loadChannelsPaneWidth(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_CHANNELS_PANE_WIDTH;
  }
  try {
    const stored = window.localStorage.getItem(CHANNELS_PANE_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number(stored) : DEFAULT_CHANNELS_PANE_WIDTH;
    return clampChannelsPaneWidth(Number.isFinite(parsed) ? parsed : DEFAULT_CHANNELS_PANE_WIDTH);
  } catch {
    return DEFAULT_CHANNELS_PANE_WIDTH;
  }
}

function getMembersPaneMaxWidth(): number {
  if (typeof window === 'undefined') {
    return MAX_MEMBERS_PANE_WIDTH;
  }
  return Math.max(
    MIN_MEMBERS_PANE_WIDTH,
    Math.min(MAX_MEMBERS_PANE_WIDTH, window.innerWidth - MIN_CHANNELS_PANE_WIDTH - 520),
  );
}

function clampMembersPaneWidth(width: number): number {
  const maxWidth = getMembersPaneMaxWidth();
  return Math.round(Math.min(Math.max(width, MIN_MEMBERS_PANE_WIDTH), maxWidth));
}

function loadMembersPaneWidth(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_MEMBERS_PANE_WIDTH;
  }
  try {
    const stored = window.localStorage.getItem(MEMBERS_PANE_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number(stored) : DEFAULT_MEMBERS_PANE_WIDTH;
    return clampMembersPaneWidth(Number.isFinite(parsed) ? parsed : DEFAULT_MEMBERS_PANE_WIDTH);
  } catch {
    return DEFAULT_MEMBERS_PANE_WIDTH;
  }
}

function slugifyServerName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'current-server';
}

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseSetupList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry, index, list) => entry.length > 0 && list.indexOf(entry) === index);
}

function isLanIdentity(user: { did: string } | null | undefined): boolean {
  if (!user) {
    return false;
  }
  return user.did.startsWith('did:current:lan:');
}

function formatIdentityHandle(user: { did: string; handle: string } | null | undefined): string {
  if (!user) {
    return '@Unknown';
  }
  return isLanIdentity(user) ? '@LAN' : `@${user.handle}`;
}

function getMemberCreatedAtTimestamp(member: SessionPayload['user'] | MemberPayload): number {
  if ('createdAt' in member && typeof member.createdAt === 'string') {
    const value = Date.parse(member.createdAt);
    return Number.isNaN(value) ? 0 : value;
  }
  return 0;
}

function getPresenceLabel(status: UserPresenceDisplayStatus): string {
  if (status === 'dnd') {
    return 'Do Not Disturb';
  }
  if (status === 'away') {
    return 'Away';
  }
  if (status === 'invisible') {
    return 'Invisible';
  }
  if (status === 'online') {
    return 'Online';
  }
  return 'Offline';
}

function getMemberPresenceLabel(status: UserPresenceDisplayStatus): string {
  return status === 'invisible' ? 'Offline' : getPresenceLabel(status);
}

function isVisibleOnlinePresence(presence: UserPresence): boolean {
  return presence.connected && presence.status !== 'offline' && presence.status !== 'invisible';
}

function getPresenceClassName(status: UserPresenceDisplayStatus): string {
  return status === 'dnd' ? 'dnd' : status;
}

function getPresenceSortRank(status: UserPresenceDisplayStatus): number {
  if (status === 'online') {
    return 0;
  }
  if (status === 'dnd') {
    return 1;
  }
  if (status === 'away') {
    return 2;
  }
  return 3;
}

function normalizeReferenceToken(value: string): string {
  return value.trim().toLowerCase();
}

function getMemberMentionToken(member: SessionPayload['user'] | MemberPayload): string {
  return `@${member.handle}`;
}

function getChannelMentionToken(channel: Channel): string {
  return `#${channel.name}`;
}

function getActiveComposerReference(value: string, caretPosition: number): ComposerReferenceMatch | null {
  if (caretPosition < 0) {
    return null;
  }

  const beforeCursor = value.slice(0, caretPosition);
  const match = /(^|\s)([@#])([A-Za-z0-9._-]*)$/.exec(beforeCursor);
  if (!match) {
    return null;
  }

  const trigger = match[2] as '@' | '#';
  const query = match[3] ?? '';
  return {
    trigger,
    query,
    start: beforeCursor.length - trigger.length - query.length,
    end: caretPosition,
  };
}

function isNearScrollBottom(element: HTMLElement, threshold = MESSAGE_BOTTOM_THRESHOLD_PX): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

function getDisplayMessageContent(
  message: Message,
  decryptedContent: DecryptedMessageState | undefined,
  e2eeState: LocalE2eeState,
): string {
  if (!message.encryptedContent) {
    return message.content;
  }

  if (decryptedContent?.status === 'ready') {
    return decryptedContent.content;
  }

  if (decryptedContent?.status === 'error') {
    return 'Encrypted message - key unavailable';
  }

  if (e2eeState.status === 'unsupported') {
    return 'Encrypted message - Web Crypto unavailable';
  }

  return 'Decrypting message...';
}

function getMessagePreviewText(
  message: Message,
  decryptedContent: DecryptedMessageState | undefined,
  e2eeState: LocalE2eeState,
): string {
  const content = getDisplayMessageContent(message, decryptedContent, e2eeState).trim();
  if (content.length > 0) {
    const oneLine = content.replace(/\s+/g, ' ');
    return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
  }

  if (message.gifUrl) {
    return 'GIF';
  }

  const attachmentCount = message.attachments?.length ?? 0;
  if (attachmentCount > 0) {
    return attachmentCount === 1 ? 'Attachment' : `${attachmentCount} attachments`;
  }

  return 'Message';
}

function GifPickerIcon() {
  return (
    <svg className="picker-icon-svg gif-picker-svg" viewBox="0 0 24 24" aria-hidden focusable="false">
      <rect x="3.25" y="5.25" width="17.5" height="13.5" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M8.45 10.1H7.4c-1.22 0-2.05.78-2.05 1.9s.83 1.9 2.05 1.9h1.05v-1.5H7.3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
      <path
        d="M11.45 10.1v3.8M14.55 13.9v-3.8h3.15M14.55 12h2.55"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}

function EmojiPickerIcon() {
  return (
    <svg className="picker-icon-svg emoji-picker-svg" viewBox="0 0 24 24" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="7.4" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="9.25" cy="10.45" r="0.85" fill="currentColor" />
      <circle cx="14.75" cy="10.45" r="0.85" fill="currentColor" />
      <path
        d="M8.85 13.65c.72 1.15 1.78 1.72 3.15 1.72s2.43-.57 3.15-1.72"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function renderMessageContent(
  content: string,
  options: {
    membersByMention: Map<string, SessionPayload['user'] | MemberPayload>;
    channelsByMention: Map<string, Channel>;
    onMemberClick: (memberId: string) => void;
    onChannelClick: (channel: Channel) => void;
  },
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const referencePattern = /(@[A-Za-z0-9._-]+|#[A-Za-z0-9._-]+)/g;
  let cursor = 0;

  for (const match of content.matchAll(referencePattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      nodes.push(content.slice(cursor, index));
    }

    const reference = normalizeReferenceToken(token.slice(1));
    if (token.startsWith('@')) {
      const member = options.membersByMention.get(reference);
      if (member) {
        nodes.push(
          <button
            key={`${index}-${token}`}
            type="button"
            className="message-reference-token mention"
            onClick={() => options.onMemberClick(member.id)}
          >
            {token}
          </button>,
        );
      } else {
        nodes.push(token);
      }
    } else {
      const channel = options.channelsByMention.get(reference);
      if (channel) {
        nodes.push(
          <button
            key={`${index}-${token}`}
            type="button"
            className="message-reference-token channel"
            onClick={() => options.onChannelClick(channel)}
          >
            {token}
          </button>,
        );
      } else {
        nodes.push(token);
      }
    }

    cursor = index + token.length;
  }

  if (cursor < content.length) {
    nodes.push(content.slice(cursor));
  }

  return nodes;
}

function RemoteVoiceAudio({
  remote,
  muted,
}: {
  remote: VoiceRemoteStream;
  muted: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.srcObject = remote.stream;
    }
  }, [remote.stream]);

  return <audio ref={audioRef} autoPlay playsInline muted={muted} />;
}

function VoiceMicMeter({
  level,
  disabled = false,
  compact = false,
}: {
  level: number;
  disabled?: boolean;
  compact?: boolean;
}) {
  const displayedLevel = Math.max(0, Math.min(1, level));
  const barScales = [0.28, 0.52, 0.78, 1, 0.62].map((threshold) =>
    Math.max(0.12, Math.min(1, displayedLevel / threshold)),
  );
  const percentage = Math.round(displayedLevel * 100);

  return (
    <div
      className={`voice-mic-meter ${compact ? 'compact' : ''} ${disabled ? 'disabled' : ''} ${displayedLevel > 0.035 ? 'active' : ''}`}
      style={{
        '--voice-meter-level': String(displayedLevel),
        '--voice-meter-glow-opacity': String(0.12 + displayedLevel * 0.72),
        '--voice-meter-glow-scale': String(0.45 + displayedLevel * 0.55),
        '--voice-meter-bar-opacity': String(0.28 + displayedLevel * 0.62),
      } as CSSProperties}
      aria-label={disabled ? `Local microphone input ${percentage} percent, not sending` : `Microphone input ${percentage} percent`}
      title={disabled ? `Local microphone input ${percentage}% - not sending` : `Microphone input ${percentage}%`}
    >
      <span className="voice-mic-icon" aria-hidden="true">
        <span className="voice-mic-glow" />
        <span className="voice-mic-capsule" />
        <span className="voice-mic-stand" />
      </span>
      <span className="voice-mic-bars" aria-hidden="true">
        {barScales.map((scale, index) => (
          <span
            key={index}
            style={{ '--bar-scale': String(scale) } as CSSProperties}
          />
        ))}
      </span>
    </div>
  );
}

function formatVoiceNetworkDiagnostics(diagnostics: VoiceNetworkDiagnostics): string {
  const parts: string[] = [];
  if (diagnostics.recovering) {
    parts.push('recovering');
  }
  if (diagnostics.transportProtocol !== 'unknown') {
    parts.push(diagnostics.transportProtocol.toUpperCase());
  }
  if (diagnostics.candidateType !== 'unknown') {
    parts.push(diagnostics.candidateType === 'relay' ? 'TURN relay' : diagnostics.candidateType);
  }
  if (typeof diagnostics.roundTripMs === 'number') {
    parts.push(`${diagnostics.roundTripMs} ms`);
  }
  if (typeof diagnostics.jitterMs === 'number') {
    parts.push(`${diagnostics.jitterMs} ms jitter`);
  }
  if (typeof diagnostics.packetLossPct === 'number' && diagnostics.packetLossPct > 0) {
    parts.push(`${diagnostics.packetLossPct}% loss`);
  }
  if (diagnostics.restarts > 0) {
    parts.push(`${diagnostics.restarts} ICE restart${diagnostics.restarts === 1 ? '' : 's'}`);
  }
  return parts.join(' · ') || 'checking route';
}

export function App() {
  const queryClient = useQueryClient();
  const isAnimationPlaybackActive = useWindowAnimationFocus();
  useRendererPerfProbe('Current', 'current.perfProbe');
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [gifTab, setGifTab] = useState<'gifs' | 'emoji'>('gifs');
  const [isGifModalOpen, setIsGifModalOpen] = useState(false);
  const [gifSearchInput, setGifSearchInput] = useState('');
  const [gifSearchQuery, setGifSearchQuery] = useState('Trending GIFs');
  const [emojiSearchInput, setEmojiSearchInput] = useState('');
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [searchTab, setSearchTab] = useState<'messages' | 'users'>('messages');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFromUserId, setSearchFromUserId] = useState<'all' | string>('all');
  const [searchChannelId, setSearchChannelId] = useState<'all' | string>('all');
  const [isExchangingAuth, setIsExchangingAuth] = useState(false);
  const [isServerSettingsOpen, setIsServerSettingsOpen] = useState(false);
  const [appearancePreview, setAppearancePreview] = useState<ServerAppearance | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [highlightedMemberId, setHighlightedMemberId] = useState<string | null>(null);
  const [pendingJumpMessage, setPendingJumpMessage] = useState<{ channelId: string; messageId: string } | null>(null);
  const [typingByChannel, setTypingByChannel] = useState<Record<string, Record<string, number>>>({});
  const [e2eeState, setE2eeState] = useState<LocalE2eeState>({ status: 'loading' });
  const [decryptedMessages, setDecryptedMessages] = useState<Record<string, DecryptedMessageState>>({});
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [composerCaretPosition, setComposerCaretPosition] = useState(0);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [activeComposerSuggestionIndex, setActiveComposerSuggestionIndex] = useState(0);
  const [replyDraft, setReplyDraft] = useState<ReplyDraftState>(null);
  const [emojiReactionMessageId, setEmojiReactionMessageId] = useState<string | null>(null);
  const [emojiCatalog, setEmojiCatalog] = useState<EmojiEntry[]>([]);
  const [emojiToneDefaults, setEmojiToneDefaults] = useState<Record<string, string>>(() => {
    try {
      const stored = window.localStorage.getItem(EMOJI_TONE_DEFAULTS_STORAGE_KEY);
      const parsed = stored ? (JSON.parse(stored) as unknown) : null;
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.values(parsed).every((value) => typeof value === 'string')
      ) {
        return parsed as Record<string, string>;
      }
    } catch {
      // Skin tone defaults are local UI preferences.
    }
    return {};
  });
  const [emojiTonePicker, setEmojiTonePicker] = useState<EmojiTonePickerState>(null);
  const [recentReactionEmojis, setRecentReactionEmojis] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem(RECENT_REACTION_STORAGE_KEY);
      const parsed = stored ? (JSON.parse(stored) as unknown) : null;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return [...parsed, ...DEFAULT_RECENT_REACTION_EMOJIS].filter(
          (emoji, index, list) => emoji.trim().length > 0 && list.indexOf(emoji) === index,
        ).slice(0, 3);
      }
    } catch {
      // Recent reactions are a cosmetic convenience.
    }
    return DEFAULT_RECENT_REACTION_EMOJIS;
  });
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, UserPresence>>({});
  const [selfPresenceStatus, setSelfPresenceStatus] = useState<UserPresenceStatus>('online');
  const [isPresenceMenuOpen, setIsPresenceMenuOpen] = useState(false);
  const [voiceSpeakingUserIds, setVoiceSpeakingUserIds] = useState<Set<string>>(() => new Set());
  const [pushToTalkHeld, setPushToTalkHeld] = useState(false);
  const [channelsPaneWidth, setChannelsPaneWidth] = useState(loadChannelsPaneWidth);
  const [membersPaneWidth, setMembersPaneWidth] = useState(loadMembersPaneWidth);
  const [isResizingChannelsPane, setIsResizingChannelsPane] = useState(false);
  const [isResizingMembersPane, setIsResizingMembersPane] = useState(false);
  const [isOverLightBackground, setIsOverLightBackground] = useState(false);
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>('auto');
  const [resolvedAppearanceMode, setResolvedAppearanceMode] = useState<ResolvedAppearanceMode>(() =>
    resolveSystemAppearanceMode(),
  );
  const [appearanceTransition, setAppearanceTransition] = useState<{
    id: number;
    from: ResolvedAppearanceMode;
    to: ResolvedAppearanceMode;
  } | null>(null);
  const [draggingChannelId, setDraggingChannelId] = useState<string | null>(null);
  const [channelDropTarget, setChannelDropTarget] = useState<ChannelDropTarget | null>(null);
  const [messageHoverToolbar, setMessageHoverToolbar] = useState<{
    messageId: string;
    placement: MessageToolbarPlacement;
  } | null>(null);
  const typingChannelRef = useRef<string | null>(null);
  const typingStopTimerRef = useRef<number | null>(null);
  const typingHeartbeatAtRef = useRef(0);
  const emojiLongPressTimerRef = useRef<number | null>(null);
  const emojiLongPressTriggeredRef = useRef(false);
  const messagesListRef = useRef<HTMLElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const searchModalInputRef = useRef<HTMLInputElement | null>(null);
  const channelsPaneRef = useRef<HTMLElement | null>(null);
  const channelsListRef = useRef<HTMLDivElement | null>(null);
  const membersPaneRef = useRef<HTMLElement | null>(null);
  const channelTitleGlassRef = useRef<HTMLDivElement | null>(null);
  const profileGlassRef = useRef<HTMLElement | null>(null);
  const presenceMenuRef = useRef<HTMLDivElement | null>(null);
  const composerGlassRef = useRef<HTMLDivElement | null>(null);
  const searchGlassRef = useRef<HTMLDivElement | null>(null);
  const newMessageJumpRef = useRef<HTMLButtonElement | null>(null);
  const resolvedAppearanceModeRef = useRef(resolvedAppearanceMode);
  const appearanceTransitionTimerRef = useRef<number | null>(null);
  const prependScrollAnchorRef = useRef<{ channelId: string; scrollHeight: number; scrollTop: number } | null>(null);
  const initialBottomScrollChannelIdRef = useRef<string | null>(null);
  const messagesAtBottomRef = useRef(true);
  const pendingScrollToBottomRef = useRef(false);
  const contextMenu = useContextMenu<AppContextMenu>();
  const actionModal = useActionModal();
  const isFloatingPanelOpen = Boolean(
    isSearchModalOpen ||
    isGifModalOpen ||
    isServerSettingsOpen ||
    contextMenu.menu ||
    actionModal.modal,
  );
  const shouldAnimateMessageGifs = isAnimationPlaybackActive && !isFloatingPanelOpen;
  const playAppearanceTransition = useCallback((from: ResolvedAppearanceMode, to: ResolvedAppearanceMode) => {
    if (from === to || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    if (appearanceTransitionTimerRef.current) {
      window.clearTimeout(appearanceTransitionTimerRef.current);
      appearanceTransitionTimerRef.current = null;
    }

    setAppearanceTransition({ id: window.performance.now(), from, to });
    appearanceTransitionTimerRef.current = window.setTimeout(() => {
      setAppearanceTransition(null);
      appearanceTransitionTimerRef.current = null;
    }, APPEARANCE_TRANSITION_MS + 80);
  }, []);

  useEffect(() => () => {
    if (appearanceTransitionTimerRef.current) {
      window.clearTimeout(appearanceTransitionTimerRef.current);
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CHANNELS_PANE_WIDTH_STORAGE_KEY, String(channelsPaneWidth));
    } catch {
      // Sidebar width is a local UI preference.
    }
  }, [channelsPaneWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MEMBERS_PANE_WIDTH_STORAGE_KEY, String(membersPaneWidth));
    } catch {
      // Sidebar width is a local UI preference.
    }
  }, [membersPaneWidth]);

  useEffect(() => {
    const handleWindowResize = () => {
      setChannelsPaneWidth((width) => clampChannelsPaneWidth(width));
      setMembersPaneWidth((width) => clampMembersPaneWidth(width));
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  useEffect(() => {
    if (!isPresenceMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!presenceMenuRef.current?.contains(event.target as Node)) {
        setIsPresenceMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsPresenceMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPresenceMenuOpen]);

  const handleChannelsPaneResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = channelsPaneWidth;
    setIsResizingChannelsPane(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      setChannelsPaneWidth(clampChannelsPaneWidth(startWidth + moveEvent.clientX - startX));
    };

    const finishResize = () => {
      setIsResizingChannelsPane(false);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
  }, [channelsPaneWidth]);

  const handleChannelsPaneResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 12 : -12;
      setChannelsPaneWidth((width) => clampChannelsPaneWidth(width + delta));
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setChannelsPaneWidth(MIN_CHANNELS_PANE_WIDTH);
    }

    if (event.key === 'End') {
      event.preventDefault();
      setChannelsPaneWidth(getChannelsPaneMaxWidth());
    }
  }, []);

  const handleMembersPaneResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = membersPaneWidth;
    setIsResizingMembersPane(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      setMembersPaneWidth(clampMembersPaneWidth(startWidth + startX - moveEvent.clientX));
    };

    const finishResize = () => {
      setIsResizingMembersPane(false);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
  }, [membersPaneWidth]);

  const handleMembersPaneResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? 12 : -12;
      setMembersPaneWidth((width) => clampMembersPaneWidth(width + delta));
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setMembersPaneWidth(MIN_MEMBERS_PANE_WIDTH);
    }

    if (event.key === 'End') {
      event.preventDefault();
      setMembersPaneWidth(getMembersPaneMaxWidth());
    }
  }, []);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const element = messagesListRef.current;
    if (!element) {
      return;
    }

    if (behavior === 'smooth') {
      element.scrollTo({
        top: element.scrollHeight,
        behavior,
      });
    } else {
      element.scrollTop = element.scrollHeight;
    }

    messagesAtBottomRef.current = true;
    pendingScrollToBottomRef.current = false;
    setNewMessageCount(0);
  }, []);

  const clearTypingStopTimer = useCallback(() => {
    if (typingStopTimerRef.current === null) {
      return;
    }
    window.clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = null;
  }, []);

  const emitTypingState = useCallback((channelId: string, isTyping: boolean) => {
    void apiPost<void>(`/api/v1/channels/${channelId}/typing`, { isTyping }).catch(() => {
      // Typing signals are best-effort only.
    });
  }, []);

  const copyToClipboard = useCallback(async (value: string, label: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable.');
      }
      await navigator.clipboard.writeText(value);
      actionModal.info({
        title: 'Copied',
        message: `${label} copied to clipboard.`,
        confirmLabel: 'Done',
      });
    } catch {
      actionModal.info({
        title: label,
        message: value,
        confirmLabel: 'Done',
      });
    }
  }, [actionModal]);

  const clearEmojiLongPressTimer = useCallback(() => {
    if (emojiLongPressTimerRef.current === null) {
      return;
    }
    window.clearTimeout(emojiLongPressTimerRef.current);
    emojiLongPressTimerRef.current = null;
  }, []);

  useEffect(() => {
    const needsEmojiCatalog = isGifModalOpen && (gifTab === 'emoji' || Boolean(emojiReactionMessageId));
    if (!needsEmojiCatalog || emojiCatalog.length > 0) {
      return;
    }

    let cancelled = false;
    void import('./emoji-catalog').then(({ EMOJI_CATALOG }) => {
      if (!cancelled) {
        setEmojiCatalog(EMOJI_CATALOG);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [emojiCatalog.length, emojiReactionMessageId, gifTab, isGifModalOpen]);

  useEffect(() => {
    if (!isGifModalOpen || gifTab !== 'emoji') {
      setEmojiTonePicker(null);
    }
  }, [gifTab, isGifModalOpen]);

  useEffect(() => clearEmojiLongPressTimer, [clearEmojiLongPressTimer]);

  useEffect(() => {
    let cancelled = false;
    const applyPayload = (payload?: Partial<CurrentDesktopAppearancePayload> | null) => {
      const normalized = normalizeAppearanceModePayload(payload);
      const previousResolvedMode = resolvedAppearanceModeRef.current;
      if (previousResolvedMode !== normalized.resolvedMode) {
        playAppearanceTransition(previousResolvedMode, normalized.resolvedMode);
      }
      resolvedAppearanceModeRef.current = normalized.resolvedMode;
      setAppearanceMode(normalized.mode);
      setResolvedAppearanceMode(normalized.resolvedMode);
    };
    const runtime = currentDesktopAppearanceRuntime();
    const hasGaiaAppearanceRuntime = Boolean(runtime?.getAppearanceMode || runtime?.onAppearanceModeChange);
    let disposeGaiaListener: (() => void) | undefined;

    if (runtime?.getAppearanceMode) {
      void runtime.getAppearanceMode().then((payload) => {
        if (!cancelled) {
          applyPayload(payload);
        }
      }).catch(() => {
        if (!cancelled) {
          applyPayload();
        }
      });
    }

    if (runtime?.onAppearanceModeChange) {
      disposeGaiaListener = runtime.onAppearanceModeChange((payload) => {
        if (!cancelled) {
          applyPayload(payload);
        }
      });
    }

    if (hasGaiaAppearanceRuntime) {
      return () => {
        cancelled = true;
        disposeGaiaListener?.();
      };
    }

    const systemQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
    const updateFromSystem = () => {
      applyPayload({
        mode: 'auto',
        resolvedMode: systemQuery?.matches ? 'dark' : 'light',
      });
    };
    updateFromSystem();
    systemQuery?.addEventListener('change', updateFromSystem);
    return () => {
      cancelled = true;
      systemQuery?.removeEventListener('change', updateFromSystem);
    };
  }, [playAppearanceTransition]);

  useEffect(() => {
    const current = new URL(window.location.href);
    const ticket = current.searchParams.get('current_auth_ticket');
    if (!ticket) {
      return;
    }

    setIsExchangingAuth(true);
    void apiPost<void>('/api/v1/auth/exchange', { ticket })
      .then(() => {
        current.searchParams.delete('current_auth_ticket');
        window.location.replace(current.toString());
      })
      .catch(() => {
        setIsExchangingAuth(false);
      });
  }, []);

  const setupQuery = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => apiGet<SetupStatus>('/api/v1/setup/status'),
    refetchInterval: 10_000,
  });

  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: () => apiGet<SessionPayload>('/api/v1/auth/session'),
    enabled: Boolean(setupQuery.data),
    retry: false,
  });
  const configuredUserReady = Boolean(setupQuery.data?.configured && sessionQuery.data?.user);
  const backgroundImageUrl = sessionQuery.data?.server.appearance?.background.url ?? '';

  useEffect(() => {
    if (!backgroundImageUrl) {
      setIsOverLightBackground(resolvedAppearanceMode === 'light');
      return;
    }

    let cancelled = false;
    void detectBrightBackgroundImage(backgroundImageUrl).then((isBright) => {
      if (!cancelled) {
        setIsOverLightBackground(isBright);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [backgroundImageUrl, resolvedAppearanceMode]);

  useEffect(() => {
    const serverId = setupQuery.data?.serverId;
    const currentUserId = sessionQuery.data?.user.id;
    if (!serverId || !currentUserId) {
      setE2eeState({ status: 'loading' });
      setDecryptedMessages({});
      return;
    }

    let cancelled = false;
    setE2eeState({ status: 'loading' });
    setDecryptedMessages({});

    void loadOrCreateE2eeKey(serverId)
      .then((state) => {
        if (!cancelled) {
          setE2eeState(state);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setE2eeState({
            status: 'unsupported',
            reason: error instanceof Error ? error.message : 'Unable to initialize E2EE.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [setupQuery.data?.serverId, sessionQuery.data?.user.id]);

  const channelsQuery = useInfiniteQuery({
    queryKey: ['channels'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        limit: String(CHANNELS_PAGE_LIMIT),
      });
      if (pageParam) {
        params.set('after', pageParam);
      }
      return apiGet<PageResponse<Channel>>(`/api/v1/channels?${params.toString()}`);
    },
    getNextPageParam: (lastPage) => (lastPage.pageInfo.hasMore ? lastPage.pageInfo.nextCursor : undefined),
    enabled: configuredUserReady,
  });

  const channels = useMemo(
    () => dedupeById((channelsQuery.data?.pages ?? []).flatMap((page) => page.items)),
    [channelsQuery.data?.pages],
  );

  const channelListItems = useMemo(() => buildChannelListItems(channels), [channels]);

  const currentChannel = useMemo(
    () =>
      channels.find((channel) => channel.id === selectedChannelId && channel.type !== 'category') ??
      channels.find((channel) => channel.type === 'text') ??
      null,
    [channels, selectedChannelId],
  );

  const openSearchModal = useCallback(() => {
    setSearchTab(isMessageChannel(currentChannel) ? 'messages' : 'users');
    setSearchInput('');
    setSearchQuery('');
    setSearchFromUserId('all');
    setSearchChannelId('all');
    setIsSearchModalOpen(true);
  }, [currentChannel?.type]);

  useEffect(() => {
    const activeChannelId = typingChannelRef.current;
    const selectedTextChannelId = isMessageChannel(currentChannel) ? currentChannel.id : null;
    if (!activeChannelId || activeChannelId === selectedTextChannelId) {
      return;
    }

    clearTypingStopTimer();
    emitTypingState(activeChannelId, false);
    typingChannelRef.current = null;
    typingHeartbeatAtRef.current = 0;
  }, [clearTypingStopTimer, currentChannel?.id, currentChannel?.type, emitTypingState]);

  useEffect(
    () => () => {
      clearTypingStopTimer();
      if (typingChannelRef.current) {
        emitTypingState(typingChannelRef.current, false);
      }
      typingChannelRef.current = null;
      typingHeartbeatAtRef.current = 0;
    },
    [clearTypingStopTimer, emitTypingState],
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const now = Date.now();
      setTypingByChannel((previous) => {
        let changed = false;
        const next: Record<string, Record<string, number>> = {};

        for (const [channelId, entries] of Object.entries(previous)) {
          const activeEntries = Object.fromEntries(
            Object.entries(entries).filter(([, expiresAt]) => expiresAt > now),
          );
          if (Object.keys(activeEntries).length > 0) {
            next[channelId] = activeEntries;
          }
          if (Object.keys(activeEntries).length !== Object.keys(entries).length) {
            changed = true;
          }
        }

        if (!changed && Object.keys(next).length === Object.keys(previous).length) {
          return previous;
        }

        return next;
      });
    }, 1_000);

    return () => window.clearInterval(intervalId);
  }, []);

  const messagesQuery = useInfiniteQuery({
    queryKey: ['messages', currentChannel?.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        limit: String(MESSAGES_PAGE_LIMIT),
      });
      if (pageParam) {
        params.set('before', pageParam);
      }
      return apiGet<PageResponse<Message>>(`/api/v1/channels/${currentChannel?.id}/messages?${params.toString()}`);
    },
    getNextPageParam: (lastPage) => (lastPage.pageInfo.hasMore ? lastPage.pageInfo.nextCursor : undefined),
    enabled: Boolean(sessionQuery.data?.user && currentChannel?.id && isMessageChannel(currentChannel)),
  });

  const messages = useMemo(() => {
    const pages = messagesQuery.data?.pages ?? [];
    const orderedPages = [...pages].reverse();
    return dedupeById(orderedPages.flatMap((page) => page.items));
  }, [messagesQuery.data?.pages]);

  const loadedMessagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const message of messages) {
      map.set(message.id, message);
    }
    return map;
  }, [messages]);

  const replyParentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      if (message.parentMessageId && !loadedMessagesById.has(message.parentMessageId)) {
        ids.add(message.parentMessageId);
      }
    }
    return [...ids].sort();
  }, [loadedMessagesById, messages]);

  const replyPreviewMessagesQuery = useQuery({
    queryKey: ['reply-preview-messages', currentChannel?.id, replyParentIds],
    queryFn: async () => {
      const currentChannelId = currentChannel?.id;
      if (!currentChannelId) {
        return [] as Message[];
      }

      const results = await Promise.all(
        replyParentIds.map((messageId) =>
          apiGet<Message>(`/api/v1/messages/${messageId}`).catch(() => null),
        ),
      );

      return results.filter(
        (message): message is Message => Boolean(message && message.channelId === currentChannelId),
      );
    },
    enabled: Boolean(currentChannel?.id && isMessageChannel(currentChannel) && replyParentIds.length > 0),
    staleTime: 30_000,
    retry: false,
  });

  const replyPreviewMessages = useMemo(
    () => replyPreviewMessagesQuery.data ?? [],
    [replyPreviewMessagesQuery.data],
  );

  const messagesById = useMemo(() => {
    const map = new Map(loadedMessagesById);
    for (const message of replyPreviewMessages) {
      if (!map.has(message.id)) {
        map.set(message.id, message);
      }
    }
    return map;
  }, [loadedMessagesById, replyPreviewMessages]);

  const updateCachedMessage = useCallback((message: Message) => {
    queryClient.setQueryData<InfiniteData<PageResponse<Message>>>(
      ['messages', message.channelId],
      (existing) => {
        if (!existing || existing.pages.length === 0) {
          return existing;
        }

        let changed = false;
        const pages = existing.pages.map((page) => ({
          ...page,
          items: page.items.map((item) => {
            if (item.id !== message.id) {
              return item;
            }
            changed = true;
            return message;
          }),
        }));

        if (!changed) {
          return existing;
        }

        return {
          ...existing,
          pages,
        };
      },
    );
  }, [queryClient]);

  useEffect(() => {
    if (e2eeState.status !== 'ready') {
      return;
    }

    const encryptedMessages = [...messages, ...replyPreviewMessages].filter((message) => message.encryptedContent);
    if (encryptedMessages.length === 0) {
      return;
    }

    let cancelled = false;
    void Promise.all(
      encryptedMessages.map(async (message) => {
        try {
          const content = await decryptMessageContent(e2eeState, message);
          return {
            messageId: message.id,
            state: {
              status: 'ready',
              content,
            } satisfies DecryptedMessageState,
          };
        } catch (error) {
          return {
            messageId: message.id,
            state: {
              status: 'error',
              reason: error instanceof Error ? error.message : 'Unable to decrypt message.',
            } satisfies DecryptedMessageState,
          };
        }
      }),
    ).then((results) => {
      if (cancelled) {
        return;
      }

      setDecryptedMessages((previous) => {
        const next = { ...previous };
        for (const result of results) {
          next[result.messageId] = result.state;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [e2eeState, messages, replyPreviewMessages]);

  const membersQuery = useInfiniteQuery({
    queryKey: ['members'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        limit: String(MEMBERS_PAGE_LIMIT),
      });
      if (pageParam) {
        params.set('after', pageParam);
      }
      return apiGet<PageResponse<MemberPayload>>(`/api/v1/members?${params.toString()}`);
    },
    getNextPageParam: (lastPage) => (lastPage.pageInfo.hasMore ? lastPage.pageInfo.nextCursor : undefined),
    enabled: configuredUserReady,
  });

  const pagedMembers = useMemo(
    () => dedupeById((membersQuery.data?.pages ?? []).flatMap((page) => page.items)),
    [membersQuery.data?.pages],
  );

  const handleChannelListScroll = useCallback(() => {
    if (!channelsQuery.hasNextPage || channelsQuery.isFetchingNextPage) {
      return;
    }
    const element = channelsListRef.current;
    if (!element) {
      return;
    }
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (remaining <= PAGE_SCROLL_THRESHOLD_PX) {
      void channelsQuery.fetchNextPage();
    }
  }, [channelsQuery]);

  const handleMembersPaneScroll = useCallback(() => {
    if (!membersQuery.hasNextPage || membersQuery.isFetchingNextPage) {
      return;
    }
    const element = membersPaneRef.current;
    if (!element) {
      return;
    }
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (remaining <= PAGE_SCROLL_THRESHOLD_PX) {
      void membersQuery.fetchNextPage();
    }
  }, [membersQuery]);

  useEffect(() => {
    if (!channelsQuery.hasNextPage || channelsQuery.isFetchingNextPage) {
      return;
    }
    const element = channelsListRef.current;
    if (!element) {
      return;
    }

    const remaining = element.scrollHeight - element.clientHeight;
    if (remaining <= PAGE_SCROLL_THRESHOLD_PX) {
      void channelsQuery.fetchNextPage();
    }
  }, [channels.length, channelsQuery]);

  useEffect(() => {
    if (!membersQuery.hasNextPage || membersQuery.isFetchingNextPage) {
      return;
    }
    const element = membersPaneRef.current;
    if (!element) {
      return;
    }

    const remaining = element.scrollHeight - element.clientHeight;
    if (remaining <= PAGE_SCROLL_THRESHOLD_PX) {
      void membersQuery.fetchNextPage();
    }
  }, [membersQuery, pagedMembers.length]);

  const handleMessagesScroll = useCallback(() => {
    if (!currentChannel?.id || !isMessageChannel(currentChannel)) {
      return;
    }

    const element = messagesListRef.current;
    if (!element) {
      return;
    }

    const isAtBottom = isNearScrollBottom(element);
    messagesAtBottomRef.current = isAtBottom;
    if (isAtBottom) {
      pendingScrollToBottomRef.current = false;
      setNewMessageCount(0);
    }

    if (
      messagesQuery.hasNextPage &&
      !messagesQuery.isFetchingNextPage &&
      element.scrollTop <= PAGE_SCROLL_THRESHOLD_PX
    ) {
      prependScrollAnchorRef.current = {
        channelId: currentChannel.id,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      };
      void messagesQuery.fetchNextPage();
    }
  }, [currentChannel?.id, currentChannel?.type, messagesQuery]);

  const updateMessageHoverToolbarPlacement = useCallback((messageId: string, element: HTMLElement) => {
    const messagesRect = messagesListRef.current?.getBoundingClientRect();
    const messageRect = element.getBoundingClientRect();
    const topBoundary = messagesRect?.top ?? 0;
    const placement: MessageToolbarPlacement =
      messageRect.top - topBoundary < MESSAGE_HOVER_TOOLBAR_MIN_TOP_SPACE ? 'bottom' : 'top';

    setMessageHoverToolbar((current) => {
      if (current?.messageId === messageId && current.placement === placement) {
        return current;
      }
      return { messageId, placement };
    });
  }, []);

  const handleJumpToLatestMessages = useCallback(() => {
    prependScrollAnchorRef.current = null;
    pendingScrollToBottomRef.current = true;
    window.requestAnimationFrame(() => scrollMessagesToBottom('smooth'));
  }, [scrollMessagesToBottom]);

  const handleMessageContentResized = useCallback(() => {
    if (!messagesAtBottomRef.current || prependScrollAnchorRef.current) {
      return;
    }

    window.requestAnimationFrame(() => scrollMessagesToBottom());
  }, [scrollMessagesToBottom]);

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => apiGet<RolePayload[]>('/api/v1/roles'),
    enabled: configuredUserReady,
  });

  const voiceStateQuery = useQuery({
    queryKey: ['voice-state'],
    queryFn: () => apiGet<VoiceState[]>('/api/v1/voice/state'),
    enabled: configuredUserReady,
    refetchInterval: 3_000,
  });

  const presenceQuery = useQuery({
    queryKey: ['presence'],
    queryFn: () => apiGet<PresenceResponse>('/api/v1/presence'),
    enabled: configuredUserReady,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (!presenceQuery.data) {
      return;
    }

    setSelfPresenceStatus(presenceQuery.data.selfStatus);
    setPresenceByUserId((previous) => {
      const next = { ...previous };
      for (const presence of presenceQuery.data.items) {
        next[presence.userId] = presence;
      }
      return next;
    });
  }, [presenceQuery.data]);

  const voiceClient = useVoiceClient({
    currentUserId: sessionQuery.data?.user?.id,
  });
  const voiceNetworkDiagnosticsLabel = useMemo(
    () => formatVoiceNetworkDiagnostics(voiceClient.diagnostics),
    [voiceClient.diagnostics],
  );

  const gatewayState = useGateway(configuredUserReady, useCallback((event) => {
    voiceClient.handleGatewayEvent(event);

    if (event.type === 'VOICE_STATE_UPDATE') {
      void queryClient.invalidateQueries({ queryKey: ['voice-state'] });
    }

    if (event.type === 'SERVER_UPDATE') {
      const payload = event.payload as { server?: SessionPayload['server'] };
      if (payload.server) {
        queryClient.setQueryData<SessionPayload>(['session'], (existing) =>
          existing
            ? {
                ...existing,
                server: {
                  ...existing.server,
                  ...payload.server,
                },
              }
            : existing,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['session'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      return;
    }

    if (event.type === 'VOICE_SPEAKING') {
      const payload = event.payload as { userId?: string; speaking?: boolean };
      if (payload.userId) {
        setVoiceSpeakingUserIds((previous) => {
          const next = new Set(previous);
          if (payload.speaking) {
            next.add(payload.userId!);
          } else {
            next.delete(payload.userId!);
          }
          return next;
        });
      }
      return;
    }

    if (event.type === 'MESSAGE_CREATE') {
      const payload = event.payload as { message?: Message };
      const message = payload.message;
      if (message?.channelId) {
        const existingMessages = queryClient.getQueryData<InfiniteData<PageResponse<Message>>>([
          'messages',
          message.channelId,
        ]);
        const messageAlreadyCached = Boolean(
          existingMessages?.pages.some((page) => page.items.some((item) => item.id === message.id)),
        );
        const isIncomingForCurrentChannel =
          message.channelId === currentChannel?.id &&
          Boolean(existingMessages?.pages.length) &&
          !messageAlreadyCached;

        if (isIncomingForCurrentChannel) {
          const element = messagesListRef.current;
          const isAtBottom = element ? isNearScrollBottom(element) : messagesAtBottomRef.current;
          messagesAtBottomRef.current = isAtBottom;

          if (isAtBottom) {
            pendingScrollToBottomRef.current = true;
          } else {
            setNewMessageCount((previous) => previous + 1);
          }
        }

        queryClient.setQueryData<InfiniteData<PageResponse<Message>>>(
          ['messages', message.channelId],
          (existing) => {
            if (!existing || existing.pages.length === 0) {
              return existing;
            }

            let replaced = false;
            const pages = existing.pages.map((page) => ({
              ...page,
              items: page.items.map((item) => {
                if (item.id !== message.id) {
                  return item;
                }
                replaced = true;
                return message;
              }),
            }));

            if (replaced) {
              return {
                ...existing,
                pages,
              };
            }

            const [latestPage, ...restPages] = pages;
            return {
              ...existing,
              pages: [
                {
                  ...latestPage,
                  items: [...latestPage.items, message],
                },
                ...restPages,
              ],
            };
          },
        );
      }

      const channelId = message?.channelId;
      const authorId = message?.authorId;
      if (channelId && authorId) {
        setTypingByChannel((previous) => {
          const channelTyping = previous[channelId];
          if (!channelTyping || !(authorId in channelTyping)) {
            return previous;
          }

          const remaining = { ...channelTyping };
          delete remaining[authorId];
          if (Object.keys(remaining).length === 0) {
            const withoutChannel = { ...previous };
            delete withoutChannel[channelId];
            return withoutChannel;
          }

          return {
            ...previous,
            [channelId]: remaining,
          };
        });
      }
      return;
    }

    if (event.type === 'MESSAGE_UPDATE') {
      const payload = event.payload as { message?: Message };
      const message = payload.message;
      if (!message?.channelId) {
        return;
      }

      updateCachedMessage(message);
      return;
    }

    if (event.type === 'MESSAGE_DELETE') {
      const payload = event.payload as { messageId?: string; channelId?: string };
      if (!payload.messageId || !payload.channelId) {
        return;
      }

      queryClient.setQueryData<InfiniteData<PageResponse<Message>>>(
        ['messages', payload.channelId],
        (existing) => {
          if (!existing || existing.pages.length === 0) {
            return existing;
          }

          let changed = false;
          const pages = existing.pages.map((page) => {
            const items = page.items.filter((item) => item.id !== payload.messageId);
            if (items.length !== page.items.length) {
              changed = true;
            }
            return {
              ...page,
              items,
            };
          });

          if (!changed) {
            return existing;
          }

          return {
            ...existing,
            pages,
          };
        },
      );
      return;
    }

    if (event.type === 'TYPING_UPDATE') {
      const payload = event.payload as TypingUpdateEventPayload;
      const channelId = payload.channelId;
      const userId = payload.userId;
      if (!channelId || !userId || userId === sessionQuery.data?.user?.id) {
        return;
      }

      const isTyping = payload.isTyping !== false;
      setTypingByChannel((previous) => {
        const channelTyping = previous[channelId] ?? {};

        if (!isTyping) {
          if (!(userId in channelTyping)) {
            return previous;
          }

          const remaining = { ...channelTyping };
          delete remaining[userId];
          if (Object.keys(remaining).length === 0) {
            const withoutChannel = { ...previous };
            delete withoutChannel[channelId];
            return withoutChannel;
          }

          return {
            ...previous,
            [channelId]: remaining,
          };
        }

        return {
          ...previous,
          [channelId]: {
            ...channelTyping,
            [userId]: Date.now() + TYPING_TTL_MS,
          },
        };
      });
      return;
    }

    if (event.type === 'PRESENCE_UPDATE') {
      const payload = event.payload as { presence?: UserPresence };
      const { presence } = payload;
      if (presence?.userId) {
        setPresenceByUserId((previous) => ({
          ...previous,
          [presence.userId]: presence,
        }));
        if (
          presence.userId === sessionQuery.data?.user?.id &&
          presence.status !== 'offline'
        ) {
          setSelfPresenceStatus(presence.status);
        }
        return;
      }

      void queryClient.invalidateQueries({ queryKey: ['channels'] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    }

    if (event.type === 'MOD_ACTION') {
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      void queryClient.invalidateQueries({ queryKey: ['voice-state'] });
    }
  }, [currentChannel?.id, queryClient, sessionQuery.data?.user?.id, updateCachedMessage, voiceClient.handleGatewayEvent]));

  useEffect(() => {
    const currentUser = sessionQuery.data?.user;
    if (!configuredUserReady || !currentUser) {
      return;
    }

    setPresenceByUserId((previous) => {
      const existing = previous[currentUser.id];
      if (gatewayState.status !== 'online') {
        if (existing?.status === 'offline' && !existing.connected) {
          return previous;
        }
        return {
          ...previous,
          [currentUser.id]: {
            userId: currentUser.id,
            status: 'offline',
            connected: false,
          },
        };
      }

      const nextStatus = existing && existing.status !== 'offline' ? existing.status : selfPresenceStatus;
      if (existing?.connected && existing.status === nextStatus) {
        return previous;
      }
      return {
        ...previous,
        [currentUser.id]: {
          userId: currentUser.id,
          status: nextStatus,
          connected: true,
        },
      };
    });
  }, [configuredUserReady, gatewayState.status, selfPresenceStatus, sessionQuery.data?.user]);

  const membersById = useMemo(() => {
    const map = new Map<string, SessionPayload['user'] | MemberPayload>();
    const currentUser = sessionQuery.data?.user;
    if (currentUser) {
      map.set(currentUser.id, currentUser);
    }

    for (const member of pagedMembers) {
      map.set(member.id, member);
    }
    return map;
  }, [pagedMembers, sessionQuery.data?.user]);

  const memberList = useMemo(() => {
    const currentUser = sessionQuery.data?.user;
    if (!currentUser) {
      return [] as Array<SessionPayload['user'] | MemberPayload>;
    }

    const deduped = new Map<string, SessionPayload['user'] | MemberPayload>();
    deduped.set(currentUser.id, currentUser);
    for (const member of pagedMembers) {
      deduped.set(member.id, member);
    }

    return Array.from(deduped.values()).sort(
      (a, b) => a.displayName.localeCompare(b.displayName) || a.handle.localeCompare(b.handle),
    );
  }, [pagedMembers, sessionQuery.data?.user]);

  const isLanMode = setupQuery.data?.authMode === 'lan';

  const visibleMemberList = useMemo(
    () => (isLanMode ? memberList.filter((member) => isLanIdentity(member)) : memberList),
    [isLanMode, memberList],
  );

  useEffect(() => {
    if (!presenceQuery.data) {
      return;
    }

    const receivedUserIds = new Set(presenceQuery.data.items.map((presence) => presence.userId));
    setPresenceByUserId((previous) => {
      let changed = false;
      const next = { ...previous };

      for (const member of visibleMemberList) {
        if (receivedUserIds.has(member.id)) {
          continue;
        }

        const existing = next[member.id];
        if (!existing || existing.status !== 'offline' || existing.connected) {
          next[member.id] = {
            userId: member.id,
            status: 'offline',
            connected: false,
          };
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [presenceQuery.data, visibleMemberList]);

  const roleById = useMemo(
    () => new Map((rolesQuery.data ?? []).map((role) => [role.id, role])),
    [rolesQuery.data],
  );

  const searchedUsers = useMemo(() => {
    const normalizedQuery = searchQuery.toLowerCase();
    return [...visibleMemberList]
      .sort((a, b) => {
        const byCreatedAt = getMemberCreatedAtTimestamp(b) - getMemberCreatedAtTimestamp(a);
        if (byCreatedAt !== 0) {
          return byCreatedAt;
        }
        return a.displayName.localeCompare(b.displayName);
      })
      .filter((member) => {
        if (!normalizedQuery) {
          return true;
        }
        return (
          member.displayName.toLowerCase().includes(normalizedQuery) ||
          member.handle.toLowerCase().includes(normalizedQuery)
        );
      })
      .slice(0, MAX_SEARCH_RESULTS);
  }, [searchQuery, visibleMemberList]);

  const searchableChannels = useMemo(
    () => channels.filter((channel) => isMessageChannel(channel)),
    [channels],
  );

  const membersByMention = useMemo(() => {
    const map = new Map<string, SessionPayload['user'] | MemberPayload>();
    for (const member of visibleMemberList) {
      if (member.handle.trim().length > 0) {
        map.set(normalizeReferenceToken(member.handle), member);
      }
    }
    return map;
  }, [visibleMemberList]);

  const channelsByMention = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const channel of searchableChannels) {
      if (channel.name.trim().length > 0) {
        map.set(normalizeReferenceToken(channel.name), channel);
      }
    }
    return map;
  }, [searchableChannels]);

  const activeComposerReference = useMemo(
    () => getActiveComposerReference(messageText, composerCaretPosition),
    [composerCaretPosition, messageText],
  );

  const composerSuggestions = useMemo(() => {
    if (!activeComposerReference || !isMessageChannel(currentChannel)) {
      return [] as MentionSuggestion[];
    }

    const query = activeComposerReference.query.toLowerCase();
    if (activeComposerReference.trigger === '@') {
      return visibleMemberList
        .filter((member) => {
          if (!query) {
            return true;
          }
          return (
            member.displayName.toLowerCase().includes(query) ||
            member.handle.toLowerCase().includes(query)
          );
        })
        .slice(0, MAX_MENTION_RESULTS)
        .map((member): MentionSuggestion => ({
          kind: 'member',
          member,
        }));
    }

    return searchableChannels
      .filter((channel) => !query || channel.name.toLowerCase().includes(query))
      .slice(0, MAX_MENTION_RESULTS)
      .map((channel): MentionSuggestion => ({
        kind: 'channel',
        channel,
      }));
  }, [activeComposerReference, currentChannel?.type, searchableChannels, visibleMemberList]);

  const showComposerSuggestions = isComposerFocused && composerSuggestions.length > 0;

  useEffect(() => {
    setActiveComposerSuggestionIndex(0);
  }, [activeComposerReference?.query, activeComposerReference?.trigger]);

  const typingDisplayNames = useMemo(() => {
    if (!isMessageChannel(currentChannel)) {
      return [] as string[];
    }

    const channelTyping = typingByChannel[currentChannel.id] ?? {};
    const now = Date.now();
    const userId = sessionQuery.data?.user?.id;

    return Object.entries(channelTyping)
      .filter(([typingUserId, expiresAt]) => expiresAt > now && typingUserId !== userId)
      .map(([typingUserId]) => {
        const member = membersById.get(typingUserId);
        if (member?.displayName) {
          return member.displayName;
        }
        if (member?.handle) {
          return formatIdentityHandle(member);
        }
        return 'Someone';
      });
  }, [currentChannel, membersById, sessionQuery.data?.user?.id, typingByChannel]);

  const typingSummary = useMemo(() => formatTypingSummary(typingDisplayNames), [typingDisplayNames]);

  const voiceStatesByChannelId = useMemo(() => {
    const map = new Map<string, VoiceState[]>();
    for (const voiceState of voiceStateQuery.data ?? []) {
      const displayState = {
        ...voiceState,
        speaking: voiceSpeakingUserIds.has(voiceState.userId),
      };
      const list = map.get(displayState.channelId);
      if (list) {
        list.push(displayState);
      } else {
        map.set(displayState.channelId, [displayState]);
      }
    }
    return map;
  }, [voiceSpeakingUserIds, voiceStateQuery.data]);

  const voicePresenceByUserId = useMemo(() => {
    const map = new Map<string, VoiceState>();
    for (const voiceState of voiceStateQuery.data ?? []) {
      map.set(voiceState.userId, {
        ...voiceState,
        speaking: voiceSpeakingUserIds.has(voiceState.userId),
      });
    }
    return map;
  }, [voiceSpeakingUserIds, voiceStateQuery.data]);

  const memberRosterSections = useMemo(() => {
    const getTopRole = (member: SessionPayload['user'] | MemberPayload): RolePayload | undefined => {
      return member.roleIds
        .map((roleId) => roleById.get(roleId))
        .filter((role): role is RolePayload => Boolean(role))
        .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name))[0];
    };

    const getVoiceRank = (memberId: string): number => {
      const voiceState = voicePresenceByUserId.get(memberId);
      if (voiceState?.speaking) {
        return 0;
      }
      if (voiceState) {
        return 1;
      }
      return 2;
    };

    const getPresence = (memberId: string): UserPresence =>
      presenceByUserId[memberId] ?? {
        userId: memberId,
        status: 'offline',
        connected: false,
      };

    const entries = visibleMemberList.map((member) => ({
      member,
      topRole: getTopRole(member),
      presence: getPresence(member.id),
    }));

    const sortOnline = (a: MemberRosterEntry, b: MemberRosterEntry) => {
      const byVoice = getVoiceRank(a.member.id) - getVoiceRank(b.member.id);
      if (byVoice !== 0) {
        return byVoice;
      }

      const byPresence = getPresenceSortRank(a.presence.status) - getPresenceSortRank(b.presence.status);
      if (byPresence !== 0) {
        return byPresence;
      }

      const byRole = (b.topRole?.position ?? 0) - (a.topRole?.position ?? 0);
      if (byRole !== 0) {
        return byRole;
      }

      return (
        a.member.displayName.localeCompare(b.member.displayName) ||
        a.member.handle.localeCompare(b.member.handle)
      );
    };

    const sortOffline = (a: MemberRosterEntry, b: MemberRosterEntry) =>
      a.member.displayName.localeCompare(b.member.displayName) ||
      a.member.handle.localeCompare(b.member.handle);

    const online = entries.filter((entry) => isVisibleOnlinePresence(entry.presence)).sort(sortOnline);
    const offline = entries.filter((entry) => !isVisibleOnlinePresence(entry.presence)).sort(sortOffline);

    return [
      {
        id: 'online',
        label: 'Online Users',
        members: online,
      },
      {
        id: 'offline',
        label: 'Offline Users',
        members: offline,
      },
    ];
  }, [presenceByUserId, roleById, visibleMemberList, voicePresenceByUserId]);

  const selfVoiceState = useMemo(() => {
    const currentUserId = sessionQuery.data?.user?.id;
    if (!currentUserId) {
      return null;
    }
    return currentUserId ? voicePresenceByUserId.get(currentUserId) ?? null : null;
  }, [sessionQuery.data?.user?.id, voicePresenceByUserId]);

  const connectedVoiceChannel = useMemo(() => {
    if (!selfVoiceState?.channelId) {
      return null;
    }
    return channels.find((channel) => channel.id === selfVoiceState.channelId) ?? null;
  }, [channels, selfVoiceState?.channelId]);

  const selectedVoiceParticipants = useMemo(() => {
    if (currentChannel?.type !== 'voice') {
      return [] as VoiceState[];
    }
    return voiceStatesByChannelId.get(currentChannel.id) ?? [];
  }, [currentChannel?.id, currentChannel?.type, voiceStatesByChannelId]);

  const connectedVoiceParticipants = useMemo(() => {
    if (!selfVoiceState?.channelId) {
      return [] as VoiceState[];
    }
    return voiceStatesByChannelId.get(selfVoiceState.channelId) ?? [];
  }, [selfVoiceState?.channelId, voiceStatesByChannelId]);

  const currentPermissions = useMemo(() => {
    const roleIds = sessionQuery.data?.user?.roleIds ?? [];
    const roleMap = new Map((rolesQuery.data ?? []).map((role) => [role.id, role]));
    const granted = new Set<string>();
    for (const roleId of roleIds) {
      const role = roleMap.get(roleId);
      if (!role) {
        continue;
      }
      for (const permission of role.permissions) {
        granted.add(permission);
      }
    }
    return granted;
  }, [rolesQuery.data, sessionQuery.data?.user?.roleIds]);

  const canManageChannels =
    currentPermissions.has('ADMINISTRATOR') || currentPermissions.has('MANAGE_CHANNELS');
  const canModerateMembers =
    currentPermissions.has('ADMINISTRATOR') || currentPermissions.has('MODERATE_MEMBERS');
  const canManageServer =
    currentPermissions.has('ADMINISTRATOR') || currentPermissions.has('MANAGE_SERVER');
  const canManageMessages =
    currentPermissions.has('ADMINISTRATOR') || currentPermissions.has('MANAGE_MESSAGES');
  const canOpenServerSettings =
    currentPermissions.has('ADMINISTRATOR') ||
    sessionQuery.data?.ownership?.ownerUserId === sessionQuery.data?.user?.id;

  useEffect(() => {
    if (!isGifModalOpen || gifTab !== 'gifs') {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const normalized = gifSearchInput.trim();
      setGifSearchQuery(normalized.length > 0 ? normalized : 'Trending GIFs');
    }, 220);

    return () => window.clearTimeout(timeoutId);
  }, [gifSearchInput, isGifModalOpen, gifTab]);

  useEffect(() => {
    if (!isGifModalOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsGifModalOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isGifModalOpen]);

  useEffect(() => {
    if (!isSearchModalOpen) {
      setSearchInput('');
      setSearchQuery('');
      setSearchTab('messages');
      setSearchFromUserId('all');
      setSearchChannelId('all');
      return;
    }

    const timeoutId = window.setTimeout(() => {
      searchModalInputRef.current?.focus();
      searchModalInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [isSearchModalOpen]);

  useEffect(() => {
    if (!isSearchModalOpen) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [isSearchModalOpen, searchInput]);

  useEffect(() => {
    if (!isSearchModalOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsSearchModalOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isSearchModalOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearchModal();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openSearchModal]);

  useEffect(() => {
    if (!currentChannel?.id || !isMessageChannel(currentChannel)) {
      initialBottomScrollChannelIdRef.current = null;
      prependScrollAnchorRef.current = null;
      pendingScrollToBottomRef.current = false;
      messagesAtBottomRef.current = true;
      setNewMessageCount(0);
      setReplyDraft(null);
      return;
    }
    if (initialBottomScrollChannelIdRef.current !== currentChannel.id) {
      initialBottomScrollChannelIdRef.current = null;
      prependScrollAnchorRef.current = null;
      pendingScrollToBottomRef.current = false;
      messagesAtBottomRef.current = true;
      setNewMessageCount(0);
      setReplyDraft(null);
    }
  }, [currentChannel?.id, currentChannel?.type]);

  useEffect(() => {
    const anchor = prependScrollAnchorRef.current;
    if (!anchor || anchor.channelId !== currentChannel?.id || messagesQuery.isFetchingNextPage) {
      return;
    }
    const element = messagesListRef.current;
    if (!element) {
      prependScrollAnchorRef.current = null;
      return;
    }

    const delta = element.scrollHeight - anchor.scrollHeight;
    element.scrollTop = anchor.scrollTop + delta;
    prependScrollAnchorRef.current = null;
  }, [currentChannel?.id, messagesQuery.data?.pages.length, messagesQuery.isFetchingNextPage]);

  useEffect(() => {
    if (!currentChannel?.id || !isMessageChannel(currentChannel)) {
      return;
    }
    if (prependScrollAnchorRef.current) {
      return;
    }
    if (!pendingScrollToBottomRef.current && !messagesAtBottomRef.current) {
      return;
    }
    if (initialBottomScrollChannelIdRef.current !== currentChannel.id && !pendingScrollToBottomRef.current) {
      return;
    }

    const frame = window.requestAnimationFrame(() => scrollMessagesToBottom());
    return () => window.cancelAnimationFrame(frame);
  }, [
    currentChannel?.id,
    currentChannel?.type,
    messages.length,
    messagesQuery.data?.pages.length,
    scrollMessagesToBottom,
  ]);

  useEffect(() => {
    if (!currentChannel?.id || !isMessageChannel(currentChannel) || messagesQuery.isFetching) {
      return;
    }
    if (initialBottomScrollChannelIdRef.current === currentChannel.id) {
      return;
    }

    scrollMessagesToBottom();
    initialBottomScrollChannelIdRef.current = currentChannel.id;
  }, [
    currentChannel?.id,
    currentChannel?.type,
    messagesQuery.isFetching,
    messages.length,
    scrollMessagesToBottom,
  ]);

  useEffect(() => {
    if (!currentChannel?.id || !isMessageChannel(currentChannel)) {
      return;
    }
    handleMessageContentResized();
  }, [currentChannel?.id, currentChannel?.type, decryptedMessages, handleMessageContentResized]);

  const sendMessageMutation = useMutation({
    mutationFn: async (input?: {
      content?: string;
      gifUrl?: string;
      attachmentIds?: string[];
      parentMessageId?: string;
      keepComposerDraft?: boolean;
    }) => {
      if (!currentChannel?.id || !isMessageChannel(currentChannel)) {
        return;
      }

      const authorId = sessionQuery.data?.user.id;
      if (!authorId) {
        return;
      }

      const plainContent = input?.content ?? messageText;
      const trimmedContent = plainContent.trim();
      const parentMessageId =
        input?.parentMessageId ??
        (replyDraft?.channelId === currentChannel.id ? replyDraft.messageId : undefined);
      const encryptedContent =
        trimmedContent.length > 0 && e2eeState.status === 'ready'
          ? await encryptMessageContent(e2eeState, plainContent, {
              channelId: currentChannel.id,
              authorId,
            })
          : undefined;

      if (trimmedContent.length > 0 && !encryptedContent) {
        throw new Error('Message encryption is still preparing the shared room key.');
      }

      await apiPost(`/api/v1/channels/${currentChannel.id}/messages`, {
        content: encryptedContent ? '' : plainContent,
        encryptedContent,
        parentMessageId,
        gifUrl: input?.gifUrl,
        attachmentIds: input?.attachmentIds ?? attachmentIds,
      });
    },
    onSuccess: async (_data, input) => {
      const channelId = currentChannel?.id;
      if (channelId && typingChannelRef.current === channelId) {
        clearTypingStopTimer();
        emitTypingState(channelId, false);
        typingChannelRef.current = null;
        typingHeartbeatAtRef.current = 0;
      }

      if (!input?.keepComposerDraft) {
        setMessageText('');
        setComposerCaretPosition(0);
        setAttachmentIds([]);
      }
      setReplyDraft(null);
    },
  });

  const rememberReactionEmoji = useCallback((emoji: string) => {
    setRecentReactionEmojis((previous) => {
      const next = [emoji, ...previous.filter((item) => item !== emoji)].slice(0, 3);
      try {
        window.localStorage.setItem(RECENT_REACTION_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Local storage is optional.
      }
      return next;
    });
  }, []);

  const reactionMutation = useMutation({
    mutationFn: (input: { messageId: string; emoji: string }) =>
      apiPost<Message>(`/api/v1/messages/${input.messageId}/reactions`, { emoji: input.emoji }),
    onSuccess: (message, input) => {
      rememberReactionEmoji(input.emoji);
      updateCachedMessage(message);
      setEmojiReactionMessageId(null);
    },
  });

  const handleToggleReaction = useCallback((messageId: string, emoji: string) => {
    reactionMutation.mutate({ messageId, emoji });
  }, [reactionMutation]);

  const gifSearchQueryResult = useQuery({
    queryKey: ['gif-search', gifSearchQuery],
    queryFn: () =>
      apiGet<GifSearchResponse>(
        `/api/v1/media/gifs/search?q=${encodeURIComponent(gifSearchQuery)}&limit=${MAX_GIF_RESULTS}`,
      ),
    enabled: Boolean(sessionQuery.data?.user && isGifModalOpen && gifTab === 'gifs'),
    staleTime: 30_000,
    retry: false,
  });

  const messageSearchQuery = useQuery({
    queryKey: ['message-search', searchQuery, searchFromUserId, searchChannelId],
    queryFn: () => {
      const params = new URLSearchParams({
        limit: String(MAX_SEARCH_RESULTS),
      });
      if (searchQuery.length > 0) {
        params.set('q', searchQuery);
      }
      if (searchFromUserId !== 'all') {
        params.set('from', searchFromUserId);
      }
      if (searchChannelId !== 'all') {
        params.set('channelId', searchChannelId);
      }
      return apiGet<MessageSearchResponse>(`/api/v1/messages/search?${params.toString()}`);
    },
    enabled: Boolean(
      sessionQuery.data?.user &&
      isSearchModalOpen &&
      searchTab === 'messages',
    ),
    staleTime: 8_000,
    retry: false,
  });

  const messageSearchSections = useMemo(() => {
    const sections: Array<{ channelId: string; channelName: string; items: Message[] }> = [];
    const byChannelId = new Map<string, { channelId: string; channelName: string; items: Message[] }>();
    const channelNameById = new Map(channels.map((channel) => [channel.id, channel.name]));

    for (const message of messageSearchQuery.data?.items ?? []) {
      let section = byChannelId.get(message.channelId);
      if (!section) {
        section = {
          channelId: message.channelId,
          channelName: channelNameById.get(message.channelId) ?? 'unknown-channel',
          items: [],
        };
        byChannelId.set(message.channelId, section);
        sections.push(section);
      }
      section.items.push(message);
    }

    return sections;
  }, [channels, messageSearchQuery.data?.items]);

  useEffect(() => {
    if (e2eeState.status !== 'ready') {
      return;
    }

    const encryptedMessages = (messageSearchQuery.data?.items ?? []).filter((message) => message.encryptedContent);
    if (encryptedMessages.length === 0) {
      return;
    }

    let cancelled = false;
    void Promise.all(
      encryptedMessages.map(async (message) => {
        try {
          const content = await decryptMessageContent(e2eeState, message);
          return {
            messageId: message.id,
            state: {
              status: 'ready',
              content,
            } satisfies DecryptedMessageState,
          };
        } catch (error) {
          return {
            messageId: message.id,
            state: {
              status: 'error',
              reason: error instanceof Error ? error.message : 'Unable to decrypt message.',
            } satisfies DecryptedMessageState,
          };
        }
      }),
    ).then((results) => {
      if (cancelled) {
        return;
      }

      setDecryptedMessages((previous) => {
        const next = { ...previous };
        for (const result of results) {
          next[result.messageId] = result.state;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [e2eeState, messageSearchQuery.data?.items]);

  const gifTiles = useMemo(
    () =>
      (gifSearchQueryResult.data?.results ?? [])
        .slice(0, MAX_GIF_RESULTS)
        .map((result, index) => {
          const selectUrl = result.media_formats?.mp4?.url ?? result.media_formats?.gif?.url;
          const previewUrl = result.media_formats?.tinygif?.url ?? result.media_formats?.gif?.url ?? selectUrl;
          if (!selectUrl || !previewUrl) {
            return null;
          }

          return {
            id: result.id ?? `${gifSearchQuery}-${index}`,
            selectUrl,
            previewUrl,
            label: result.content_description ?? gifSearchQuery,
          };
        })
        .filter((item): item is GifTile => Boolean(item)),
    [gifSearchQueryResult.data?.results, gifSearchQuery],
  );
  const gifProviderWarning = gifSearchQueryResult.data?.providerError?.message;
  const handleGifSelect = useCallback((tile: GifTile) => {
    if (sendMessageMutation.isPending) {
      return;
    }

    sendMessageMutation.mutate({
      content: '',
      gifUrl: tile.selectUrl,
      attachmentIds: [],
      keepComposerDraft: true,
    });
    setEmojiTonePicker(null);
    setEmojiReactionMessageId(null);
    setIsGifModalOpen(false);
  }, [sendMessageMutation]);
  const emojiToneIndex = useMemo(() => buildEmojiToneIndex(emojiCatalog), [emojiCatalog]);
  const filteredEmoji = useMemo(() => {
    const query = emojiSearchInput.trim().toLowerCase();
    const matches = emojiCatalog.filter((entry) => {
      if (!shouldShowEmojiEntry(entry, emojiToneIndex)) {
        return false;
      }

      if (!query) {
        return true;
      }
      const toneGroup = getEmojiToneGroupForEntry(entry, emojiToneIndex);
      const toneMatches = toneGroup?.variants.some(
        (variant) => variant.emoji.includes(query) || variant.name.includes(query) || variant.label.toLowerCase().includes(query),
      );
      return (
        entry.name.includes(query) ||
        entry.keywords.some((keyword) => keyword.includes(query)) ||
        entry.emoji.includes(query) ||
        Boolean(toneMatches)
      );
    });
    return matches;
  }, [emojiCatalog, emojiSearchInput, emojiToneIndex]);

  const updateComposerCaretFromInput = useCallback((input: HTMLTextAreaElement) => {
    setComposerCaretPosition(input.selectionStart ?? input.value.length);
  }, []);

  const handleComposerInputChange = useCallback((nextValue: string, nextCaretPosition = nextValue.length) => {
    setMessageText(nextValue);
    setComposerCaretPosition(nextCaretPosition);

    const channelId = isMessageChannel(currentChannel) ? currentChannel.id : null;
    if (!channelId) {
      return;
    }

    const hasTypedText = nextValue.trim().length > 0;
    if (!hasTypedText) {
      if (typingChannelRef.current === channelId) {
        clearTypingStopTimer();
        emitTypingState(channelId, false);
        typingChannelRef.current = null;
        typingHeartbeatAtRef.current = 0;
      }
      return;
    }

    const now = Date.now();
    if (typingChannelRef.current !== channelId || now - typingHeartbeatAtRef.current >= TYPING_HEARTBEAT_MS) {
      emitTypingState(channelId, true);
      typingChannelRef.current = channelId;
      typingHeartbeatAtRef.current = now;
    }

    clearTypingStopTimer();
    typingStopTimerRef.current = window.setTimeout(() => {
      const activeChannelId = typingChannelRef.current;
      if (!activeChannelId) {
        return;
      }
      emitTypingState(activeChannelId, false);
      typingChannelRef.current = null;
      typingHeartbeatAtRef.current = 0;
      typingStopTimerRef.current = null;
    }, TYPING_IDLE_MS);
  }, [clearTypingStopTimer, currentChannel?.id, currentChannel?.type, emitTypingState]);

  const insertComposerReference = useCallback((suggestion: MentionSuggestion) => {
    if (!activeComposerReference) {
      return;
    }

    const token =
      suggestion.kind === 'member'
        ? getMemberMentionToken(suggestion.member)
        : getChannelMentionToken(suggestion.channel);
    const nextValue = `${messageText.slice(0, activeComposerReference.start)}${token} ${messageText.slice(
      activeComposerReference.end,
    )}`;
    const nextCaretPosition = activeComposerReference.start + token.length + 1;

    handleComposerInputChange(nextValue, nextCaretPosition);
    window.requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.setSelectionRange(nextCaretPosition, nextCaretPosition);
      setComposerCaretPosition(nextCaretPosition);
    });
  }, [activeComposerReference, handleComposerInputChange, messageText]);

  const insertEmojiIntoComposer = useCallback((emoji: string) => {
    const input = composerInputRef.current;
    if (!input) {
      handleComposerInputChange(`${messageText}${emoji}`);
      return;
    }

    const selectionStart = input.selectionStart ?? input.value.length;
    const selectionEnd = input.selectionEnd ?? input.value.length;
    const nextValue = `${messageText.slice(0, selectionStart)}${emoji}${messageText.slice(selectionEnd)}`;
    const nextCursor = selectionStart + emoji.length;
    handleComposerInputChange(nextValue, nextCursor);

    window.requestAnimationFrame(() => {
      const activeInput = composerInputRef.current;
      if (!activeInput) {
        return;
      }
      activeInput.focus();
      activeInput.setSelectionRange(nextCursor, nextCursor);
    });
  }, [handleComposerInputChange, messageText]);

  const useEmojiFromModal = useCallback((emoji: string) => {
    setEmojiTonePicker(null);
    if (emojiReactionMessageId) {
      handleToggleReaction(emojiReactionMessageId, emoji);
      setIsGifModalOpen(false);
      return;
    }

    insertEmojiIntoComposer(emoji);
  }, [emojiReactionMessageId, handleToggleReaction, insertEmojiIntoComposer]);

  const saveEmojiToneDefault = useCallback((group: EmojiToneGroup, variant: EmojiToneVariant) => {
    setEmojiToneDefaults((previous) => {
      const next = {
        ...previous,
        [group.baseEmoji]: variant.emoji,
      };
      try {
        window.localStorage.setItem(EMOJI_TONE_DEFAULTS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Local storage is optional.
      }
      return next;
    });
  }, []);

  const openEmojiTonePicker = useCallback((group: EmojiToneGroup, clientX: number, clientY: number) => {
    const popoverHalfWidth = Math.min(180, Math.max(120, (window.innerWidth - 24) / 2));
    const x = Math.min(
      Math.max(clientX, popoverHalfWidth + 12),
      Math.max(popoverHalfWidth + 12, window.innerWidth - popoverHalfWidth - 12),
    );
    const y = Math.min(Math.max(clientY, 150), Math.max(150, window.innerHeight - 18));
    setEmojiTonePicker({
      group,
      x,
      y,
    });
  }, []);

  const handleEmojiEntrySelect = useCallback((entry: EmojiEntry) => {
    if (emojiLongPressTriggeredRef.current) {
      emojiLongPressTriggeredRef.current = false;
      return;
    }

    useEmojiFromModal(getPreferredEmojiForEntry(entry, emojiToneIndex, emojiToneDefaults));
  }, [emojiToneDefaults, emojiToneIndex, useEmojiFromModal]);

  const handleEmojiToneSelect = useCallback((group: EmojiToneGroup, variant: EmojiToneVariant) => {
    saveEmojiToneDefault(group, variant);
    useEmojiFromModal(variant.emoji);
  }, [saveEmojiToneDefault, useEmojiFromModal]);

  const handleEmojiToneContextMenu = useCallback((
    event: ReactMouseEvent<HTMLButtonElement>,
    group: EmojiToneGroup | null,
  ) => {
    if (!group) {
      return;
    }

    event.preventDefault();
    openEmojiTonePicker(group, event.clientX, event.clientY);
  }, [openEmojiTonePicker]);

  const handleEmojiLongPressStart = useCallback((
    event: ReactPointerEvent<HTMLButtonElement>,
    group: EmojiToneGroup | null,
  ) => {
    if (!group || event.button !== 0) {
      return;
    }

    clearEmojiLongPressTimer();
    emojiLongPressTriggeredRef.current = false;
    const { clientX, clientY } = event;
    emojiLongPressTimerRef.current = window.setTimeout(() => {
      emojiLongPressTimerRef.current = null;
      emojiLongPressTriggeredRef.current = true;
      openEmojiTonePicker(group, clientX, clientY);
    }, EMOJI_LONG_PRESS_MS);
  }, [clearEmojiLongPressTimer, openEmojiTonePicker]);

  const handleEmojiLongPressEnd = useCallback(() => {
    clearEmojiLongPressTimer();
    if (!emojiLongPressTriggeredRef.current) {
      return;
    }

    window.setTimeout(() => {
      emojiLongPressTriggeredRef.current = false;
    }, 0);
  }, [clearEmojiLongPressTimer]);

  const handleForwardMessage = useCallback((message: Message) => {
    const author = membersById.get(message.authorId);
    const preview = getMessagePreviewText(message, decryptedMessages[message.id], e2eeState);
    const forwardedText = `Forwarded from ${author?.displayName ?? 'Unknown member'}: ${preview}`;
    const nextValue = messageText.trim().length > 0 ? `${messageText}\n${forwardedText}` : forwardedText;
    handleComposerInputChange(nextValue, nextValue.length);
    setReplyDraft(null);
    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
      composerInputRef.current?.setSelectionRange(nextValue.length, nextValue.length);
    });
  }, [decryptedMessages, e2eeState, handleComposerInputChange, membersById, messageText]);

  const handleCopyMessageId = useCallback((message: Message) => {
    void copyToClipboard(message.id, 'Message ID');
  }, [copyToClipboard]);

  const handleCopyMessageText = useCallback((message: Message) => {
    const text = getDisplayMessageContent(message, decryptedMessages[message.id], e2eeState).trim();
    if (!text) {
      actionModal.info({
        title: 'No Text To Copy',
        message: 'This message does not have copyable text.',
      });
      return;
    }
    void copyToClipboard(text, 'Message text');
  }, [actionModal, copyToClipboard, decryptedMessages, e2eeState]);

  const handleEditMessage = useCallback(async (message: Message) => {
    const currentText = getDisplayMessageContent(message, decryptedMessages[message.id], e2eeState);
    const nextText = await actionModal.textInput({
      title: 'Edit Message',
      defaultValue: currentText,
      multiline: true,
      confirmLabel: 'Save',
      required: true,
    });
    if (!nextText || nextText === currentText) {
      return;
    }

    const encryptedContent =
      e2eeState.status === 'ready'
        ? await encryptMessageContent(e2eeState, nextText, {
            channelId: message.channelId,
            authorId: message.authorId,
          })
        : undefined;

    if (!encryptedContent) {
      actionModal.info({
        title: 'Encryption Not Ready',
        message: 'Current is still preparing the shared room key.',
      });
      return;
    }

    const updated = await apiPatch<Message>(`/api/v1/messages/${message.id}`, {
      content: '',
      encryptedContent,
    });
    updateCachedMessage(updated);
  }, [actionModal, decryptedMessages, e2eeState, updateCachedMessage]);

  const handleDeleteMessage = useCallback(async (message: Message) => {
    const confirmed = await actionModal.confirm({
      title: 'Delete Message',
      message: 'Delete this message? This cannot be undone.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) {
      return;
    }

    await apiDelete(`/api/v1/messages/${message.id}`);
    await queryClient.invalidateQueries({ queryKey: ['messages', message.channelId] });
  }, [actionModal, queryClient]);

  const joinVoiceMutation = useMutation({
    mutationFn: async (channelId: string) => {
      if (!channelId) {
        return;
      }
      await voiceClient.join(channelId, {
        muted: selfVoiceState?.muted ?? false,
        deafened: selfVoiceState?.deafened ?? false,
        pushToTalk: selfVoiceState?.pushToTalk ?? true,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['voice-state'] });
    },
  });

  const leaveVoiceMutation = useMutation({
    mutationFn: async () => {
      const channelId = selfVoiceState?.channelId ?? (currentChannel?.type === 'voice' ? currentChannel.id : null);
      if (!channelId) {
        await voiceClient.leave();
        return;
      }
      await voiceClient.leave(channelId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['voice-state'] });
    },
  });

  const patchVoiceStateMutation = useMutation({
    mutationFn: (input: Partial<Pick<VoiceState, 'muted' | 'deafened' | 'pushToTalk' | 'speaking'>>) =>
      apiPatch('/api/v1/voice/state', input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['voice-state'] });
    },
  });

  const updatePresenceMutation = useMutation({
    mutationFn: (status: UserPresenceStatus) =>
      apiPatch<PresencePatchResponse>('/api/v1/presence', { status }),
    onSuccess: (payload) => {
      setSelfPresenceStatus(payload.selfStatus);
      setPresenceByUserId((previous) => ({
        ...previous,
        [payload.presence.userId]: payload.presence,
      }));
    },
  });

  const handleRenameChannel = useCallback(async (channel: Channel) => {
    const isCategory = channel.type === 'category';
    const nextName = await actionModal.textInput({
      title: isCategory ? 'Edit Category' : 'Edit Channel',
      message: `Rename ${isCategory ? channel.name : `${getChannelLabelPrefix(channel)}${channel.name}`}.`,
      defaultValue: channel.name,
      placeholder: isCategory ? 'category-name' : 'channel-name',
      required: true,
      confirmLabel: 'Save',
    });
    if (!nextName || nextName === channel.name) {
      return;
    }

    await apiPatch(`/api/v1/channels/${channel.id}`, {
      name: nextName,
    });
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
  }, [actionModal, queryClient]);

  const handleDeleteChannel = useCallback(async (channel: Channel) => {
    const isCategory = channel.type === 'category';
    const confirmed = await actionModal.confirm({
      title: isCategory ? 'Delete Category' : 'Delete Channel',
      message: isCategory
        ? `Delete ${channel.name}? Channels inside it will stay in the server.`
        : `Delete ${getChannelLabelPrefix(channel)}${channel.name}? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!confirmed) {
      return;
    }

    await apiDelete(`/api/v1/channels/${channel.id}`);
    if (selectedChannelId === channel.id) {
      setSelectedChannelId(null);
    }
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
    await queryClient.invalidateQueries({ queryKey: ['messages'] });
    await queryClient.invalidateQueries({ queryKey: ['voice-state'] });
  }, [actionModal, queryClient, selectedChannelId]);

  const handleToggleChannelLock = useCallback(async (channel: Channel) => {
    if (channel.type === 'category') {
      return;
    }
    await apiPatch(`/api/v1/channels/${channel.id}/moderation`, {
      locked: !channel.locked,
      slowmodeSeconds: channel.slowmodeSeconds,
    });
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
  }, [queryClient]);

  const handleCreateChannel = useCallback(async () => {
    const channelName = await actionModal.textInput({
      title: 'Create Channel',
      message: 'Create a new text channel.',
      defaultValue: `text-${Math.floor(Math.random() * 1000)}`,
      placeholder: 'channel-name',
      required: true,
      confirmLabel: 'Create',
    });
    if (!channelName) {
      return;
    }

    await apiPost('/api/v1/channels', {
      name: channelName,
      type: 'text',
    });
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
  }, [actionModal, queryClient]);

  const handleCreateCategory = useCallback(async () => {
    const categoryName = await actionModal.textInput({
      title: 'Create Category',
      message: 'Create a new channel category.',
      defaultValue: 'New Category',
      placeholder: 'category-name',
      required: true,
      confirmLabel: 'Create',
    });
    if (!categoryName) {
      return;
    }

    await apiPost('/api/v1/channels', {
      name: categoryName,
      type: 'category',
    });
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
  }, [actionModal, queryClient]);

  const persistChannelDrop = useCallback(async (
    draggedChannelId: string,
    targetChannelId: string,
    edge: 'before' | 'after',
  ) => {
    if (!canManageChannels || draggedChannelId === targetChannelId) {
      return;
    }

    const draggedItem = channelListItems.find((item) => item.channel.id === draggedChannelId);
    if (!draggedItem) {
      return;
    }

    const movingIds = new Set<string>([draggedChannelId]);
    if (draggedItem.channel.type === 'category') {
      for (const item of channelListItems) {
        if (item.channel.categoryId === draggedChannelId) {
          movingIds.add(item.channel.id);
        }
      }
    }
    if (movingIds.has(targetChannelId)) {
      return;
    }

    const movingItems = channelListItems.filter((item) => movingIds.has(item.channel.id));
    const remainingItems = channelListItems.filter((item) => !movingIds.has(item.channel.id));
    const targetIndex = remainingItems.findIndex((item) => item.channel.id === targetChannelId);
    if (targetIndex < 0) {
      return;
    }

    const nextItems = [...remainingItems];
    nextItems.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, ...movingItems);

    let activeCategoryId: string | null = null;
    const items = nextItems.map((item, index) => {
      const position = (index + 1) * 1000;
      if (item.channel.type === 'category') {
        activeCategoryId = item.channel.id;
        return {
          id: item.channel.id,
          categoryId: null,
          position,
        };
      }

      const moved = movingIds.has(item.channel.id);
      return {
        id: item.channel.id,
        categoryId: item.nested || moved ? activeCategoryId : item.channel.categoryId ?? null,
        position,
      };
    });

    await apiPut<{ items: Channel[] }>('/api/v1/channels/order', { items });
    await queryClient.invalidateQueries({ queryKey: ['channels'] });
  }, [canManageChannels, channelListItems, queryClient]);

  const handleChannelDragStart = useCallback((event: ReactDragEvent, channel: Channel) => {
    if (!canManageChannels) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', channel.id);
    setDraggingChannelId(channel.id);
  }, [canManageChannels]);

  const handleChannelDragOver = useCallback((event: ReactDragEvent<HTMLElement>, channel: Channel) => {
    if (!canManageChannels || !draggingChannelId || draggingChannelId === channel.id) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY > bounds.top + bounds.height / 2 ? 'after' : 'before';
    setChannelDropTarget((previous) => (
      previous?.channelId === channel.id && previous.edge === edge
        ? previous
        : { channelId: channel.id, edge }
    ));
  }, [canManageChannels, draggingChannelId]);

  const handleChannelDrop = useCallback((event: ReactDragEvent<HTMLElement>, channel: Channel) => {
    event.preventDefault();
    const draggedChannelId = draggingChannelId ?? event.dataTransfer.getData('text/plain');
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = channelDropTarget?.channelId === channel.id
      ? channelDropTarget.edge
      : event.clientY > bounds.top + bounds.height / 2 ? 'after' : 'before';
    setDraggingChannelId(null);
    setChannelDropTarget(null);
    if (!draggedChannelId) {
      return;
    }
    void persistChannelDrop(draggedChannelId, channel.id, edge);
  }, [channelDropTarget?.channelId, channelDropTarget?.edge, draggingChannelId, persistChannelDrop]);

  const handleChannelDragEnd = useCallback(() => {
    setDraggingChannelId(null);
    setChannelDropTarget(null);
  }, []);

  const handleCreateInvite = useCallback(async () => {
    const invite = await apiPost<{ code: string }>('/api/v1/invites', {});
    await copyToClipboard(invite.code, 'Invite code');
  }, [copyToClipboard]);

  const handleMemberAction = useCallback(async (
    memberId: string,
    type: 'ban' | 'mute' | 'timeout' | 'kick' | 'warn',
    displayName: string,
  ) => {
    const label = type === 'timeout' ? 'Timeout' : `${type.slice(0, 1).toUpperCase()}${type.slice(1)}`;
    const result = await actionModal.moderation({
      title: `${label} ${displayName}`,
      message: `This moderation action will be recorded in the server log.`,
      defaultReason: `${label} by admin`,
      defaultTimeoutMinutes: 10,
      includeTimeout: type === 'timeout',
      confirmLabel: label,
      variant: type === 'ban' || type === 'kick' ? 'danger' : 'normal',
    });
    if (!result) {
      return;
    }

    const expiresAt =
      type === 'timeout' && result.timeoutMinutes
        ? new Date(Date.now() + result.timeoutMinutes * 60_000).toISOString()
        : undefined;

    await apiPost('/api/v1/moderation/actions', {
      targetUserId: memberId,
      type,
      reason: result.reason,
      expiresAt,
    });
    await queryClient.invalidateQueries({ queryKey: ['members'] });
    await queryClient.invalidateQueries({ queryKey: ['voice-state'] });
  }, [actionModal, queryClient]);

  const connectedVoiceChannelId = selfVoiceState?.channelId ?? null;
  const selfVoiceInputDisabled = Boolean(
    !selfVoiceState ||
    selfVoiceState.muted ||
    selfVoiceState.deafened ||
    (selfVoiceState.pushToTalk && !pushToTalkHeld),
  );
  const selectedVoiceSpeakerCount = selectedVoiceParticipants.filter((voiceState) => voiceState.speaking).length;
  const selectedVoiceMutedCount = selectedVoiceParticipants.filter((voiceState) => voiceState.muted || voiceState.deafened).length;
  const isViewingConnectedVoiceChannel = Boolean(
    currentChannel?.type === 'voice' && connectedVoiceChannelId === currentChannel.id,
  );
  const selectedVoiceInitial =
    currentChannel?.type === 'voice' && currentChannel.name.trim().length > 0
      ? currentChannel.name.trim().slice(0, 1).toUpperCase()
      : 'V';
  const selectedVoiceParticipantSizeClass =
    selectedVoiceParticipants.length <= 1
      ? 'voice-room-list-solo'
      : selectedVoiceParticipants.length <= 2
        ? 'voice-room-list-duo'
        : selectedVoiceParticipants.length <= 4
          ? 'voice-room-list-small'
          : selectedVoiceParticipants.length <= 9
            ? 'voice-room-list-medium'
            : 'voice-room-list-dense';

  const handleSelectChannel = useCallback((channel: Channel) => {
    if (channel.type === 'category') {
      return;
    }
    setSelectedChannelId(channel.id);
    if (channel.type !== 'voice') {
      return;
    }
    if (connectedVoiceChannelId === channel.id || joinVoiceMutation.isPending) {
      return;
    }
    joinVoiceMutation.mutate(channel.id);
  }, [connectedVoiceChannelId, joinVoiceMutation]);

  const updateVoiceState = useCallback((input: Partial<Pick<VoiceState, 'muted' | 'deafened' | 'pushToTalk' | 'speaking'>>) => {
    if (!selfVoiceState) {
      return;
    }
    patchVoiceStateMutation.mutate(input);
  }, [patchVoiceStateMutation, selfVoiceState]);

  const setSpeakingState = useCallback((speaking: boolean) => {
    if (!selfVoiceState || !selfVoiceState.pushToTalk) {
      return;
    }
    if (speaking && (selfVoiceState.deafened || selfVoiceState.muted)) {
      return;
    }
    setPushToTalkHeld(speaking);
    voiceClient.setInputEnabled(speaking);
  }, [selfVoiceState, voiceClient.setInputEnabled]);

  useEffect(() => {
    const inputEnabled = Boolean(
      selfVoiceState &&
      !selfVoiceState.muted &&
      !selfVoiceState.deafened &&
      (!selfVoiceState.pushToTalk || pushToTalkHeld),
    );
    voiceClient.setInputEnabled(inputEnabled);
    if (!selfVoiceState?.pushToTalk && pushToTalkHeld) {
      setPushToTalkHeld(false);
    }
  }, [
    pushToTalkHeld,
    selfVoiceState?.deafened,
    selfVoiceState?.muted,
    selfVoiceState?.pushToTalk,
    voiceClient.setInputEnabled,
  ]);

  const ensureMessageLoadedForJump = useCallback(async (channelId: string, messageId: string) => {
    const queryKey = ['messages', channelId] as const;

    const hasMessage = () => {
      const cached = queryClient.getQueryData<InfiniteData<PageResponse<Message>>>(queryKey);
      if (!cached) {
        return false;
      }
      return cached.pages.some((page) => page.items.some((item) => item.id === messageId));
    };

    if (hasMessage()) {
      return true;
    }

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const cached = queryClient.getQueryData<InfiniteData<PageResponse<Message>>>(queryKey);
      const oldestLoadedPage = cached?.pages[cached.pages.length - 1];
      const hasMoreHistory = Boolean(oldestLoadedPage?.pageInfo.hasMore && oldestLoadedPage.pageInfo.nextCursor);
      if (!hasMoreHistory) {
        break;
      }

      try {
        await messagesQuery.fetchNextPage();
      } catch {
        break;
      }

      if (hasMessage()) {
        return true;
      }
    }

    return hasMessage();
  }, [messagesQuery, queryClient]);

  const scrollToMessageNode = useCallback((messageId: string) => {
    return new Promise<boolean>((resolve) => {
      let attempts = 0;
      const tryScroll = () => {
        const target = document.getElementById(`message-item-${messageId}`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setHighlightedMessageId(messageId);
          window.setTimeout(() => {
            setHighlightedMessageId((previous) => (previous === messageId ? null : previous));
          }, 2_600);
          resolve(true);
          return;
        }

        if (attempts >= 24) {
          resolve(false);
          return;
        }

        attempts += 1;
        window.setTimeout(tryScroll, 55);
      };

      tryScroll();
    });
  }, []);

  const handleReplyToMessage = useCallback((message: Message) => {
    setReplyDraft({
      channelId: message.channelId,
      messageId: message.id,
    });
    window.requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });
  }, []);

  const handleReplyPreviewClick = useCallback((messageId: string) => {
    if (!currentChannel?.id) {
      return;
    }

    setPendingJumpMessage({
      channelId: currentChannel.id,
      messageId,
    });
  }, [currentChannel?.id]);

  useEffect(() => {
    if (!pendingJumpMessage) {
      return;
    }
    if (!currentChannel?.id || !isMessageChannel(currentChannel)) {
      return;
    }
    if (currentChannel.id !== pendingJumpMessage.channelId) {
      return;
    }

    let cancelled = false;

    const runJump = async () => {
      const available = await ensureMessageLoadedForJump(
        pendingJumpMessage.channelId,
        pendingJumpMessage.messageId,
      );
      if (cancelled) {
        return;
      }
      if (!available) {
        actionModal.info({
          title: 'Message Not Found',
          message: 'Could not locate that message in this channel history.',
        });
        setPendingJumpMessage(null);
        return;
      }

      const scrolled = await scrollToMessageNode(pendingJumpMessage.messageId);
      if (!cancelled && !scrolled) {
        actionModal.info({
          title: 'Jump Target Missing',
          message: 'Message loaded, but the jump target was not found in the viewport yet.',
        });
      }
      if (!cancelled) {
        setPendingJumpMessage(null);
      }
    };

    void runJump();

    return () => {
      cancelled = true;
    };
  }, [
    actionModal.info,
    currentChannel?.id,
    currentChannel?.type,
    ensureMessageLoadedForJump,
    pendingJumpMessage,
    scrollToMessageNode,
  ]);

  const ensureMemberLoadedForJump = useCallback(async (memberId: string) => {
    const hasMember = () => {
      if (membersById.has(memberId)) {
        return true;
      }
      const loaded = queryClient.getQueryData<InfiniteData<PageResponse<MemberPayload>>>(['members']);
      return Boolean(loaded?.pages.some((page) => page.items.some((item) => item.id === memberId)));
    };

    if (hasMember()) {
      return true;
    }

    for (let attempt = 0; attempt < 32; attempt += 1) {
      const loaded = queryClient.getQueryData<InfiniteData<PageResponse<MemberPayload>>>(['members']);
      const lastPage = loaded?.pages[loaded.pages.length - 1];
      const hasMore = Boolean(lastPage?.pageInfo.hasMore && lastPage.pageInfo.nextCursor);
      if (!hasMore) {
        break;
      }

      try {
        await membersQuery.fetchNextPage();
      } catch {
        break;
      }

      if (hasMember()) {
        return true;
      }
    }

    return hasMember();
  }, [membersById, membersQuery, queryClient]);

  const scrollToMemberNode = useCallback((memberId: string) => {
    return new Promise<boolean>((resolve) => {
      let attempts = 0;
      const tryScroll = () => {
        const target = document.getElementById(`member-item-${memberId}`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setHighlightedMemberId(memberId);
          window.setTimeout(() => {
            setHighlightedMemberId((previous) => (previous === memberId ? null : previous));
          }, 2_400);
          resolve(true);
          return;
        }

        if (attempts >= 24) {
          resolve(false);
          return;
        }

        attempts += 1;
        window.setTimeout(tryScroll, 55);
      };

      tryScroll();
    });
  }, []);

  const handleMessageSearchSelect = useCallback((message: Message) => {
    setIsSearchModalOpen(false);
    setSelectedChannelId(message.channelId);
    setPendingJumpMessage({
      channelId: message.channelId,
      messageId: message.id,
    });
  }, []);

  const handleUserSearchSelect = useCallback(async (memberId: string) => {
    setIsSearchModalOpen(false);

    const available = await ensureMemberLoadedForJump(memberId);
    if (!available) {
      actionModal.info({
        title: 'Member Not Found',
        message: 'Could not locate that member in the visible member roster.',
      });
      return;
    }

    const scrolled = await scrollToMemberNode(memberId);
    if (!scrolled) {
      actionModal.info({
        title: 'Highlight Target Missing',
        message: 'Member located, but the highlight target was not found.',
      });
    }
  }, [actionModal.info, ensureMemberLoadedForJump, scrollToMemberNode]);

  const handleCopyE2eeKey = useCallback(() => {
    if (e2eeState.status !== 'ready') {
      return;
    }

    const copy = navigator.clipboard?.writeText(e2eeState.exportedKey);
    if (!copy) {
      window.prompt('E2EE room key', e2eeState.exportedKey);
      return;
    }

    void copy.catch(() => {
      window.prompt('E2EE room key', e2eeState.exportedKey);
    });
  }, [e2eeState]);

  const handleImportE2eeKey = useCallback(() => {
    const serverId = setupQuery.data?.serverId;
    if (!serverId) {
      return;
    }

    const value = window.prompt('Paste E2EE room key');
    if (!value?.trim()) {
      return;
    }

    void importE2eeKey(serverId, value)
      .then((state) => {
        setE2eeState(state);
        setDecryptedMessages({});
        void queryClient.invalidateQueries({ queryKey: ['messages'] });
      })
      .catch((error) => {
        actionModal.info({
          title: 'Invalid E2EE Key',
          message: error instanceof Error ? error.message : 'Invalid E2EE key.',
        });
      });
  }, [actionModal.info, queryClient, setupQuery.data?.serverId]);

  const handleSetupConfigured = useCallback(async (result: SetupBootstrapResponse, initialPresenceStatus: UserPresenceStatus) => {
    const currentUser = sessionQuery.data?.user;
    setSelectedChannelId(result.defaultChannelId ?? null);
    setMessageText('');
    setAttachmentIds([]);
    setReplyDraft(null);
    setTypingByChannel({});
    setSelfPresenceStatus(initialPresenceStatus);
    setPresenceByUserId(
      currentUser
        ? {
            [currentUser.id]: {
              userId: currentUser.id,
              status: initialPresenceStatus,
              connected: true,
            },
          }
        : {},
    );

    for (const queryKey of [
      ['channels'],
      ['messages'],
      ['members'],
      ['roles'],
      ['presence'],
      ['voice-state'],
      ['admin-settings'],
    ]) {
      queryClient.removeQueries({ queryKey });
    }

    await Promise.all([setupQuery.refetch(), sessionQuery.refetch()]);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['channels'] }),
      queryClient.invalidateQueries({ queryKey: ['members'] }),
      queryClient.invalidateQueries({ queryKey: ['roles'] }),
      queryClient.invalidateQueries({ queryKey: ['presence'] }),
      queryClient.invalidateQueries({ queryKey: ['voice-state'] }),
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] }),
    ]);
  }, [queryClient, sessionQuery, setupQuery]);

  if (setupQuery.isLoading || isExchangingAuth) {
    return <div className="loading-screen">Booting Current…</div>;
  }

  if (!setupQuery.data?.configured) {
    if (sessionQuery.isLoading) {
      return <div className="loading-screen">Booting Current…</div>;
    }

    if (!sessionQuery.data?.user) {
      return (
        <AuthScreen
          authMode={setupQuery.data?.authMode ?? 'atproto'}
          title="Sign In To Create Your Server"
          subtitle="Current assigns owner/admin permissions to the account that creates the server."
        />
      );
    }

    return (
      <SetupWizard
        owner={sessionQuery.data.user}
        authMode={setupQuery.data?.authMode ?? 'atproto'}
        onConfigured={handleSetupConfigured}
      />
    );
  }

  if (sessionQuery.isError || !sessionQuery.data?.user) {
    return <AuthScreen authMode={setupQuery.data?.authMode ?? 'atproto'} />;
  }

  const currentUser = sessionQuery.data.user;
  const selfPresence =
    presenceByUserId[currentUser.id] ?? {
      userId: currentUser.id,
      status: selfPresenceStatus,
      connected: true,
    };
  const onlineMemberCount = visibleMemberList.filter((member) =>
    isVisibleOnlinePresence(
      presenceByUserId[member.id] ?? {
        userId: member.id,
        status: 'offline',
        connected: false,
      },
    ),
  ).length;
  const replyDraftMessage = replyDraft ? messagesById.get(replyDraft.messageId) ?? null : null;
  const replyDraftAuthor = replyDraftMessage ? membersById.get(replyDraftMessage.authorId) : null;
  const replyDraftPreview = replyDraftMessage
    ? getMessagePreviewText(replyDraftMessage, decryptedMessages[replyDraftMessage.id], e2eeState)
    : 'Message';
  const hasComposerText = messageText.trim().length > 0;
  const canSendMessage =
    Boolean(currentChannel?.id) &&
    isMessageChannel(currentChannel) &&
    (hasComposerText || attachmentIds.length > 0) &&
    (!hasComposerText || e2eeState.status === 'ready');
  const isReactionEmojiModal = Boolean(emojiReactionMessageId);
  const isEmojiCatalogLoading =
    isGifModalOpen && (isReactionEmojiModal || gifTab === 'emoji') && emojiCatalog.length === 0;

  const runMenuAction = (task: () => Promise<void> | void) => {
    return async () => {
      try {
        await task();
      } catch (error) {
        actionModal.info({
          title: 'Action Failed',
          message: error instanceof Error ? error.message : 'The action could not be completed.',
        });
      }
    };
  };

  const contextMenuSections = (context: AppContextMenu): ContextMenuSection<AppContextMenu>[] => {
    if (context.kind === 'server') {
      return [
        {
          id: 'server-primary',
          title: 'Server',
          items: [
            {
              id: 'server-settings',
              label: 'Server Settings',
              icon: '⚙',
              disabled: !canOpenServerSettings,
              disabledReason: 'Owner or administrator only.',
              run: runMenuAction(() => setIsServerSettingsOpen(true)),
            },
            {
              id: 'create-channel',
              label: 'Create Channel',
              icon: '+',
              disabled: !canManageChannels,
              disabledReason: 'Need MANAGE_CHANNELS permission.',
              run: runMenuAction(handleCreateChannel),
            },
            {
              id: 'create-category',
              label: 'Create Category',
              icon: '▾',
              disabled: !canManageChannels,
              disabledReason: 'Need MANAGE_CHANNELS permission.',
              run: runMenuAction(handleCreateCategory),
            },
            {
              id: 'create-invite',
              label: 'Create Invite',
              icon: '✉',
              disabled: !canManageServer,
              disabledReason: 'Need MANAGE_SERVER permission.',
              run: runMenuAction(handleCreateInvite),
            },
          ],
        },
        {
          id: 'server-copy',
          title: 'Copy',
          items: [
            {
              id: 'copy-server-id',
              label: 'Copy Server ID',
              icon: '#',
              run: runMenuAction(() => copyToClipboard(setupQuery.data?.serverId ?? 'unknown-server', 'Server ID')),
            },
          ],
        },
      ];
    }

    if (context.kind === 'channel') {
      const channel = context.channel;
      const connectedHere = connectedVoiceChannelId === channel.id;
      const isCategory = channel.type === 'category';
      return [
        {
          id: 'channel-primary',
          title: 'Channel',
          items: [
            {
              id: 'join-voice',
              label: connectedHere ? 'Disconnect' : 'Join Voice',
              icon: connectedHere ? '⏏' : '◉',
              hidden: channel.type !== 'voice',
              run: runMenuAction(() => {
                if (connectedHere) {
                  leaveVoiceMutation.mutate();
                  return;
                }
                joinVoiceMutation.mutate(channel.id);
              }),
            },
            {
              id: 'copy-channel-mention',
              label: 'Copy Channel Mention',
              icon: '#',
              hidden: !isMessageChannel(channel),
              run: runMenuAction(() => copyToClipboard(getChannelMentionToken(channel), 'Channel mention')),
            },
            {
              id: 'copy-channel-id',
              label: 'Copy Channel ID',
              icon: '⌘',
              run: runMenuAction(() => copyToClipboard(channel.id, 'Channel ID')),
            },
          ],
        },
        {
          id: 'channel-manage',
          title: 'Manage',
          items: [
            {
              id: 'edit-channel',
              label: isCategory ? 'Edit Category' : 'Edit Channel',
              icon: '✎',
              disabled: !canManageChannels,
              disabledReason: 'Need MANAGE_CHANNELS permission.',
              run: runMenuAction(() => handleRenameChannel(channel)),
            },
            {
              id: 'toggle-lock',
              label: channel.locked ? 'Unlock Channel' : 'Lock Channel',
              icon: channel.locked ? '□' : '■',
              hidden: isCategory,
              disabled: !canManageChannels,
              disabledReason: 'Need MANAGE_CHANNELS permission.',
              run: runMenuAction(() => handleToggleChannelLock(channel)),
            },
            {
              id: 'delete-channel',
              label: isCategory ? 'Delete Category' : 'Delete Channel',
              icon: '×',
              variant: 'danger',
              disabled: !canManageChannels,
              disabledReason: 'Need MANAGE_CHANNELS permission.',
              run: runMenuAction(() => handleDeleteChannel(channel)),
            },
          ],
        },
      ];
    }

    if (context.kind === 'member') {
      const member = context.member;
      const isSelf = member.id === currentUser.id;
      const mention = getMemberMentionToken(member);
      return [
        {
          id: 'member-primary',
          title: 'Member',
          items: [
            {
              id: 'mention-member',
              label: 'Mention',
              icon: '@',
              run: runMenuAction(() => {
                const nextValue = messageText.trim().length > 0 ? `${messageText} ${mention} ` : `${mention} `;
                handleComposerInputChange(nextValue, nextValue.length);
                composerInputRef.current?.focus();
              }),
            },
            {
              id: 'copy-handle',
              label: 'Copy Handle',
              icon: '@',
              run: runMenuAction(() => copyToClipboard(formatIdentityHandle(member), 'Handle')),
            },
            {
              id: 'copy-user-id',
              label: 'Copy User ID',
              icon: '#',
              run: runMenuAction(() => copyToClipboard(member.id, 'User ID')),
            },
            {
              id: 'manage-roles',
              label: 'Manage Roles',
              icon: '◆',
              disabled: !canManageServer,
              disabledReason: 'Need MANAGE_SERVER permission.',
              run: runMenuAction(() => setIsServerSettingsOpen(true)),
            },
          ],
        },
        {
          id: 'member-moderation',
          title: 'Moderation',
          items: [
            {
              id: 'moderation',
              label: 'Moderation',
              icon: '!',
              disabled: !canModerateMembers || isSelf,
              disabledReason: isSelf ? 'You cannot moderate yourself.' : 'Need MODERATE_MEMBERS permission.',
              children: [
                {
                  id: 'warn-user',
                  label: 'Warn',
                  icon: '!',
                  run: runMenuAction(() => handleMemberAction(member.id, 'warn', member.displayName)),
                },
                {
                  id: 'timeout-user',
                  label: 'Timeout',
                  icon: '◷',
                  run: runMenuAction(() => handleMemberAction(member.id, 'timeout', member.displayName)),
                },
                {
                  id: 'mute-user',
                  label: 'Mute',
                  icon: '◇',
                  run: runMenuAction(() => handleMemberAction(member.id, 'mute', member.displayName)),
                },
                {
                  id: 'kick-user',
                  label: 'Kick',
                  icon: '↗',
                  variant: 'danger',
                  run: runMenuAction(() => handleMemberAction(member.id, 'kick', member.displayName)),
                },
                {
                  id: 'ban-user',
                  label: 'Ban',
                  icon: '×',
                  variant: 'danger',
                  run: runMenuAction(() => handleMemberAction(member.id, 'ban', member.displayName)),
                },
              ],
            },
          ],
        },
      ];
    }

    const message = context.message;
    const author = membersById.get(message.authorId);
    const isOwnMessage = message.authorId === currentUser.id;
    const canDeleteMessage = isOwnMessage || canManageMessages;
    const textReady = !message.encryptedContent || decryptedMessages[message.id]?.status === 'ready';
    return [
      {
        id: 'message-primary',
        title: 'Message',
        items: [
          {
            id: 'add-reaction',
            label: 'Add Reaction',
            icon: '😊',
            run: runMenuAction(() => {
              setEmojiReactionMessageId(message.id);
              setEmojiSearchInput('');
              setGifTab('emoji');
              setIsGifModalOpen(true);
            }),
          },
          {
            id: 'reply',
            label: 'Reply',
            icon: '↩',
            run: runMenuAction(() => handleReplyToMessage(message)),
          },
          {
            id: 'forward',
            label: 'Forward',
            icon: '↪',
            run: runMenuAction(() => handleForwardMessage(message)),
          },
          {
            id: 'edit-message',
            label: 'Edit Message',
            icon: '✎',
            hidden: !isOwnMessage,
            disabled: !textReady,
            disabledReason: 'Message text is not available yet.',
            run: runMenuAction(() => handleEditMessage(message)),
          },
          {
            id: 'delete-message',
            label: 'Delete Message',
            icon: '×',
            variant: 'danger',
            disabled: !canDeleteMessage,
            disabledReason: 'Need MANAGE_MESSAGES permission.',
            run: runMenuAction(() => handleDeleteMessage(message)),
          },
        ],
      },
      {
        id: 'message-copy',
        title: 'Copy',
        items: [
          {
            id: 'copy-message-text',
            label: 'Copy Text',
            icon: '⧉',
            disabled: !textReady,
            disabledReason: 'Message text is not available yet.',
            run: runMenuAction(() => handleCopyMessageText(message)),
          },
          {
            id: 'copy-message-id',
            label: 'Copy Message ID',
            icon: '#',
            run: runMenuAction(() => handleCopyMessageId(message)),
          },
          {
            id: 'copy-author-handle',
            label: 'Copy Author Handle',
            icon: '@',
            hidden: !author,
            run: runMenuAction(() => {
              if (author) {
                return copyToClipboard(formatIdentityHandle(author), 'Author handle');
              }
            }),
          },
        ],
      },
    ];
  };

  const shellAppearance = appearancePreview ?? sessionQuery.data?.server.appearance;

  return (
    <div
      className={`shell ${isOverLightBackground ? 'over-light-background' : ''} ${isResizingChannelsPane ? 'resizing-channels' : ''} ${isResizingMembersPane ? 'resizing-members' : ''}`}
      data-appearance-mode={appearanceMode}
      data-resolved-appearance={resolvedAppearanceMode}
      style={{
        '--channels-pane-width': `${channelsPaneWidth}px`,
        '--members-pane-width': `${membersPaneWidth}px`,
        ...buildAppearanceStyle(shellAppearance, resolvedAppearanceMode),
      } as CSSProperties}
    >
      {appearanceTransition && (
        <div
          key={appearanceTransition.id}
          className={`appearance-transition-overlay from-${appearanceTransition.from} to-${appearanceTransition.to}`}
          aria-hidden="true"
        />
      )}
      <div className="voice-audio-sinks" aria-hidden="true">
        {voiceClient.remoteStreams.map((remote) => (
          <RemoteVoiceAudio
            key={remote.producerId}
            remote={remote}
            muted={selfVoiceState?.deafened ?? false}
          />
        ))}
      </div>
      <aside className="channels-pane glass-panel" ref={channelsPaneRef}>
        <header>
          <h2>Channels</h2>
          <div className="channels-header-actions">
            {canOpenServerSettings && (
              <button
                aria-label="Server settings"
                title="Server settings"
                onClick={() => setIsServerSettingsOpen(true)}
              >
                ⚙
              </button>
            )}
            <button
              aria-label="Create channel"
              title="Create channel"
              disabled={!canManageChannels}
              onClick={() => {
                if (!canManageChannels) {
                  return;
                }
                void handleCreateChannel();
              }}
            >
              +
            </button>
          </div>
        </header>

        <div className="channel-list" ref={channelsListRef} onScroll={handleChannelListScroll}>
          {channelListItems.map((item) => {
            const channel = item.channel;
            const isCategory = item.kind === 'category';
            const channelVoiceStates = channel.type === 'voice' ? voiceStatesByChannelId.get(channel.id) ?? [] : [];
            const connectedHere = connectedVoiceChannelId === channel.id;
            const showVoiceRoster = channel.type === 'voice' && (currentChannel?.id === channel.id || connectedHere);
            const dropClassName = channelDropTarget?.channelId === channel.id
              ? `drop-${channelDropTarget.edge}`
              : '';
            const entryClassName = [
              'channel-entry',
              item.nested ? 'nested' : '',
              draggingChannelId === channel.id ? 'dragging' : '',
              dropClassName,
            ].filter(Boolean).join(' ');
            const menuContext: AppContextMenu = {
              kind: 'channel',
              channel,
            };

            if (isCategory) {
              return (
                <div
                  key={channel.id}
                  className={entryClassName}
                  onDragOver={(event) => handleChannelDragOver(event, channel)}
                  onDrop={(event) => handleChannelDrop(event, channel)}
                >
                  <button
                    type="button"
                    className="channel-category"
                    draggable={canManageChannels}
                    aria-grabbed={draggingChannelId === channel.id}
                    onDragStart={(event) => handleChannelDragStart(event, channel)}
                    onDragEnd={handleChannelDragEnd}
                    onContextMenu={(event) => {
                      contextMenu.open(event, menuContext, contextMenuSections(menuContext));
                    }}
                  >
                    <span className="channel-category-caret">▾</span>
                    <span className="channel-label">{channel.name}</span>
                  </button>
                </div>
              );
            }

            return (
              <div
                key={channel.id}
                className={entryClassName}
                onDragOver={(event) => handleChannelDragOver(event, channel)}
                onDrop={(event) => handleChannelDrop(event, channel)}
              >
                <button
                  type="button"
                  className={`channel-item ${currentChannel?.id === channel.id ? 'active' : ''}`}
                  draggable={canManageChannels}
                  aria-grabbed={draggingChannelId === channel.id}
                  onClick={() => handleSelectChannel(channel)}
                  onDragStart={(event) => handleChannelDragStart(event, channel)}
                  onDragEnd={handleChannelDragEnd}
                  onContextMenu={(event) => {
                    contextMenu.open(event, menuContext, contextMenuSections(menuContext));
                  }}
                >
                  <span className="channel-leading">{getChannelLabelPrefix(channel)}</span>
                  <span className="channel-label">{channel.name}</span>
                  {channel.type === 'voice' && channelVoiceStates.length > 0 && (
                    <span className="channel-voice-count">{channelVoiceStates.length}</span>
                  )}
                  {connectedHere && <span className="channel-live-indicator" aria-hidden />}
                </button>
                {showVoiceRoster && channelVoiceStates.length > 0 && (
                  <ul className="voice-channel-roster">
                    {channelVoiceStates.map((voiceState) => {
                      const participant = membersById.get(voiceState.userId);
                      const participantName = participant?.displayName ?? voiceState.userId;
                      return (
                        <li
                          key={voiceState.userId}
                          className={`voice-channel-member ${voiceState.speaking ? 'speaking' : ''}`}
                        >
                          <Avatar src={participant?.avatarUrl} name={participantName} size="sm" />
                          <span className="voice-channel-member-name">{participantName}</span>
                          {voiceState.userId === currentUser.id && (
                            <VoiceMicMeter
                              level={voiceClient.inputLevel}
                              disabled={selfVoiceInputDisabled}
                              compact
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
          {channelsQuery.isFetchingNextPage && <small className="list-loading">Loading channels…</small>}
        </div>

        <section
          ref={profileGlassRef}
          className={`voice-box glass-panel profile-glass-panel ${selfVoiceState ? 'connected' : ''}`}
        >
          <div className="voice-user">
            <Avatar src={currentUser.avatarUrl} name={currentUser.displayName} size="md" />
            <div>
              <strong>{currentUser.displayName}</strong>
              <small>{formatIdentityHandle(currentUser)}</small>
            </div>
          </div>

          <div
            ref={presenceMenuRef}
            className={`presence-control presence-select ${isPresenceMenuOpen ? 'open' : ''}`}
          >
            <span className={`presence-dot ${getPresenceClassName(selfPresence.status)}`} />
            <button
              className="presence-select-trigger"
              type="button"
              disabled={updatePresenceMutation.isPending}
              title="Set status"
              aria-haspopup="listbox"
              aria-expanded={isPresenceMenuOpen}
              onClick={() => setIsPresenceMenuOpen((open) => !open)}
            >
              <span>{getPresenceLabel(selfPresence.status)}</span>
              <span className="presence-select-chevron" aria-hidden="true">⌄</span>
            </button>
            {isPresenceMenuOpen && (
              <div
                className={`presence-select-menu liquid-surface ${isOverLightBackground ? 'over-light-background' : ''}`}
                role="listbox"
                aria-label="Set status"
              >
                <LiquidGlassBackdrop
                  className="menu-liquid-glass"
                  cornerRadius={12}
                  displacementScale={128}
                  blurAmount={0.18}
                  saturation={145}
                  aberrationIntensity={2}
                  elasticity={0.04}
                  mode="prominent"
                  mouseContainer={presenceMenuRef}
                  overLight={isOverLightBackground}
                />
                {PRESENCE_STATUS_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className="presence-select-option"
                    type="button"
                    role="option"
                    aria-selected={option.value === selfPresenceStatus}
                    onClick={() => {
                      setIsPresenceMenuOpen(false);
                      if (option.value !== selfPresenceStatus) {
                        updatePresenceMutation.mutate(option.value);
                      }
                    }}
                  >
                    <span className={`presence-dot ${getPresenceClassName(option.value)}`} />
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            className="logout-button"
            onClick={() => {
              void apiPost('/api/v1/auth/logout').then(() => window.location.reload());
            }}
          >
            Log out
          </button>

          {!selfVoiceState && voiceClient.status !== 'idle' && (
            <div className={`voice-status voice-status-${voiceClient.status}`}>
              {voiceClient.status === 'requesting_microphone' && 'Requesting microphone'}
              {voiceClient.status === 'connecting' && 'Connecting voice'}
              {voiceClient.status === 'reconnecting' && 'Recovering voice'}
              {voiceClient.status === 'permission_denied' && 'Microphone blocked'}
              {voiceClient.status === 'insecure_origin' && 'HTTPS required for browser voice'}
              {voiceClient.status === 'failed' && (voiceClient.error ?? 'Voice connection failed')}
            </div>
          )}

          {selfVoiceState && (
            <>
              <div className="voice-connection-row">
                <div className="voice-connection-copy">
                  <strong>
                    {voiceClient.status === 'reconnecting'
                      ? 'Voice Recovering'
                      : voiceClient.status === 'connected'
                        ? 'Voice Connected'
                        : 'Voice Connecting'}
                  </strong>
                  <small>
                    {`${connectedVoiceChannel ? `#${connectedVoiceChannel.name}` : 'Voice channel'} · ${connectedVoiceParticipants.length} participant${connectedVoiceParticipants.length === 1 ? '' : 's'}`}
                  </small>
                  <small className="voice-network-diagnostics">{voiceNetworkDiagnosticsLabel}</small>
                </div>
              </div>

              <VoiceMicMeter
                level={voiceClient.inputLevel}
                disabled={selfVoiceInputDisabled}
              />

              <div className="voice-controls">
                <button
                  className={selfVoiceState.muted ? 'active' : ''}
                  onClick={() => updateVoiceState({ muted: !selfVoiceState.muted })}
                >
                  {selfVoiceState.muted ? 'Unmute' : 'Mute'}
                </button>
                <button
                  className={selfVoiceState.deafened ? 'active' : ''}
                  onClick={() => updateVoiceState({ deafened: !selfVoiceState.deafened })}
                >
                  {selfVoiceState.deafened ? 'Undeafen' : 'Deafen'}
                </button>
                <button
                  className={selfVoiceState.pushToTalk ? 'active' : ''}
                  onClick={() => updateVoiceState({ pushToTalk: !selfVoiceState.pushToTalk })}
                >
                  PTT
                </button>
              </div>

              {selfVoiceState.pushToTalk && (
                <button
                  className={`voice-ptt ${pushToTalkHeld ? 'active' : ''}`}
                  onMouseDown={() => setSpeakingState(true)}
                  onMouseUp={() => setSpeakingState(false)}
                  onMouseLeave={() => setSpeakingState(false)}
                  onTouchStart={() => setSpeakingState(true)}
                  onTouchEnd={() => setSpeakingState(false)}
                >
                  {pushToTalkHeld ? 'Talking' : 'Hold To Talk'}
                </button>
              )}

              <button
                className="voice-disconnect voice-disconnect-bottom"
                onClick={() => leaveVoiceMutation.mutate()}
                disabled={leaveVoiceMutation.isPending}
              >
                Leave Voice
              </button>
            </>
          )}
        </section>

        <div
          className="channels-resize-handle"
          role="separator"
          aria-label="Resize channels sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_CHANNELS_PANE_WIDTH}
          aria-valuemax={getChannelsPaneMaxWidth()}
          aria-valuenow={channelsPaneWidth}
          tabIndex={0}
          onPointerDown={handleChannelsPaneResizePointerDown}
          onKeyDown={handleChannelsPaneResizeKeyDown}
        />
      </aside>

      <main className="chat-pane">
        <header className="chat-header">
          <div className="chat-title-glass-shell glass-panel" ref={channelTitleGlassRef}>
            <LiquidGlassBackdrop
              className="channel-title-liquid-glass"
              cornerRadius={999}
              displacementScale={128}
              blurAmount={0.1}
              saturation={145}
              aberrationIntensity={2}
              elasticity={0.04}
              mode="prominent"
              mouseContainer={channelTitleGlassRef}
              overLight={isOverLightBackground}
            />
            <h1>{currentChannel ? `${getChannelLabelPrefix(currentChannel)} ${currentChannel.name}` : 'Select a channel'}</h1>
          </div>
          {currentChannel?.type === 'voice' && (
            <div className="header-actions">
              <small>{selectedVoiceParticipants.length} connected</small>
              {connectedVoiceChannelId === currentChannel.id ? (
                <button onClick={() => leaveVoiceMutation.mutate()} disabled={leaveVoiceMutation.isPending}>
                  Disconnect
                </button>
              ) : (
                <button onClick={() => joinVoiceMutation.mutate(currentChannel.id)} disabled={joinVoiceMutation.isPending || voiceClient.status === 'requesting_microphone' || voiceClient.status === 'connecting'}>
                  Join Voice
                </button>
              )}
            </div>
          )}
        </header>

        {currentChannel?.type === 'voice' ? (
          <section className="voice-room">
            <div className="voice-room-shell">
              <header
                className={`voice-room-hero ${isViewingConnectedVoiceChannel ? 'connected' : ''}`}
              >
                <div className="voice-room-identity">
                  <div className="voice-room-mark" aria-hidden>
                    <span>{selectedVoiceInitial}</span>
                    <div className="voice-room-mark-bars">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                  <div className="voice-room-title">
                    <span>Voice Channel</span>
                    <h2>{currentChannel.name}</h2>
                    <div className="voice-room-metadata">
                      <span>{selectedVoiceParticipants.length} connected</span>
                      <span>{selectedVoiceSpeakerCount} speaking</span>
                      {selectedVoiceMutedCount > 0 && <span>{selectedVoiceMutedCount} muted</span>}
                    </div>
                  </div>
                </div>
                <div className="voice-room-presence-card">
                  <div className="voice-room-signal" aria-hidden>
                    <span className={selectedVoiceSpeakerCount > 0 ? 'active' : ''} />
                    <span className={selectedVoiceSpeakerCount > 1 ? 'active' : ''} />
                    <span className={selectedVoiceSpeakerCount > 2 ? 'active' : ''} />
                  </div>
                  <div>
                    <strong>{selectedVoiceSpeakerCount > 0 ? 'Live audio' : 'Quiet room'}</strong>
                    <small>{isViewingConnectedVoiceChannel ? 'You are connected' : 'Ready to join'}</small>
                  </div>
                  {isViewingConnectedVoiceChannel ? (
                    <button
                      className="voice-room-action disconnect"
                      onClick={() => leaveVoiceMutation.mutate()}
                      disabled={leaveVoiceMutation.isPending}
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      className="voice-room-action"
                      onClick={() => joinVoiceMutation.mutate(currentChannel.id)}
                      disabled={
                        joinVoiceMutation.isPending ||
                        voiceClient.status === 'requesting_microphone' ||
                        voiceClient.status === 'connecting'
                      }
                    >
                      Join Voice
                    </button>
                  )}
                </div>
              </header>

              {selectedVoiceParticipants.length === 0 ? (
                <div className="voice-room-empty-floating">No one is in this channel yet.</div>
              ) : (
                <ul className={`voice-room-list ${selectedVoiceParticipantSizeClass}`} aria-label="Voice participants">
                  {selectedVoiceParticipants.map((voiceState) => {
                    const participant = membersById.get(voiceState.userId);
                    const participantName = participant?.displayName ?? voiceState.userId;
                    const isSelf = voiceState.userId === currentUser.id;
                    return (
                      <li
                        key={voiceState.userId}
                        className={`voice-room-member ${voiceState.speaking ? 'speaking' : ''} ${isSelf ? 'self' : ''}`}
                        title={`${participantName}${isSelf ? ' (You)' : ''}`}
                        aria-label={`${participantName}${isSelf ? ' (You)' : ''}${voiceState.speaking ? ', speaking' : ''}`}
                      >
                        <div className="voice-room-avatar">
                          <Avatar src={participant?.avatarUrl} name={participantName} size="md" />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        ) : (
          <>
            <section className="messages-list" ref={messagesListRef} onScroll={handleMessagesScroll}>
              {messagesQuery.isFetchingNextPage && <small className="list-loading">Loading older messages…</small>}
              {messages.map((message) => {
                const author = membersById.get(message.authorId);
                const isOwnMessage = message.authorId === currentUser.id;
                const attachments = message.attachments ?? [];
                const mediaAttachments = attachments.filter(
                  (attachment) => attachment.mimeType.startsWith('image/') || attachment.mimeType.startsWith('video/'),
                );
                const fileAttachments = attachments.filter(
                  (attachment) => !attachment.mimeType.startsWith('image/') && !attachment.mimeType.startsWith('video/'),
                );
                const displayContent = getDisplayMessageContent(message, decryptedMessages[message.id], e2eeState);
                const hasTextContent = displayContent.trim().length > 0;
                const hasMedia = Boolean(message.gifUrl) || mediaAttachments.length > 0;
                const isMediaOnly = hasMedia && !hasTextContent && fileAttachments.length === 0;
                const isEncryptedPlaceholder = Boolean(
                  message.encryptedContent && decryptedMessages[message.id]?.status !== 'ready',
                );
                const parentMessage = message.parentMessageId ? messagesById.get(message.parentMessageId) : null;
                const parentAuthor = parentMessage ? membersById.get(parentMessage.authorId) : null;
                const parentPreview = parentMessage
                  ? getMessagePreviewText(parentMessage, decryptedMessages[parentMessage.id], e2eeState)
                  : 'Message unavailable';
                const reactions = message.reactions ?? [];
                const hoverToolbarPlacement =
                  messageHoverToolbar?.messageId === message.id ? messageHoverToolbar.placement : 'top';
                const hoverToolbar = (
                  <div
                    className={`message-hover-toolbar liquid-surface ${isOverLightBackground ? 'over-light-background' : ''} ${isOwnMessage ? 'own' : 'other'} ${hoverToolbarPlacement === 'bottom' ? 'below' : 'above'}`}
                  >
                    <LiquidGlassBackdrop
                      className="menu-liquid-glass"
                      cornerRadius={14}
                      displacementScale={72}
                      blurAmount={0.14}
                      saturation={148}
                      aberrationIntensity={1.4}
                      elasticity={0}
                      mode="prominent"
                      overLight={isOverLightBackground}
                    />
                    <div className="message-hover-recent">
                      {recentReactionEmojis.map((emoji) => (
                        <button
                          key={`${message.id}-${emoji}`}
                          type="button"
                          className="message-hover-icon emoji"
                          onClick={() => handleToggleReaction(message.id, emoji)}
                          disabled={reactionMutation.isPending}
                          aria-label={`React with ${emoji}`}
                          title={`React with ${emoji}`}
                        >
                          <span className="message-hover-emoji-glyph">{emoji}</span>
                        </button>
                      ))}
                    </div>
                    <span className="message-hover-divider" aria-hidden />
                    <button
                      type="button"
                      className="message-hover-icon"
                      onClick={() => {
                        setEmojiReactionMessageId(message.id);
                        setEmojiSearchInput('');
                        setGifTab('emoji');
                        setIsGifModalOpen(true);
                      }}
                      aria-label="Add reaction"
                      title="Add reaction"
                    >
                      <EmojiPickerIcon />
                    </button>
                    <button
                      type="button"
                      className="message-hover-icon"
                      onClick={() => handleReplyToMessage(message)}
                      aria-label="Reply"
                      title="Reply"
                    >
                      <span className="message-hover-symbol">↩</span>
                    </button>
                    <button
                      type="button"
                      className="message-hover-icon"
                      onClick={() => handleForwardMessage(message)}
                      aria-label="Forward"
                      title="Forward"
                    >
                      <span className="message-hover-symbol">↪</span>
                    </button>
                    <button
                      type="button"
                      className="message-hover-icon"
                      onClick={() => handleCopyMessageId(message)}
                      aria-label="Copy message ID"
                      title="Copy message ID"
                    >
                      <span className="message-hover-symbol">…</span>
                    </button>
                  </div>
                );
                return (
                  <article
                    key={message.id}
                    id={`message-item-${message.id}`}
                    className={`message-row ${isOwnMessage ? 'own' : 'other'} ${highlightedMessageId === message.id ? 'jump-target' : ''}`}
                  >
                    <div className={`message-cluster ${isMediaOnly ? 'media-only' : ''}`}>
                      <Avatar src={author?.avatarUrl} name={author?.displayName ?? message.authorId} size="md" />
                      {hoverToolbar}
                      <div
                        className={`message-body glass-panel ${isOwnMessage ? 'own' : 'other'} ${isMediaOnly ? 'media-only' : ''}`}
                        onMouseEnter={(event) => updateMessageHoverToolbarPlacement(message.id, event.currentTarget)}
                        onFocus={(event) => updateMessageHoverToolbarPlacement(message.id, event.currentTarget)}
                        onContextMenu={(event) => {
                          const menuContext: AppContextMenu = {
                            kind: 'message',
                            message,
                          };
                          contextMenu.open(event, menuContext, contextMenuSections(menuContext));
                        }}
                      >
                        {!isMediaOnly && <StaticMessageGlassBackdrop overLight={isOverLightBackground} />}
                        {message.parentMessageId && (
                          <button
                            type="button"
                            className="reply-reference"
                            onClick={() => handleReplyPreviewClick(message.parentMessageId!)}
                          >
                            <span className="reply-reference-author">
                              {parentAuthor?.displayName ?? 'Unknown member'}
                            </span>
                            <span>{parentPreview}</span>
                          </button>
                        )}
                        <div className="message-meta">
                          <strong>{isOwnMessage ? 'You' : (author?.displayName ?? message.authorId)}</strong>
                          <small>{author?.handle ? formatIdentityHandle(author) : message.authorId}</small>
                        </div>
                        {hasTextContent && (
                          <p className={isEncryptedPlaceholder ? 'encrypted-placeholder' : undefined}>
                            {renderMessageContent(displayContent, {
                              membersByMention,
                              channelsByMention,
                              onMemberClick: (memberId) => {
                                void handleUserSearchSelect(memberId);
                              },
                              onChannelClick: handleSelectChannel,
                            })}
                          </p>
                        )}
                        {message.gifUrl &&
                          (isVideoMediaUrl(message.gifUrl) ? (
                            <PausableGifVideo
                              src={message.gifUrl}
                              className="gif-preview-video"
                              playWhenAllowed={shouldAnimateMessageGifs}
                              onLoadedMetadata={handleMessageContentResized}
                            />
                          ) : (
                            <PausableGifImage
                              src={message.gifUrl}
                              alt="gif"
                              className="gif-preview"
                              playWhenAllowed={shouldAnimateMessageGifs}
                              loading="lazy"
                              onLoad={handleMessageContentResized}
                            />
                          ))}
                        {mediaAttachments.length > 0 && (
                          <ul className="message-media-list">
                            {mediaAttachments.map((attachment) => {
                              const attachmentUrl = `/api/v1/media/attachments/${attachment.id}`;
                              if (attachment.mimeType.startsWith('video/')) {
                                return (
                                  <li key={attachment.id}>
                                    <video
                                      className="attachment-preview"
                                      controls
                                      preload="metadata"
                                      onLoadedMetadata={handleMessageContentResized}
                                    >
                                      <source src={attachmentUrl} type={attachment.mimeType} />
                                      {attachment.fileName}
                                    </video>
                                  </li>
                                );
                              }

                              if (attachment.mimeType === 'image/gif' || isGifImageUrl(attachmentUrl)) {
                                return (
                                  <li key={attachment.id}>
                                    <PausableGifImage
                                      className="attachment-preview gif-attachment-preview"
                                      src={attachmentUrl}
                                      alt={attachment.fileName}
                                      playWhenAllowed={shouldAnimateMessageGifs}
                                      loading="lazy"
                                      onLoad={handleMessageContentResized}
                                    />
                                  </li>
                                );
                              }

                              return (
                                <li key={attachment.id}>
                                  <img
                                    className="attachment-preview"
                                    src={attachmentUrl}
                                    alt={attachment.fileName}
                                    loading="lazy"
                                    onLoad={handleMessageContentResized}
                                  />
                                </li>
                              );
                            })}
                          </ul>
                        )}
                        {fileAttachments.length > 0 && (
                          <ul>
                            {fileAttachments.map((attachment) => (
                              <li key={attachment.id}>
                                <a href={`/api/v1/media/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
                                  {attachment.fileName}
                                </a>
                              </li>
                            ))}
                          </ul>
                        )}
                        {reactions.length > 0 && (
                          <div className="message-reactions">
                            {reactions.map((reaction) => {
                              const reactedByMe = reaction.userIds.includes(currentUser.id);
                              return (
                                <button
                                  key={`${message.id}-${reaction.emoji}`}
                                  type="button"
                                  className={`message-reaction-chip ${reactedByMe ? 'reacted' : ''}`}
                                  onClick={() => handleToggleReaction(message.id, reaction.emoji)}
                                  disabled={reactionMutation.isPending}
                                  title={`${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`}
                                >
                                  <span>{reaction.emoji}</span>
                                  <strong>{reaction.count}</strong>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>
            {newMessageCount > 0 && (
              <button
                ref={newMessageJumpRef}
                className={`new-message-jump liquid-surface ${isOverLightBackground ? 'over-light-background' : ''}`}
                onClick={handleJumpToLatestMessages}
              >
                <LiquidGlassBackdrop
                  className="menu-title-liquid-glass new-message-liquid-glass"
                  cornerRadius={999}
                  displacementScale={128}
                  blurAmount={0.16}
                  saturation={145}
                  aberrationIntensity={2}
                  elasticity={0.04}
                  mode="prominent"
                  mouseContainer={newMessageJumpRef}
                  overLight={isOverLightBackground}
                />
                <span>{newMessageCount === 1 ? '1 new message' : `${newMessageCount} new messages`}</span>
                <span aria-hidden>↓</span>
              </button>
            )}

            <div className={`typing-indicator ${typingSummary ? 'active' : ''}`} aria-live="polite">
              {typingSummary ? (
                <>
                  <span className="typing-dots" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </span>
                  <span>{typingSummary}</span>
                </>
              ) : (
                <span className="typing-indicator-placeholder" />
              )}
            </div>

            <footer className="composer">
              {replyDraft && (
                <div className="composer-reply-preview">
                  <button
                    type="button"
                    className="composer-reply-target"
                    onClick={() => handleReplyPreviewClick(replyDraft.messageId)}
                  >
                    <span>Replying to {replyDraftAuthor?.displayName ?? 'Unknown member'}</span>
                    <strong>{replyDraftPreview}</strong>
                  </button>
                  <button
                    type="button"
                    className="composer-reply-cancel"
                    onClick={() => setReplyDraft(null)}
                    aria-label="Cancel reply"
                  >
                    ×
                  </button>
                </div>
              )}
              <div className="composer-inline glass-panel composer-glass-panel" ref={composerGlassRef}>
                <LiquidGlassBackdrop
                  className="composer-liquid-glass"
                  cornerRadius={14}
                  displacementScale={128}
                  blurAmount={0.1}
                  saturation={145}
                  aberrationIntensity={2}
                  elasticity={0.04}
                  mode="prominent"
                  mouseContainer={composerGlassRef}
                  overLight={isOverLightBackground}
                />
                <label className="inline-icon attach" title="Attach file">
                  +
                  <input
                    type="file"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) {
                        return;
                      }
                      void uploadAttachment(file).then((attachment) => {
                        setAttachmentIds((prev) => [...prev, attachment.id]);
                      });
                    }}
                  />
                </label>
                <textarea
                  ref={composerInputRef}
                  className="composer-input"
                  rows={1}
                  value={messageText}
                  onChange={(event) => handleComposerInputChange(event.target.value, event.target.selectionStart)}
                  onFocus={(event) => {
                    setIsComposerFocused(true);
                    updateComposerCaretFromInput(event.currentTarget);
                  }}
                  onClick={(event) => updateComposerCaretFromInput(event.currentTarget)}
                  onKeyUp={(event) => {
                    if (event.key !== 'Escape') {
                      updateComposerCaretFromInput(event.currentTarget);
                    }
                  }}
                  onSelect={(event) => updateComposerCaretFromInput(event.currentTarget)}
                  onBlur={() => {
                    setIsComposerFocused(false);
                    const activeChannelId = typingChannelRef.current;
                    if (!activeChannelId) {
                      return;
                    }
                    clearTypingStopTimer();
                    emitTypingState(activeChannelId, false);
                    typingChannelRef.current = null;
                    typingHeartbeatAtRef.current = 0;
                  }}
                  onKeyDown={(event) => {
                    if (showComposerSuggestions && activeComposerReference) {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        setActiveComposerSuggestionIndex((previous) => (previous + 1) % composerSuggestions.length);
                        return;
                      }

                      if (event.key === 'ArrowUp') {
                        event.preventDefault();
                        setActiveComposerSuggestionIndex((previous) =>
                          (previous - 1 + composerSuggestions.length) % composerSuggestions.length,
                        );
                        return;
                      }

                      if (event.key === 'Tab' || event.key === 'Enter') {
                        event.preventDefault();
                        const suggestion =
                          composerSuggestions[
                            Math.min(activeComposerSuggestionIndex, composerSuggestions.length - 1)
                          ];
                        if (suggestion) {
                          insertComposerReference(suggestion);
                        }
                        return;
                      }

                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setComposerCaretPosition(-1);
                        return;
                      }
                    }

                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      currentChannel &&
                      (messageText.trim().length > 0 || attachmentIds.length > 0)
                    ) {
                      event.preventDefault();
                      sendMessageMutation.mutate({});
                    }
                  }}
                  placeholder={currentChannel ? `Message #${currentChannel.name}` : 'Message current channel'}
                />
                {showComposerSuggestions && activeComposerReference && (
                  <div className="mention-suggestions">
                    {composerSuggestions.map((suggestion, index) => {
                      const active = index === Math.min(activeComposerSuggestionIndex, composerSuggestions.length - 1);
                      if (suggestion.kind === 'member') {
                        return (
                          <button
                            key={`member-${suggestion.member.id}`}
                            type="button"
                            className={active ? 'active' : ''}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => insertComposerReference(suggestion)}
                          >
                            <Avatar src={suggestion.member.avatarUrl} name={suggestion.member.displayName} size="sm" />
                            <span>
                              <strong>{suggestion.member.displayName}</strong>
                              <small>{getMemberMentionToken(suggestion.member)}</small>
                            </span>
                          </button>
                        );
                      }

                      return (
                        <button
                          key={`channel-${suggestion.channel.id}`}
                          type="button"
                          className={active ? 'active' : ''}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => insertComposerReference(suggestion)}
                        >
                          <span className="mention-channel-symbol">#</span>
                          <span>
                            <strong>{suggestion.channel.name}</strong>
                            <small>{suggestion.channel.type === 'dm' ? 'DM' : 'Text channel'}</small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="inline-actions">
                  <button
                    className="inline-icon gif-picker"
                    type="button"
                    onClick={() => {
                      setEmojiReactionMessageId(null);
                      setGifTab('gifs');
                      setIsGifModalOpen(true);
                    }}
                    title="Open GIF picker"
                    aria-label="Open GIF picker"
                  >
                    <GifPickerIcon />
                  </button>
                  <button
                    className="inline-icon emoji-picker"
                    type="button"
                    onClick={() => {
                      setEmojiReactionMessageId(null);
                      setGifTab('emoji');
                      setIsGifModalOpen(true);
                    }}
                    title="Open Emoji"
                    aria-label="Open emoji picker"
                  >
                    <EmojiPickerIcon />
                  </button>
                </div>
                <button
                  className="inline-send"
                  onClick={() => sendMessageMutation.mutate({})}
                  disabled={sendMessageMutation.isPending || !canSendMessage}
                  title="Send message"
                >
                  Send
                </button>
              </div>
              {attachmentIds.length > 0 && (
                <small>
                  Draft attachments: {attachmentIds.length} attachment{attachmentIds.length === 1 ? '' : 's'}
                </small>
              )}
              {hasComposerText && e2eeState.status !== 'ready' && (
                <small className="composer-warning">
                  Preparing the shared message encryption key.
                </small>
              )}
              {sendMessageMutation.isError && (
                <small className="composer-warning">
                  {sendMessageMutation.error instanceof Error ? sendMessageMutation.error.message : 'Message failed.'}
                </small>
              )}
            </footer>
          </>
        )}
      </main>

      <aside className="members-pane glass-panel" ref={membersPaneRef} onScroll={handleMembersPaneScroll}>
        <div
          className="members-resize-handle"
          role="separator"
          aria-label="Resize members sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_MEMBERS_PANE_WIDTH}
          aria-valuemax={getMembersPaneMaxWidth()}
          aria-valuenow={membersPaneWidth}
          tabIndex={0}
          onPointerDown={handleMembersPaneResizePointerDown}
          onKeyDown={handleMembersPaneResizeKeyDown}
        />
        <div className="members-search-glass-shell glass-panel" ref={searchGlassRef}>
          <button
            className="members-search-trigger"
            onClick={openSearchModal}
            title="Search messages or users"
          >
            <span className="members-search-label">Search messages and users</span>
            <kbd>Ctrl+K</kbd>
          </button>
        </div>
        <header>
          <h2>Members</h2>
          <small>{onlineMemberCount}/{visibleMemberList.length} online</small>
        </header>
        <ul className="member-list">
          {memberRosterSections.map((section) => (
            <Fragment key={section.id}>
              <li className={`member-group-label ${section.id}`}>
                <span className="member-group-title">
                  <span className={`member-group-color ${section.id}`} />
                  {section.label}
                </span>
                <span>{section.members.length}</span>
              </li>
              {section.members.map(({ member, topRole, presence }) => {
                const voiceState = voicePresenceByUserId.get(member.id);
                const inVoice = Boolean(voiceState);
                const speaking = voiceState?.speaking ?? false;
                const isSelf = member.id === currentUser.id;
                const statusLabel = speaking && isVisibleOnlinePresence(presence)
                  ? 'Speaking'
                  : inVoice && isVisibleOnlinePresence(presence)
                    ? 'In voice'
                    : getMemberPresenceLabel(presence.status);
                const stateClassName = speaking && isVisibleOnlinePresence(presence)
                  ? 'speaking'
                  : getPresenceClassName(presence.status);
                return (
                  <li
                    key={member.id}
                    id={`member-item-${member.id}`}
                    className={`member-item ${highlightedMemberId === member.id ? 'search-highlight' : ''}`}
                    onContextMenu={(event) => {
                      const menuContext: AppContextMenu = {
                        kind: 'member',
                        member,
                      };
                      contextMenu.open(event, menuContext, contextMenuSections(menuContext));
                    }}
                  >
                    <div className="member-main">
                      <Avatar src={member.avatarUrl} name={member.displayName} size="sm" />
                      <div className="member-text">
                        <strong>{member.displayName}{isSelf ? ' (You)' : ''}</strong>
                        <small>{formatIdentityHandle(member)}</small>
                      </div>
                    </div>
                    <div className="member-presence">
                      <span className="member-presence-label">{statusLabel}</span>
                      <span
                        className={`member-state ${stateClassName}`}
                        title={topRole?.name ?? statusLabel}
                      />
                    </div>
                  </li>
                );
              })}
            </Fragment>
          ))}
        </ul>
        {membersQuery.isFetchingNextPage && <small className="list-loading">Loading members…</small>}
      </aside>
      {isSearchModalOpen && (
        <div className="search-modal-backdrop" onClick={() => setIsSearchModalOpen(false)}>
          <section
            className={`search-modal liquid-surface ${isOverLightBackground ? 'over-light-background' : ''}`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="search-modal-header">
              <h3>Search</h3>
              <button className="search-modal-close" onClick={() => setIsSearchModalOpen(false)}>
                ×
              </button>
            </header>
            <p className="search-modal-note">
              Results are sorted newest to oldest and grouped by channel. Message IDs are searchable too.
            </p>
            <div className={`search-modal-tabs ${searchTab === 'users' ? 'users-active' : 'messages-active'}`}>
              <button
                className={searchTab === 'messages' ? 'active' : ''}
                onClick={() => setSearchTab('messages')}
                disabled={!isMessageChannel(currentChannel)}
              >
                Messages
              </button>
              <button className={searchTab === 'users' ? 'active' : ''} onClick={() => setSearchTab('users')}>
                Users
              </button>
            </div>
            <input
              ref={searchModalInputRef}
              className="search-modal-input"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={searchTab === 'messages' ? 'Search messages or IDs' : 'Search users by name or handle'}
            />
            {searchTab === 'messages' ? (
              <div className="search-results-list">
                <div className="search-filter-row">
                  <label>
                    from:
                    <select
                      value={searchFromUserId}
                      onChange={(event) => setSearchFromUserId(event.target.value)}
                    >
                      <option value="all">All users</option>
                      {[...visibleMemberList]
                        .sort((a, b) => a.displayName.localeCompare(b.displayName))
                        .map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.displayName} ({formatIdentityHandle(member)})
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    in:
                    <select
                      value={searchChannelId}
                      onChange={(event) => setSearchChannelId(event.target.value)}
                    >
                      <option value="all">All channels</option>
                      {searchableChannels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.type === 'dm' ? 'DM' : '#'} {channel.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {messageSearchQuery.isLoading && <p className="search-empty">Searching messages…</p>}
                {messageSearchQuery.isError && <p className="search-empty">Could not search messages right now.</p>}
                {!messageSearchQuery.isLoading &&
                  !messageSearchQuery.isError &&
                  messageSearchSections.length === 0 && (
                    <p className="search-empty">No messages match this search.</p>
                  )}
                {messageSearchSections.map((section) => (
                  <section key={section.channelId} className="search-channel-section">
                    <header>
                      <strong>#{section.channelName}</strong>
                      <small>{section.items.length}</small>
                    </header>
                    {section.items.map((message) => {
                      const author = membersById.get(message.authorId);
                      const dateLabel = new Date(message.createdAt).toLocaleString();
                      const displayContent = getDisplayMessageContent(message, decryptedMessages[message.id], e2eeState);
                      const preview =
                        displayContent.trim().length > 0
                          ? displayContent
                          : message.gifUrl
                            ? 'GIF message'
                            : (message.attachments?.length ?? 0) > 0
                              ? 'Attachment message'
                              : 'Message';
                      return (
                        <button
                          key={message.id}
                          className="search-result-card"
                          onClick={() => handleMessageSearchSelect(message)}
                        >
                          <div className="search-result-author">
                            <Avatar src={author?.avatarUrl} name={author?.displayName ?? 'Unknown member'} size="sm" />
                            <div>
                              <strong>{author?.displayName ?? 'Unknown member'}</strong>
                              <small>
                                {author ? formatIdentityHandle(author) : '@Unknown'} · {dateLabel}
                              </small>
                            </div>
                          </div>
                          <p>{preview}</p>
                        </button>
                      );
                    })}
                  </section>
                ))}
              </div>
            ) : (
              <div className="search-results-list">
                {searchedUsers.length === 0 && <p className="search-empty">No users match this search.</p>}
                {searchedUsers.map((member) => (
                  <button
                    key={member.id}
                    className="search-result-card user"
                    onClick={() => {
                      void handleUserSearchSelect(member.id);
                    }}
                  >
                    <div className="search-user-head">
                      <Avatar src={member.avatarUrl} name={member.displayName} size="sm" />
                      <div>
                        <strong>{member.displayName}</strong>
                        <small>{formatIdentityHandle(member)}</small>
                      </div>
                    </div>
                    <small>
                      Joined {getMemberCreatedAtTimestamp(member) > 0 ? new Date(getMemberCreatedAtTimestamp(member)).toLocaleDateString() : 'recently'}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
      {isGifModalOpen && (
        <div
          className="gif-modal-backdrop"
          onClick={() => {
            setEmojiTonePicker(null);
            setIsGifModalOpen(false);
            setEmojiReactionMessageId(null);
          }}
        >
          <section
            className={`gif-modal liquid-surface ${isOverLightBackground ? 'over-light-background' : ''}`}
            onClick={(event) => event.stopPropagation()}
          >
            <LiquidGlassBackdrop
              className="modal-liquid-glass"
              cornerRadius={20}
              displacementScale={128}
              blurAmount={0.22}
              saturation={145}
              aberrationIntensity={2}
              elasticity={0.04}
              mode="prominent"
              overLight={isOverLightBackground}
            />
            <header className="gif-modal-top">
              <div className="gif-tabs">
                {isReactionEmojiModal ? (
                  <button className="active" type="button">
                    Emoji
                  </button>
                ) : (
                  <>
                    <button
                      className={gifTab === 'gifs' ? 'active' : ''}
                      type="button"
                      onClick={() => setGifTab('gifs')}
                    >
                      GIFs
                    </button>
                    <button
                      className={gifTab === 'emoji' ? 'active' : ''}
                      type="button"
                      onClick={() => setGifTab('emoji')}
                    >
                      Emoji
                    </button>
                  </>
                )}
              </div>
              <button
                className="gif-close"
                type="button"
                onClick={() => {
                  setEmojiTonePicker(null);
                  setIsGifModalOpen(false);
                  setEmojiReactionMessageId(null);
                }}
              >
                ×
              </button>
            </header>

            <input
              className="gif-search-input"
              value={!isReactionEmojiModal && gifTab === 'gifs' ? gifSearchInput : emojiSearchInput}
              onChange={(event) => {
                if (!isReactionEmojiModal && gifTab === 'gifs') {
                  setGifSearchInput(event.target.value);
                  return;
                }
                setEmojiSearchInput(event.target.value);
              }}
              placeholder={!isReactionEmojiModal && gifTab === 'gifs' ? 'Search GIFs' : 'Search emoji'}
            />

            {!isReactionEmojiModal && gifTab === 'gifs' ? (
              <>
                <div className="gif-topic-grid">
                  {GIF_QUICK_TOPICS.map((topic) => (
                    <button
                      key={topic}
                      type="button"
                      className="gif-topic-card"
                      onClick={() => {
                        setGifSearchInput(topic);
                        setGifSearchQuery(topic);
                      }}
                    >
                      {topic}
                    </button>
                  ))}
                </div>
                <div className="gif-results-grid">
                  {gifSearchQueryResult.isLoading && <p>Loading GIFs…</p>}
                  {gifSearchQueryResult.isError && <p>Could not load GIFs right now.</p>}
                  {!gifSearchQueryResult.isLoading && !gifSearchQueryResult.isError && gifProviderWarning && (
                    <p className="gif-provider-warning">{gifProviderWarning}</p>
                  )}
                  {!gifSearchQueryResult.isLoading && !gifSearchQueryResult.isError && gifTiles.length === 0 && (
                    <p>No GIFs found for this search.</p>
                  )}
                  {gifTiles.map((tile) => (
                    <button
                      key={tile.id}
                      type="button"
                      className="gif-result-card"
                      onClick={() => handleGifSelect(tile)}
                      disabled={sendMessageMutation.isPending}
                    >
                      {isVideoMediaUrl(tile.previewUrl) ? (
                        <PausableGifVideo
                          src={tile.previewUrl}
                          className="gif-result-preview"
                          playWhenAllowed={isAnimationPlaybackActive}
                        />
                      ) : (
                        <PausableGifImage
                          src={tile.previewUrl}
                          alt={tile.label}
                          className="gif-result-preview"
                          playWhenAllowed={isAnimationPlaybackActive}
                          loading="lazy"
                        />
                      )}
                      <span>{tile.label}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="emoji-results-grid">
                {isEmojiCatalogLoading && <p>Loading emoji…</p>}
                {!isEmojiCatalogLoading && filteredEmoji.length === 0 && <p>No emoji found for this search.</p>}
                {!isEmojiCatalogLoading && filteredEmoji.map((entry, index) => {
                  const toneGroup = getEmojiToneGroupForEntry(entry, emojiToneIndex);
                  const displayEmoji = getPreferredEmojiForEntry(entry, emojiToneIndex, emojiToneDefaults);
                  const label = toneGroup ? `${entry.name}, skin tone options available` : entry.name;

                  return (
                    <button
                      key={`${entry.emoji}-${index}`}
                      type="button"
                      className={`emoji-result-card ${toneGroup ? 'tone-stack' : ''}`}
                      onClick={() => handleEmojiEntrySelect(entry)}
                      onContextMenu={(event) => handleEmojiToneContextMenu(event, toneGroup)}
                      onPointerDown={(event) => handleEmojiLongPressStart(event, toneGroup)}
                      onPointerUp={handleEmojiLongPressEnd}
                      onPointerCancel={handleEmojiLongPressEnd}
                      onPointerLeave={handleEmojiLongPressEnd}
                      disabled={Boolean(emojiReactionMessageId && reactionMutation.isPending)}
                      title={label}
                      aria-label={label}
                    >
                      <span className="emoji-char" aria-hidden>{displayEmoji}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
          {emojiTonePicker && (
            <div
              className={`emoji-tone-popover liquid-surface ${isOverLightBackground ? 'over-light-background' : ''}`}
              style={{ left: emojiTonePicker.x, top: emojiTonePicker.y }}
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <LiquidGlassBackdrop
                className="menu-liquid-glass"
                cornerRadius={14}
                displacementScale={128}
                blurAmount={0.18}
                saturation={145}
                aberrationIntensity={2}
                elasticity={0.04}
                mode="prominent"
                overLight={isOverLightBackground}
              />
              {emojiTonePicker.group.variants.map((variant) => {
                const selectedEmoji =
                  emojiToneDefaults[emojiTonePicker.group.baseEmoji] ??
                  emojiTonePicker.group.variants.find((item) => item.toneId === 'default')?.emoji ??
                  emojiTonePicker.group.variants[0]?.emoji;
                const active = selectedEmoji === variant.emoji;

                return (
                  <button
                    key={variant.emoji}
                    type="button"
                    className={`emoji-tone-option ${active ? 'active' : ''}`}
                    onClick={() => handleEmojiToneSelect(emojiTonePicker.group, variant)}
                    title={variant.label}
                    aria-label={`${emojiTonePicker.group.baseName}, ${variant.label}`}
                  >
                    <span className="emoji-char" aria-hidden>{variant.emoji}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <ServerSettingsModal
        open={isServerSettingsOpen}
        onClose={() => {
          setAppearancePreview(null);
          setIsServerSettingsOpen(false);
        }}
        canManageServer={canManageServer}
        members={visibleMemberList.map((member) => ({
          id: member.id,
          handle: member.handle,
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
          roleIds: member.roleIds,
        }))}
        e2eeState={e2eeState}
        onCopyE2eeKey={handleCopyE2eeKey}
        onImportE2eeKey={handleImportE2eeKey}
        onAppearancePreview={setAppearancePreview}
        overLight={isOverLightBackground}
      />
      <ContextMenuHost menu={contextMenu.menu} onClose={contextMenu.close} overLight={isOverLightBackground} />
      <ActionModalHost modal={actionModal.modal} onClose={actionModal.close} overLight={isOverLightBackground} />
    </div>
  );
}

function SetupWizard({
  owner,
  authMode,
  onConfigured,
}: {
  owner: SessionPayload['user'];
  authMode: AuthMode;
  onConfigured: (result: SetupBootstrapResponse, initialPresenceStatus: UserPresenceStatus) => Promise<void> | void;
}) {
  const setupSteps = ['Identity', 'Preferences', 'GIFs'] as const;
  const [step, setStep] = useState(0);
  const [serverName, setServerName] = useState('Current Community');
  const [slug, setSlug] = useState('current-community');
  const [slugTouched, setSlugTouched] = useState(false);
  const [publicUrl, setPublicUrl] = useState(() => inferDefaultServerPublicUrl());
  const [registrationMode, setRegistrationMode] = useState<RegistrationMode>('invite_only');
  const [initialPresenceStatus, setInitialPresenceStatus] = useState<UserPresenceStatus>('online');
  const [defaultSlowmodeSeconds, setDefaultSlowmodeSeconds] = useState(0);
  const [maxMentionsPerMessage, setMaxMentionsPerMessage] = useState(8);
  const [linkPolicy, setLinkPolicy] = useState<LinkPolicy>('members_only');
  const [gifProvider, setGifProvider] = useState<GifProvider>('klipy');
  const [gifFallbackProvider, setGifFallbackProvider] = useState<GifFallbackProvider>('none');
  const [klipyApiKey, setKlipyApiKey] = useState('');
  const [giphyApiKey, setGiphyApiKey] = useState('');
  const [uploadLimitMb, setUploadLimitMb] = useState(10);
  const [allowedMimePrefixesText, setAllowedMimePrefixesText] = useState('image/\nvideo/\naudio/\napplication/pdf');
  const isFinalStep = step === setupSteps.length - 1;
  const normalizedSlug = slugifyServerName(slug);
  const allowedMimePrefixes = parseSetupList(allowedMimePrefixesText);
  const basicsValid = serverName.trim().length >= 2 && normalizedSlug.length >= 2 && isValidUrl(publicUrl.trim());
  const preferencesValid =
    Number.isFinite(defaultSlowmodeSeconds) &&
    defaultSlowmodeSeconds >= 0 &&
    Number.isFinite(maxMentionsPerMessage) &&
    maxMentionsPerMessage >= 1;
  const mediaValid = Number.isFinite(uploadLimitMb) && uploadLimitMb > 0 && allowedMimePrefixes.length > 0;
  const canContinue = step === 0 ? basicsValid : step === 1 ? preferencesValid : mediaValid;

  useEffect(() => {
    if (!slugTouched) {
      setSlug(slugifyServerName(serverName));
    }
  }, [serverName, slugTouched]);

  const setupMutation = useMutation({
    mutationFn: () =>
      apiPost<SetupBootstrapResponse>('/api/v1/setup/bootstrap', {
        serverName: serverName.trim(),
        slug: normalizedSlug,
        publicUrl: publicUrl.trim().replace(/\/$/, ''),
        registrationMode,
        initialPresenceStatus,
        moderation: {
          defaultSlowmodeSeconds,
          maxMentionsPerMessage,
          linkPolicy,
        },
        media: {
          gifProvider,
          gifFallbackProvider: gifFallbackProvider === gifProvider ? 'none' : gifFallbackProvider,
          klipyApiKey: klipyApiKey.trim(),
          giphyApiKey: giphyApiKey.trim(),
          maxAttachmentBytes: Math.round(uploadLimitMb * 1024 * 1024),
          allowedMimePrefixes,
        },
      }),
    onSuccess: (result) => onConfigured(result, initialPresenceStatus),
  });

  const handleSubmit = useCallback((event: ReactFormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canContinue || setupMutation.isPending) {
      return;
    }
    if (!isFinalStep) {
      setStep((current) => Math.min(current + 1, setupSteps.length - 1));
      return;
    }
    setupMutation.mutate();
  }, [canContinue, isFinalStep, setupMutation, setupSteps.length]);

  const setupError = setupMutation.error instanceof Error ? setupMutation.error.message : null;

  return (
    <div className="wizard-wrap setup-wrap">
      <form className="wizard-card setup-card" onSubmit={handleSubmit}>
        <header className="setup-hero">
          <div className="current-logo-lockup">
            <img className="current-logo setup-logo" src={CURRENT_LOGO_URL} alt="" decoding="async" />
            <span className="setup-kicker">First run setup</span>
          </div>
          <h1>Set Up Current</h1>
          <p>Give the server its identity, choose the defaults people land in, and wire media before the room opens.</p>
        </header>

        <div className="setup-owner-row">
          <div>
            <strong>{owner.displayName}</strong>
            <small>{formatIdentityHandle(owner)}</small>
          </div>
          <span>{authMode === 'lan' ? 'LAN sign-in' : 'AT Protocol sign-in'}</span>
        </div>

        <ol className="setup-steps" aria-label="Setup progress">
          {setupSteps.map((label, index) => (
            <li key={label} className={index === step ? 'active' : index < step ? 'complete' : ''}>
              <span>{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <section className="setup-step-panel">
            <div className="setup-field-grid">
              <label>
                Server name
                <input value={serverName} onChange={(event) => setServerName(event.target.value)} />
              </label>
              <label>
                Slug
                <input
                  value={slug}
                  onChange={(event) => {
                    setSlugTouched(true);
                    setSlug(event.target.value);
                  }}
                />
              </label>
              <label className="wide">
                Public URL
                <input value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} />
              </label>
              <label>
                Registration
                <select
                  value={registrationMode}
                  onChange={(event) => setRegistrationMode(event.target.value as RegistrationMode)}
                >
                  <option value="invite_only">Invite-only</option>
                  <option value="open_signup">Open signup</option>
                  <option value="manual_approval">Manual approval</option>
                </select>
              </label>
            </div>
            <p className="setup-note">Default spaces: #general for text and lounge for voice.</p>
          </section>
        )}

        {step === 1 && (
          <section className="setup-step-panel">
            <div className="setup-field-grid">
              <label>
                Your status
                <select
                  value={initialPresenceStatus}
                  onChange={(event) => setInitialPresenceStatus(event.target.value as UserPresenceStatus)}
                >
                  {PRESENCE_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Link policy
                <select value={linkPolicy} onChange={(event) => setLinkPolicy(event.target.value as LinkPolicy)}>
                  <option value="members_only">Members only</option>
                  <option value="allow">Allow links</option>
                  <option value="deny">Block links</option>
                </select>
              </label>
              <label>
                Default slowmode
                <input
                  type="number"
                  min="0"
                  value={defaultSlowmodeSeconds}
                  onChange={(event) => setDefaultSlowmodeSeconds(Math.max(0, Number(event.target.value)))}
                />
              </label>
              <label>
                Max mentions
                <input
                  type="number"
                  min="1"
                  value={maxMentionsPerMessage}
                  onChange={(event) => setMaxMentionsPerMessage(Math.max(1, Number(event.target.value)))}
                />
              </label>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="setup-step-panel">
            <div className="setup-field-grid">
              <label>
                GIF service
                <select
                  value={gifProvider}
                  onChange={(event) => {
                    const nextProvider = event.target.value as GifProvider;
                    setGifProvider(nextProvider);
                    setGifFallbackProvider((current) => (current === nextProvider ? 'none' : current));
                  }}
                >
                  <option value="klipy">Klipy</option>
                  <option value="giphy">Giphy</option>
                </select>
              </label>
              <label>
                GIF backup
                <select
                  value={gifFallbackProvider}
                  onChange={(event) => setGifFallbackProvider(event.target.value as GifFallbackProvider)}
                >
                  <option value="none">None</option>
                  <option value="klipy" disabled={gifProvider === 'klipy'}>Klipy</option>
                  <option value="giphy" disabled={gifProvider === 'giphy'}>Giphy</option>
                </select>
              </label>
              <label>
                Klipy API key
                <input value={klipyApiKey} onChange={(event) => setKlipyApiKey(event.target.value)} />
              </label>
              <label>
                Giphy API key
                <input value={giphyApiKey} onChange={(event) => setGiphyApiKey(event.target.value)} />
              </label>
              <label>
                Upload limit MB
                <input
                  type="number"
                  min="1"
                  value={uploadLimitMb}
                  onChange={(event) => setUploadLimitMb(Math.max(1, Number(event.target.value)))}
                />
              </label>
              <label className="wide">
                Allowed uploads
                <textarea
                  rows={4}
                  value={allowedMimePrefixesText}
                  onChange={(event) => setAllowedMimePrefixesText(event.target.value)}
                />
              </label>
            </div>
          </section>
        )}

        {setupError && <p className="auth-error">{setupError}</p>}

        <footer className="setup-actions">
          <button
            type="button"
            className="setup-secondary-button"
            onClick={() => setStep((current) => Math.max(0, current - 1))}
            disabled={step === 0 || setupMutation.isPending}
          >
            Back
          </button>
          <button type="submit" disabled={!canContinue || setupMutation.isPending}>
            {isFinalStep ? (setupMutation.isPending ? 'Initializing...' : 'Initialize Server') : 'Continue'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function inferDefaultServerPublicUrl(): string {
  const base = new URL(window.location.href);
  base.protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  base.port = '8080';
  base.pathname = '';
  base.search = '';
  base.hash = '';
  return base.toString().replace(/\/$/, '');
}

function AuthScreen({
  authMode = 'atproto',
  title,
  subtitle,
}: {
  authMode?: AuthMode;
  title?: string;
  subtitle?: string;
}) {
  const [lanScreenName, setLanScreenName] = useState('');
  const [lanHandoff, setLanHandoff] = useState<OAuthLanHandoffPayload | null>(null);
  const isLanMode = authMode === 'lan';
  const resolvedTitle = title ?? (isLanMode ? 'Join Current (LAN Mode)' : 'Sign In');
  const resolvedSubtitle = subtitle ?? '';
  const canSubmitLan = lanScreenName.trim().length >= 2;

  const oauthMutation = useMutation({
    mutationFn: () => {
      const params = new URLSearchParams({
        handle: 'https://bsky.social',
        returnTo: window.location.origin + window.location.pathname,
      });
      return apiGet<OAuthStartPayload>(`/api/v1/auth/oauth/start?${params.toString()}`);
    },
    onSuccess: (data) => {
      if (data.authorizationUrl) {
        window.location.assign(data.authorizationUrl);
        return;
      }
      if (data.lanHandoff) {
        setLanHandoff(data.lanHandoff);
      }
    },
  });

  const lanHandoffStatusQuery = useQuery({
    queryKey: ['auth', 'lan-handoff', lanHandoff?.handoffId],
    queryFn: () => apiGet<OAuthLanHandoffStatusPayload>(`/api/v1/auth/lan/handoffs/${lanHandoff?.handoffId}`),
    enabled: Boolean(lanHandoff?.handoffId),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!lanHandoff || status === 'ready' || status === 'claimed' || status === 'expired') {
        return false;
      }
      return 2_000;
    },
  });

  const claimLanHandoffMutation = useMutation({
    mutationFn: (handoffId: string) =>
      apiPost<{ ticket: string }>(`/api/v1/auth/lan/handoffs/${handoffId}/claim`),
    onSuccess: async ({ ticket }) => {
      await apiPost<void>('/api/v1/auth/exchange', { ticket });
      window.location.reload();
    },
  });

  useEffect(() => {
    if (!lanHandoff?.handoffId) {
      return;
    }
    if (lanHandoffStatusQuery.data?.status !== 'ready') {
      return;
    }
    if (claimLanHandoffMutation.isPending || claimLanHandoffMutation.isSuccess) {
      return;
    }
    claimLanHandoffMutation.mutate(lanHandoff.handoffId);
  }, [
    claimLanHandoffMutation,
    lanHandoff?.handoffId,
    lanHandoffStatusQuery.data?.status,
  ]);

  const lanLoginMutation = useMutation({
    mutationFn: () =>
      apiPost<{ user: SessionPayload['user'] }>('/api/v1/auth/lan-login', {
        screenName: lanScreenName.trim(),
      }),
    onSuccess: () => {
      window.location.reload();
    },
  });

  const authError =
    (lanLoginMutation.error instanceof Error ? lanLoginMutation.error.message : undefined) ??
    (oauthMutation.error instanceof Error ? oauthMutation.error.message : undefined) ??
    (claimLanHandoffMutation.error instanceof Error ? claimLanHandoffMutation.error.message : undefined);

  return (
    <div className="wizard-wrap auth-wrap">
      <div className={`wizard-card auth-card ${isLanMode ? 'lan' : 'oauth'}`}>
        <div className="auth-card-head">
          <img className="current-logo auth-logo" src={CURRENT_LOGO_URL} alt="Current" decoding="async" />
          <h1>{resolvedTitle}</h1>
          {resolvedSubtitle.length > 0 && <p>{resolvedSubtitle}</p>}
        </div>
        {isLanMode ? (
          <>
            <label>
              Screen name
              <input
                value={lanScreenName}
                onChange={(event) => setLanScreenName(event.target.value)}
                placeholder="Your display name"
              />
            </label>
            <div className="auth-actions single">
              <button onClick={() => lanLoginMutation.mutate()} disabled={lanLoginMutation.isPending || !canSubmitLan}>
                {lanLoginMutation.isPending ? 'Joining...' : 'Join LAN Server'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="auth-actions single">
              <button className="bsky-login-button" onClick={() => oauthMutation.mutate()} disabled={oauthMutation.isPending}>
                <svg
                  className="bsky-logo"
                  viewBox="0 0 600 530"
                  aria-hidden
                  focusable="false"
                >
                  <path
                    fill="currentColor"
                    d="M135 49c71 54 145 160 165 201 20-41 94-147 165-201 52-39 135-69 135 28 0 19-11 161-17 184-21 79-100 99-169 87 122 20 153 86 85 152-128 126-184-32-199-72-3-7-4-10-3-7-1-3-2 0-3 7-15 40-71 198-199 72-68-66-37-132 85-152-69 12-148-8-169-87-6-23-17-165-17-184 0-97 83-67 135-28Z"
                  />
                </svg>
                <span>{oauthMutation.isPending ? 'Redirecting to Bluesky...' : 'Sign In With Bluesky'}</span>
              </button>
            </div>
            {lanHandoff && (
              <div className="auth-lan-handoff">
                <strong>LAN OAuth Handoff</strong>
                <p>{lanHandoff.message ?? 'Complete Bluesky sign-in on the server host machine to finish login here.'}</p>
                <label>
                  Open this on the host machine
                  <input readOnly value={lanHandoff.hostAuthUrl} />
                </label>
                <div className="auth-actions">
                  <button
                    onClick={() => {
                      void navigator.clipboard?.writeText(lanHandoff.hostAuthUrl);
                    }}
                  >
                    Copy Host Link
                  </button>
                </div>
                <small>
                  Status:{' '}
                  {claimLanHandoffMutation.isPending
                    ? 'Exchanging session...'
                    : lanHandoffStatusQuery.data?.status === 'ready'
                      ? 'Host sign-in complete. Finalizing...'
                      : lanHandoffStatusQuery.data?.status === 'expired'
                        ? 'Expired. Start sign-in again.'
                        : lanHandoffStatusQuery.data?.status === 'claimed'
                          ? 'Session claimed. Refreshing...'
                          : 'Waiting for host sign-in...'}
                </small>
              </div>
            )}
          </>
        )}
        {authError && <small className="auth-error">{authError}</small>}
      </div>
    </div>
  );
}

function Avatar({
  src,
  name,
  size,
}: {
  src?: string;
  name: string;
  size: 'sm' | 'md';
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2) || '?';

  const className = `avatar avatar-${size}`;
  if (src) {
    return <img src={src} alt={name} className={className} />;
  }

  return (
    <div className={className} aria-hidden>
      {initials}
    </div>
  );
}
