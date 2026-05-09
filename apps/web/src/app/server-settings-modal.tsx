import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AutomodRule,
  Channel,
  ChannelPermissionOverwrite,
  Invite,
  Permission,
  Role,
  ServerAppearance,
} from '@current/types';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../lib/api';
import type { E2eeKeyState } from '../lib/e2ee';
import { LiquidGlassBackdrop } from './liquid-glass-backdrop';

type RegistrationMode = 'invite_only' | 'open_signup' | 'manual_approval';
type AuthMode = 'atproto' | 'lan';
type MediaBackend = 'local' | 's3';
type GifProvider = 'klipy' | 'giphy';
type GifFallbackProvider = 'none' | GifProvider;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LinkPolicy = 'allow' | 'members_only' | 'deny';
type ServerAssetKind = 'icon' | 'banner' | 'background';
type SettingsSection =
  | 'overview'
  | 'look'
  | 'roles'
  | 'members'
  | 'channels'
  | 'invites'
  | 'automod'
  | 'logs'
  | 'security'
  | 'encryption'
  | 'advanced'
  | 'ownership'
  | 'factory-reset';

interface MemberOption {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  roleIds: string[];
}

interface PageResponse<T> {
  items: T[];
  pageInfo: {
    hasMore: boolean;
    nextCursor?: string;
  };
}

interface PanelBackgroundAsset {
  attachmentId?: string;
  url?: string;
}

interface ServerAppearancePayload {
  background: PanelBackgroundAsset;
  panelColor: string;
  ownMessageColor: string;
  otherMessageColor: string;
}

interface RedactedConfig {
  server: {
    name: string;
    slug: string;
    host: string;
    port: number;
    publicUrl: string;
    registrationMode: RegistrationMode;
    tls: {
      enabled: boolean;
      certPath: string;
      keyPath: string;
    };
  };
  auth: {
    mode: AuthMode;
    atprotoClientId: string;
    redirectUri: string;
    lanRedirectBaseUrl: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    profileEndpoint: string;
    scope: string;
    allowDevLogin: boolean;
    cookieSecretConfigured: boolean;
  };
  storage: {
    sqlitePath: string;
    uploadDir: string;
    mediaBackend: MediaBackend;
    s3?: {
      endpoint: string;
      bucket: string;
      accessKeyIdConfigured: boolean;
      secretAccessKeyConfigured: boolean;
    };
  };
  media: {
    maxAttachmentBytes: number;
    allowedMimePrefixes: string[];
    gifProvider: GifProvider;
    gifFallbackProvider: GifFallbackProvider;
    klipyApiKeyConfigured: boolean;
    giphyApiKeyConfigured: boolean;
  };
  appearance: ServerAppearancePayload;
  moderation: {
    defaultSlowmodeSeconds: number;
    maxMentionsPerMessage: number;
    linkPolicy: LinkPolicy;
  };
  rtc: {
    listenIp: string;
    announcedIp: string;
    udpMinPort: number;
    udpMaxPort: number;
    workerCount: number;
    sessionTimeoutMs: number;
    turnUrls: string[];
    turnUsernameConfigured: boolean;
    turnCredentialConfigured: boolean;
  };
  observability: {
    metricsEnabled: boolean;
    logLevel: LogLevel;
  };
}

interface ServerSettingsPayload {
  server: {
    id?: string;
    name: string;
    slug: string;
    host: string;
    port: number;
    publicUrl: string;
    registrationMode: RegistrationMode;
    iconAttachmentId?: string;
    bannerAttachmentId?: string;
    iconUrl?: string;
    bannerUrl?: string;
    appearance: ServerAppearancePayload;
  };
  config: RedactedConfig;
  secrets: {
    klipyApiKeyConfigured: boolean;
    giphyApiKeyConfigured: boolean;
    cookieSecretConfigured: boolean;
    s3AccessKeyIdConfigured: boolean;
    s3SecretAccessKeyConfigured: boolean;
    turnUsernameConfigured: boolean;
    turnCredentialConfigured: boolean;
  };
  restartRequiredFieldPaths: string[];
  restartRequiredFields: string[];
  restartRequired: boolean;
  ownership: {
    ownerUserId?: string;
  };
}

interface SharedIpGroupPayload {
  ipAddress: string;
  userCount: number;
  lastSeenAt: string;
  totalHits: number;
  users: Array<{
    id: string;
    handle: string;
    displayName: string;
    avatarUrl?: string;
  }>;
}

interface ModerationLogEntryPayload {
  id: string;
  source: 'audit' | 'moderation';
  action: string;
  actorId?: string;
  targetId?: string;
  summary: string;
  createdAt: string;
  payload?: unknown;
}

interface SettingsDraft {
  server: {
    name: string;
    slug: string;
    host: string;
    port: number;
    publicUrl: string;
    registrationMode: RegistrationMode;
    iconAttachmentId: string;
    bannerAttachmentId: string;
    iconUrl: string;
    bannerUrl: string;
    tlsEnabled: boolean;
    tlsCertPath: string;
    tlsKeyPath: string;
  };
  auth: {
    mode: AuthMode;
    atprotoClientId: string;
    redirectUri: string;
    lanRedirectBaseUrl: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    profileEndpoint: string;
    scope: string;
    allowDevLogin: boolean;
    cookieSecret: string;
  };
  storage: {
    sqlitePath: string;
    uploadDir: string;
    mediaBackend: MediaBackend;
    s3Endpoint: string;
    s3Bucket: string;
    s3AccessKeyId: string;
    s3SecretAccessKey: string;
  };
  media: {
    maxAttachmentBytes: number;
    allowedMimePrefixesText: string;
    gifProvider: GifProvider;
    gifFallbackProvider: GifFallbackProvider;
    klipyApiKey: string;
    clearKlipyApiKey: boolean;
    giphyApiKey: string;
    clearGiphyApiKey: boolean;
  };
  appearance: {
    background: PanelBackgroundAsset;
    panelColor: string;
    ownMessageColor: string;
    otherMessageColor: string;
  };
  moderation: {
    defaultSlowmodeSeconds: number;
    maxMentionsPerMessage: number;
    linkPolicy: LinkPolicy;
  };
  rtc: {
    listenIp: string;
    announcedIp: string;
    udpMinPort: number;
    udpMaxPort: number;
    workerCount: number;
    sessionTimeoutMs: number;
    turnUrlsText: string;
    turnUsername: string;
    clearTurnUsername: boolean;
    turnCredential: string;
    clearTurnCredential: boolean;
  };
  observability: {
    metricsEnabled: boolean;
    logLevel: LogLevel;
  };
}

type E2eeSettingsState = E2eeKeyState | { status: 'loading' };

const PERMISSIONS: Permission[] = [
  'ADMINISTRATOR',
  'MANAGE_SERVER',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'MODERATE_MEMBERS',
  'MANAGE_MESSAGES',
  'SEND_MESSAGES',
  'CONNECT_VOICE',
  'SPEAK_VOICE',
  'ATTACH_FILES',
  'USE_GIFS',
];

const SECTION_DEFS: Array<{ id: SettingsSection; label: string; summary: string }> = [
  { id: 'overview', label: 'Overview', summary: 'Identity, access, and server branding.' },
  { id: 'look', label: 'Look', summary: 'Panel backgrounds and chat surface styling.' },
  { id: 'roles', label: 'Roles', summary: 'Create roles and tune server-wide permissions.' },
  { id: 'members', label: 'Members', summary: 'Assign roles and apply moderation actions.' },
  { id: 'channels', label: 'Channels', summary: 'Edit channels and permission overwrites.' },
  { id: 'invites', label: 'Invites', summary: 'Create and revoke invite links.' },
  { id: 'automod', label: 'Automod', summary: 'Manage automated moderation rules.' },
  { id: 'logs', label: 'Moderation Log', summary: 'Review audit and moderation activity.' },
  { id: 'security', label: 'Security', summary: 'Inspect shared IP and safety signals.' },
  { id: 'encryption', label: 'Encryption', summary: 'Manage browser-held room encryption keys.' },
  { id: 'advanced', label: 'Advanced Config', summary: 'Edit runtime and restart-scoped server config.' },
  { id: 'ownership', label: 'Ownership', summary: 'Transfer server ownership safely.' },
  { id: 'factory-reset', label: 'Factory Reset', summary: 'Erase this server and return to setup.' },
];

const FACTORY_RESET_CONFIRMATION = 'RESET CURRENT SERVER';
const DEFAULT_PANEL_COLOR = '#99b7c1';
const DEFAULT_OWN_MESSAGE_COLOR = '#343a44';
const DEFAULT_OTHER_MESSAGE_COLOR = '#2c323b';

type ColorChannel = 'r' | 'g' | 'b';
type AppearanceColorField = 'panelColor' | 'ownMessageColor' | 'otherMessageColor';

const DEFAULT_APPEARANCE_COLORS: Record<AppearanceColorField, string> = {
  panelColor: DEFAULT_PANEL_COLOR,
  ownMessageColor: DEFAULT_OWN_MESSAGE_COLOR,
  otherMessageColor: DEFAULT_OTHER_MESSAGE_COLOR,
};

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface HsvColor {
  h: number;
  s: number;
  v: number;
}

type EyeDropperConstructor = new () => {
  open: () => Promise<{ sRGBHex: string }>;
};

interface CurrentDesktopRuntime {
  platform?: string;
  isWayland?: boolean;
  disableNativeEyeDropper?: boolean;
  pickColorAtPoint?: (point: { x: number; y: number }) => Promise<string | null>;
}

function currentDesktopRuntime(): CurrentDesktopRuntime | undefined {
  return (window as Window & { currentDesktop?: CurrentDesktopRuntime }).currentDesktop;
}

function isLinuxElectronRenderer(): boolean {
  return /Electron/i.test(window.navigator.userAgent) && /Linux/i.test(window.navigator.userAgent);
}

function shouldDisableNativeEyeDropper(): boolean {
  const runtime = currentDesktopRuntime();
  return Boolean(runtime?.disableNativeEyeDropper || (runtime?.platform === 'linux' && runtime?.isWayland) || isLinuxElectronRenderer());
}

function getDesktopColorPicker(): CurrentDesktopRuntime['pickColorAtPoint'] | null {
  const picker = currentDesktopRuntime()?.pickColorAtPoint;
  return typeof picker === 'function' ? picker : null;
}

function canPickPanelColor(): boolean {
  return true;
}

function decodeCapturedColor(value: string | null): Promise<string | null> {
  if (!value) {
    return Promise.resolve(null);
  }

  const normalized = normalizePanelColorValue(value);
  if (normalized) {
    return Promise.resolve(normalized);
  }

  if (!value.startsWith('data:image/')) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
          resolve(null);
          return;
        }
        context.drawImage(image, 0, 0, 1, 1);
        const [r = 0, g = 0, b = 0, a = 255] = context.getImageData(0, 0, 1, 1).data;
        if (a === 0) {
          resolve(null);
          return;
        }
        resolve(rgbToHexColor({ r, g, b }));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = value;
  });
}

function parseCssRgbColor(value: string): string | null {
  const match = value.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (!match) {
    return null;
  }

  const [channelsText, alphaText] = match[1].split('/').map((part) => part.trim());
  const parts = channelsText.includes(',')
    ? channelsText.split(',').map((part) => part.trim())
    : channelsText.split(/\s+/).map((part) => part.trim());
  const alphaPart = alphaText ?? parts[3];
  const alpha = alphaPart === undefined ? 1 : Number(alphaPart.replace('%', '')) / (alphaPart.includes('%') ? 100 : 1);
  if (!Number.isFinite(alpha) || alpha <= 0.01) {
    return null;
  }

  const [r, g, b] = parts.slice(0, 3).map((part) => {
    const valuePart = part.trim();
    const parsed = Number(valuePart.replace('%', ''));
    return valuePart.includes('%') ? (parsed / 100) * 255 : parsed;
  });
  if (![r, g, b].every(Number.isFinite)) {
    return null;
  }
  return rgbToHexColor({ r, g, b });
}

function sampleElementColorAtPoint(point: { x: number; y: number }): string | null {
  const elements = document.elementsFromPoint(point.x, point.y) as HTMLElement[];
  for (const startElement of elements) {
    if (startElement.closest('.settings-app-eyedropper-target')) {
      continue;
    }

    let element: HTMLElement | null = startElement;
    while (element) {
      if (element.classList.contains('settings-app-eyedropper-target')) {
        break;
      }
      const sampled = parseCssRgbColor(window.getComputedStyle(element).backgroundColor);
      if (sampled) {
        return sampled;
      }
      element = element.parentElement;
    }
  }
  return null;
}

function normalizePanelColorValue(value: string): string | null {
  const trimmed = value.trim();
  const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#[0-9a-f]{6}$/i.test(prefixed) ? prefixed.toLowerCase() : null;
}

function isPanelColorDraftText(value: string): boolean {
  return /^#?[0-9a-f]{0,6}$/i.test(value.trim());
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hexToRgbColor(value: string): RgbColor | null {
  const normalized = normalizePanelColorValue(value);
  if (!normalized) {
    return null;
  }
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHexColor(color: RgbColor): string {
  const toHex = (channel: number) => clampNumber(Math.round(channel), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function rgbToHsvColor(color: RgbColor): HsvColor {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;

  if (delta !== 0) {
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * ((b - r) / delta + 2);
    } else {
      h = 60 * ((r - g) / delta + 4);
    }
  }

  return {
    h: h < 0 ? h + 360 : h,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

function hsvToRgbColor(color: HsvColor): RgbColor {
  const h = ((color.h % 360) + 360) % 360;
  const s = clampNumber(color.s, 0, 1);
  const v = clampNumber(color.v, 0, 1);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  return {
    r: (r + m) * 255,
    g: (g + m) * 255,
    b: (b + m) * 255,
  };
}

function getEyeDropperConstructor(): EyeDropperConstructor | null {
  if (typeof window === 'undefined') {
    return null;
  }
  if (shouldDisableNativeEyeDropper()) {
    return null;
  }
  const candidate = (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper;
  return typeof candidate === 'function' ? candidate : null;
}

function createDraft(payload: ServerSettingsPayload): SettingsDraft {
  return {
    server: {
      name: payload.server.name,
      slug: payload.server.slug,
      host: payload.server.host,
      port: payload.server.port,
      publicUrl: payload.server.publicUrl,
      registrationMode: payload.server.registrationMode,
      iconAttachmentId: payload.server.iconAttachmentId ?? '',
      bannerAttachmentId: payload.server.bannerAttachmentId ?? '',
      iconUrl: payload.server.iconUrl ?? '',
      bannerUrl: payload.server.bannerUrl ?? '',
      tlsEnabled: payload.config.server.tls.enabled,
      tlsCertPath: payload.config.server.tls.certPath,
      tlsKeyPath: payload.config.server.tls.keyPath,
    },
    auth: {
      mode: payload.config.auth.mode,
      atprotoClientId: payload.config.auth.atprotoClientId,
      redirectUri: payload.config.auth.redirectUri,
      lanRedirectBaseUrl: payload.config.auth.lanRedirectBaseUrl,
      authorizationEndpoint: payload.config.auth.authorizationEndpoint,
      tokenEndpoint: payload.config.auth.tokenEndpoint,
      profileEndpoint: payload.config.auth.profileEndpoint,
      scope: payload.config.auth.scope,
      allowDevLogin: payload.config.auth.allowDevLogin,
      cookieSecret: '',
    },
    storage: {
      sqlitePath: payload.config.storage.sqlitePath,
      uploadDir: payload.config.storage.uploadDir,
      mediaBackend: payload.config.storage.mediaBackend,
      s3Endpoint: payload.config.storage.s3?.endpoint ?? '',
      s3Bucket: payload.config.storage.s3?.bucket ?? '',
      s3AccessKeyId: '',
      s3SecretAccessKey: '',
    },
    media: {
      maxAttachmentBytes: payload.config.media.maxAttachmentBytes,
      allowedMimePrefixesText: payload.config.media.allowedMimePrefixes.join('\n'),
      gifProvider: payload.config.media.gifProvider,
      gifFallbackProvider: payload.config.media.gifFallbackProvider,
      klipyApiKey: '',
      clearKlipyApiKey: false,
      giphyApiKey: '',
      clearGiphyApiKey: false,
    },
    appearance: {
      background: payload.config.appearance.background,
      panelColor: payload.config.appearance.panelColor || '',
      ownMessageColor: payload.config.appearance.ownMessageColor || '',
      otherMessageColor: payload.config.appearance.otherMessageColor || '',
    },
    moderation: {
      defaultSlowmodeSeconds: payload.config.moderation.defaultSlowmodeSeconds,
      maxMentionsPerMessage: payload.config.moderation.maxMentionsPerMessage,
      linkPolicy: payload.config.moderation.linkPolicy,
    },
    rtc: {
      listenIp: payload.config.rtc.listenIp,
      announcedIp: payload.config.rtc.announcedIp,
      udpMinPort: payload.config.rtc.udpMinPort,
      udpMaxPort: payload.config.rtc.udpMaxPort,
      workerCount: payload.config.rtc.workerCount,
      sessionTimeoutMs: payload.config.rtc.sessionTimeoutMs,
      turnUrlsText: payload.config.rtc.turnUrls.join('\n'),
      turnUsername: '',
      clearTurnUsername: false,
      turnCredential: '',
      clearTurnCredential: false,
    },
    observability: {
      metricsEnabled: payload.config.observability.metricsEnabled,
      logLevel: payload.config.observability.logLevel,
    },
  };
}

function createAppearancePreview(appearance: SettingsDraft['appearance']): ServerAppearance {
  return {
    background: appearance.background,
    panelColor: appearance.panelColor || undefined,
    ownMessageColor: appearance.ownMessageColor || undefined,
    otherMessageColor: appearance.otherMessageColor || undefined,
  };
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatPermission(permission: Permission): string {
  return permission
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isRestartField(path: string, settings?: ServerSettingsPayload): boolean {
  return Boolean(settings?.restartRequiredFieldPaths.includes(path));
}

function buildSettingsPatch(draft: SettingsDraft) {
  return {
    server: {
      name: draft.server.name,
      slug: draft.server.slug,
      host: draft.server.host,
      port: Number(draft.server.port),
      publicUrl: draft.server.publicUrl,
      registrationMode: draft.server.registrationMode,
      iconAttachmentId: draft.server.iconAttachmentId || null,
      bannerAttachmentId: draft.server.bannerAttachmentId || null,
      tls: {
        enabled: draft.server.tlsEnabled,
        certPath: draft.server.tlsCertPath,
        keyPath: draft.server.tlsKeyPath,
      },
    },
    auth: {
      mode: draft.auth.mode,
      atprotoClientId: draft.auth.atprotoClientId,
      redirectUri: draft.auth.redirectUri,
      lanRedirectBaseUrl: draft.auth.lanRedirectBaseUrl,
      authorizationEndpoint: draft.auth.authorizationEndpoint,
      tokenEndpoint: draft.auth.tokenEndpoint,
      profileEndpoint: draft.auth.profileEndpoint,
      scope: draft.auth.scope,
      allowDevLogin: draft.auth.allowDevLogin,
      ...(draft.auth.cookieSecret.trim() ? { cookieSecret: draft.auth.cookieSecret.trim() } : {}),
    },
    storage: {
      sqlitePath: draft.storage.sqlitePath,
      uploadDir: draft.storage.uploadDir,
      mediaBackend: draft.storage.mediaBackend,
      ...(draft.storage.mediaBackend === 's3' ||
      draft.storage.s3Endpoint ||
      draft.storage.s3Bucket ||
      draft.storage.s3AccessKeyId ||
      draft.storage.s3SecretAccessKey
        ? {
            s3: {
              endpoint: draft.storage.s3Endpoint,
              bucket: draft.storage.s3Bucket,
              ...(draft.storage.s3AccessKeyId.trim()
                ? { accessKeyId: draft.storage.s3AccessKeyId.trim() }
                : {}),
              ...(draft.storage.s3SecretAccessKey.trim()
                ? { secretAccessKey: draft.storage.s3SecretAccessKey.trim() }
                : {}),
            },
          }
        : {}),
    },
    media: {
      maxAttachmentBytes: Number(draft.media.maxAttachmentBytes),
      allowedMimePrefixes: parseList(draft.media.allowedMimePrefixesText),
      gifProvider: draft.media.gifProvider,
      gifFallbackProvider: draft.media.gifFallbackProvider,
      ...(draft.media.clearKlipyApiKey
        ? { clearKlipyApiKey: true }
        : draft.media.klipyApiKey.trim()
          ? { klipyApiKey: draft.media.klipyApiKey.trim() }
          : {}),
      ...(draft.media.clearGiphyApiKey
        ? { clearGiphyApiKey: true }
        : draft.media.giphyApiKey.trim()
          ? { giphyApiKey: draft.media.giphyApiKey.trim() }
          : {}),
    },
    appearance: {
      backgroundAttachmentId: draft.appearance.background.attachmentId || null,
      panelColor: draft.appearance.panelColor || null,
      ownMessageColor: draft.appearance.ownMessageColor || null,
      otherMessageColor: draft.appearance.otherMessageColor || null,
    },
    moderation: {
      defaultSlowmodeSeconds: Number(draft.moderation.defaultSlowmodeSeconds),
      maxMentionsPerMessage: Number(draft.moderation.maxMentionsPerMessage),
      linkPolicy: draft.moderation.linkPolicy,
    },
    rtc: {
      listenIp: draft.rtc.listenIp,
      announcedIp: draft.rtc.announcedIp,
      udpMinPort: Number(draft.rtc.udpMinPort),
      udpMaxPort: Number(draft.rtc.udpMaxPort),
      workerCount: Number(draft.rtc.workerCount),
      sessionTimeoutMs: Number(draft.rtc.sessionTimeoutMs),
      turnUrls: parseList(draft.rtc.turnUrlsText),
      ...(draft.rtc.clearTurnUsername
        ? { clearTurnUsername: true }
        : draft.rtc.turnUsername.trim()
          ? { turnUsername: draft.rtc.turnUsername.trim() }
          : {}),
      ...(draft.rtc.clearTurnCredential
        ? { clearTurnCredential: true }
        : draft.rtc.turnCredential.trim()
          ? { turnCredential: draft.rtc.turnCredential.trim() }
          : {}),
    },
    observability: {
      metricsEnabled: draft.observability.metricsEnabled,
      logLevel: draft.observability.logLevel,
    },
  };
}

async function uploadServerAsset(kind: ServerAssetKind, file: File) {
  const form = new FormData();
  form.append('file', file, file.name);

  const response = await fetch(`/api/v1/admin/server-assets?kind=${kind}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string | { message?: string } } | null;
    const message = typeof payload?.error === 'string'
      ? payload.error
      : payload?.error?.message ?? `Upload failed with ${response.status}`;
    throw new Error(message);
  }

  return response.json() as Promise<{ id: string; kind: ServerAssetKind; url: string }>;
}

function SettingBadge({ path, settings }: { path: string; settings?: ServerSettingsPayload }) {
  if (!isRestartField(path, settings)) {
    return null;
  }
  return <span className="settings-restart-badge">Restart</span>;
}

function PanelUploadIcon() {
  return (
    <svg className="look-upload-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path d="M14 34h20a8 8 0 0 0 1.5-15.9A12 12 0 0 0 12.2 21 6.5 6.5 0 0 0 14 34Z" />
      <path d="M24 31V18" />
      <path d="m18.5 23.5 5.5-5.5 5.5 5.5" />
    </svg>
  );
}

function EyeDropperIcon() {
  return (
    <svg className="settings-panel-eyedropper-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m14.5 4.5 5 5" />
      <path d="M13 6 5.5 13.5a4 4 0 0 0-1 2l-.5 3 3-.5a4 4 0 0 0 2-1L16.5 10" />
      <path d="m12 8 4-4a2.1 2.1 0 0 1 3 0l1 1a2.1 2.1 0 0 1 0 3l-4 4" />
    </svg>
  );
}

export function ServerSettingsModal({
  open,
  onClose,
  canManageServer,
  members,
  e2eeState,
  onCopyE2eeKey,
  onImportE2eeKey,
  onAppearancePreview,
  overLight = false,
}: {
  open: boolean;
  onClose: () => void;
  canManageServer: boolean;
  members: MemberOption[];
  e2eeState: E2eeSettingsState;
  onCopyE2eeKey: () => void;
  onImportE2eeKey: () => void;
  onAppearancePreview?: (appearance: ServerAppearance | null) => void;
  overLight?: boolean;
}) {
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<SettingsSection>('overview');
  const [settingsSearch, setSettingsSearch] = useState('');
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [savedDraft, setSavedDraft] = useState<SettingsDraft | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [roleDraft, setRoleDraft] = useState<{ name: string; color: string; position: number; permissions: Permission[] } | null>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [memberRoleDraft, setMemberRoleDraft] = useState<string[]>([]);
  const [moderationType, setModerationType] = useState<'warn' | 'mute' | 'timeout' | 'kick' | 'ban'>('warn');
  const [moderationReason, setModerationReason] = useState('');
  const [selectedChannelId, setSelectedChannelId] = useState('');
  const [channelDraft, setChannelDraft] = useState<{ name: string; type: Channel['type']; topic: string; slowmodeSeconds: number; locked: boolean } | null>(null);
  const [overwriteDrafts, setOverwriteDrafts] = useState<ChannelPermissionOverwrite[]>([]);
  const [overwriteTarget, setOverwriteTarget] = useState('');
  const [inviteMaxUses, setInviteMaxUses] = useState('');
  const [automodName, setAutomodName] = useState('');
  const [automodType, setAutomodType] = useState<AutomodRule['type']>('keyword');
  const [automodPayload, setAutomodPayload] = useState('{"keywords":["example"]}');
  const [selectedOwnerId, setSelectedOwnerId] = useState('');
  const [transferNotice, setTransferNotice] = useState('');
  const [pendingTransferTargetId, setPendingTransferTargetId] = useState<string | null>(null);
  const [factoryResetConfirmation, setFactoryResetConfirmation] = useState('');
  const [factoryResetConfirmOpen, setFactoryResetConfirmOpen] = useState(false);
  const [activeLookDrop, setActiveLookDrop] = useState(false);
  const [appearanceColorText, setAppearanceColorText] =
    useState<Record<AppearanceColorField, string>>(DEFAULT_APPEARANCE_COLORS);
  const [openAppearanceColorPicker, setOpenAppearanceColorPicker] = useState<AppearanceColorField | null>(null);
  const [panelEyeDropperActive, setPanelEyeDropperActive] = useState(false);
  const [panelEyeDropperSampling, setPanelEyeDropperSampling] = useState(false);
  const ignoreSettingsBackdropCloseUntilRef = useRef(0);
  const panelEyeDropperActiveRef = useRef(false);
  const panelColorSamplingRef = useRef(false);
  const panelColorSamplingFieldRef = useRef<AppearanceColorField>('panelColor');
  const samplePanelColorAtPointRef = useRef<(point: { x: number; y: number }) => void>(() => undefined);

  const settingsQuery = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => apiGet<ServerSettingsPayload>('/api/v1/admin/settings'),
    enabled: open && canManageServer,
  });

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: () => apiGet<Role[]>('/api/v1/roles'),
    enabled: open && canManageServer,
  });

  const channelsQuery = useQuery({
    queryKey: ['channels', 'admin-settings'],
    queryFn: () => apiGet<PageResponse<Channel>>('/api/v1/channels?limit=200'),
    enabled: open && canManageServer,
  });

  const invitesQuery = useQuery({
    queryKey: ['admin-invites'],
    queryFn: () => apiGet<Invite[]>('/api/v1/invites'),
    enabled: open && canManageServer && activeSection === 'invites',
  });

  const automodQuery = useQuery({
    queryKey: ['admin-automod-rules'],
    queryFn: () => apiGet<AutomodRule[]>('/api/v1/automod/rules'),
    enabled: open && canManageServer && activeSection === 'automod',
  });

  const moderationLogsQuery = useQuery({
    queryKey: ['admin-moderation-logs'],
    queryFn: () => apiGet<ModerationLogEntryPayload[]>('/api/v1/admin/moderation/logs?limit=150'),
    enabled: open && canManageServer && activeSection === 'logs',
    refetchInterval: 15_000,
  });

  const sharedIpsQuery = useQuery({
    queryKey: ['admin-shared-ips'],
    queryFn: () => apiGet<SharedIpGroupPayload[]>('/api/v1/admin/shared-ips'),
    enabled: open && canManageServer && activeSection === 'security',
    refetchInterval: 20_000,
  });

  const selectedChannel = useMemo(
    () => (channelsQuery.data?.items ?? []).find((channel) => channel.id === selectedChannelId),
    [channelsQuery.data?.items, selectedChannelId],
  );

  const overwritesQuery = useQuery({
    queryKey: ['admin-channel-overwrites', selectedChannelId],
    queryFn: () => apiGet<ChannelPermissionOverwrite[]>(`/api/v1/admin/channels/${selectedChannelId}/overwrites`),
    enabled: open && canManageServer && activeSection === 'channels' && Boolean(selectedChannelId),
  });

  const roles = useMemo(
    () => [...(rolesQuery.data ?? [])].sort((a, b) => b.position - a.position || a.name.localeCompare(b.name)),
    [rolesQuery.data],
  );

  const channels = channelsQuery.data?.items ?? [];
  const membersById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const rolesById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);
  const ownerUserId = settingsQuery.data?.ownership.ownerUserId ?? '';
  const owner = ownerUserId ? membersById.get(ownerUserId) : undefined;
  const transferCandidates = members.filter((member) => member.id !== ownerUserId);
  const selectedTransferTarget = selectedOwnerId ? membersById.get(selectedOwnerId) : undefined;
  const pendingTransferTarget = pendingTransferTargetId ? membersById.get(pendingTransferTargetId) : undefined;
  const selectedMember = selectedMemberId ? membersById.get(selectedMemberId) : undefined;
  const selectedRole = selectedRoleId ? rolesById.get(selectedRoleId) : undefined;
  const filteredMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) {
      return members;
    }
    return members.filter((member) =>
      `${member.displayName} ${member.handle}`.toLowerCase().includes(query),
    );
  }, [memberSearch, members]);
  const dirty = Boolean(draft && savedDraft && JSON.stringify(draft) !== JSON.stringify(savedDraft));
  const activeCopy = SECTION_DEFS.find((section) => section.id === activeSection) ?? SECTION_DEFS[0];
  const visibleSections = SECTION_DEFS.filter((section) => {
    const query = settingsSearch.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return `${section.label} ${section.summary}`.toLowerCase().includes(query);
  });

  useEffect(() => {
    if (!open) {
      setActiveSection('overview');
      setSettingsSearch('');
      setTransferNotice('');
      setPendingTransferTargetId(null);
      setFactoryResetConfirmation('');
      setFactoryResetConfirmOpen(false);
      setActiveLookDrop(false);
      setOpenAppearanceColorPicker(null);
      setPanelEyeDropperActive(false);
      setPanelEyeDropperSampling(false);
      panelEyeDropperActiveRef.current = false;
      panelColorSamplingRef.current = false;
      ignoreSettingsBackdropCloseUntilRef.current = 0;
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (panelEyeDropperActive) {
          setPanelEyeDropperActive(false);
          return;
        }
        if (openAppearanceColorPicker) {
          setOpenAppearanceColorPicker(null);
          return;
        }
        if (factoryResetConfirmOpen) {
          setFactoryResetConfirmOpen(false);
          return;
        }
        if (pendingTransferTargetId) {
          setPendingTransferTargetId(null);
          return;
        }
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [factoryResetConfirmOpen, onClose, open, openAppearanceColorPicker, panelEyeDropperActive, pendingTransferTargetId]);

  useEffect(() => {
    panelEyeDropperActiveRef.current = panelEyeDropperActive;
  }, [panelEyeDropperActive]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const eventOptions = { capture: true } as const;
    const isEyeDropperOverlayTarget = (event: Event) =>
      event.target instanceof Element && Boolean(event.target.closest('.settings-app-eyedropper-target'));
    const stopPickerEvent = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const isPickerInteractionLocked = () =>
      panelEyeDropperActiveRef.current ||
      panelColorSamplingRef.current ||
      Date.now() < ignoreSettingsBackdropCloseUntilRef.current;
    const handleLockedPointerEvent = (event: Event) => {
      if (!isPickerInteractionLocked()) {
        return;
      }

      if (panelEyeDropperActiveRef.current && isEyeDropperOverlayTarget(event)) {
        return;
      }

      stopPickerEvent(event);

      if (!panelEyeDropperActiveRef.current) {
        return;
      }

      const hasPointerEvent = typeof PointerEvent !== 'undefined';
      if (event.type === 'pointerdown' && hasPointerEvent && event instanceof PointerEvent && event.isPrimary !== false) {
        samplePanelColorAtPointRef.current({ x: event.clientX, y: event.clientY });
        return;
      }

      if (event.type === 'mousedown' && !hasPointerEvent && event instanceof MouseEvent) {
        samplePanelColorAtPointRef.current({ x: event.clientX, y: event.clientY });
      }
    };
    const handleLockedKeyDown = (event: KeyboardEvent) => {
      if (!isPickerInteractionLocked()) {
        return;
      }

      stopPickerEvent(event);
      if (panelEyeDropperActiveRef.current && event.key === 'Escape') {
        panelEyeDropperActiveRef.current = false;
        panelColorSamplingRef.current = false;
        ignoreSettingsBackdropCloseUntilRef.current = Date.now() + 250;
        setPanelEyeDropperActive(false);
        setOpenAppearanceColorPicker(panelColorSamplingFieldRef.current);
      }
    };

    const eventNames = [
      'pointerdown',
      'pointerup',
      'pointercancel',
      'mousedown',
      'mouseup',
      'click',
      'dblclick',
      'auxclick',
      'contextmenu',
      'touchstart',
      'touchend',
      'submit',
    ];
    for (const eventName of eventNames) {
      window.addEventListener(eventName, handleLockedPointerEvent, eventOptions);
    }
    window.addEventListener('keydown', handleLockedKeyDown, eventOptions);

    return () => {
      for (const eventName of eventNames) {
        window.removeEventListener(eventName, handleLockedPointerEvent, eventOptions);
      }
      window.removeEventListener('keydown', handleLockedKeyDown, eventOptions);
    };
  }, [open]);

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }
    const next = createDraft(settingsQuery.data);
    setDraft(next);
    setSavedDraft(next);
    setAppearanceColorText({
      panelColor: next.appearance.panelColor || DEFAULT_PANEL_COLOR,
      ownMessageColor: next.appearance.ownMessageColor || DEFAULT_OWN_MESSAGE_COLOR,
      otherMessageColor: next.appearance.otherMessageColor || DEFAULT_OTHER_MESSAGE_COLOR,
    });
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!open || !draft) {
      return;
    }
    onAppearancePreview?.(createAppearancePreview(draft.appearance));
  }, [draft?.appearance, onAppearancePreview, open]);

  useEffect(() => {
    if (!open) {
      onAppearancePreview?.(null);
    }
  }, [onAppearancePreview, open]);

  useEffect(() => () => {
    onAppearancePreview?.(null);
  }, [onAppearancePreview]);

  useEffect(() => {
    if (!selectedOwnerId || selectedOwnerId === ownerUserId || !membersById.has(selectedOwnerId)) {
      setSelectedOwnerId(transferCandidates[0]?.id ?? '');
    }
  }, [membersById, ownerUserId, selectedOwnerId, transferCandidates]);

  useEffect(() => {
    if (!selectedRoleId && roles[0]) {
      setSelectedRoleId(roles[0].id);
    }
  }, [roles, selectedRoleId]);

  useEffect(() => {
    if (!selectedRole) {
      setRoleDraft(null);
      return;
    }
    setRoleDraft({
      name: selectedRole.name,
      color: selectedRole.color,
      position: selectedRole.position,
      permissions: selectedRole.permissions,
    });
  }, [selectedRole]);

  useEffect(() => {
    if (!selectedMemberId && members[0]) {
      setSelectedMemberId(members[0].id);
    }
  }, [members, selectedMemberId]);

  useEffect(() => {
    if (selectedMember) {
      setMemberRoleDraft(selectedMember.roleIds);
    }
  }, [selectedMember]);

  useEffect(() => {
    if (!selectedChannelId && channels[0]) {
      setSelectedChannelId(channels[0].id);
    }
  }, [channels, selectedChannelId]);

  useEffect(() => {
    if (!selectedChannel) {
      setChannelDraft(null);
      return;
    }
    setChannelDraft({
      name: selectedChannel.name,
      type: selectedChannel.type,
      topic: selectedChannel.topic ?? '',
      slowmodeSeconds: selectedChannel.slowmodeSeconds,
      locked: selectedChannel.locked,
    });
  }, [selectedChannel]);

  useEffect(() => {
    setOverwriteDrafts(overwritesQuery.data ?? []);
  }, [overwritesQuery.data]);

  const saveSettingsMutation = useMutation({
    mutationFn: () => {
      if (!draft) {
        throw new Error('Settings are still loading.');
      }
      return apiPatch<ServerSettingsPayload>('/api/v1/admin/settings', buildSettingsPatch(draft));
    },
    onSuccess: async (payload) => {
      const next = createDraft(payload);
      const nextAppearance = createAppearancePreview(next.appearance);
      setDraft(next);
      setSavedDraft(next);
      onAppearancePreview?.(nextAppearance);
      queryClient.setQueryData<{ server?: { appearance?: ServerAppearance } } | undefined>(
        ['session'],
        (current) => current
          ? {
              ...current,
              server: current.server
                ? {
                    ...current.server,
                    appearance: nextAppearance,
                  }
                : current.server,
            }
          : current,
      );
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      await queryClient.invalidateQueries({ queryKey: ['setup-status'] });
    },
  });

  const uploadAssetMutation = useMutation({
    mutationFn: ({ kind, file }: { kind: ServerAssetKind; file: File }) => uploadServerAsset(kind, file),
    onSuccess: (asset) => {
      setActiveLookDrop(false);
      setDraft((current) => {
        if (!current) {
          return current;
        }
        if (asset.kind === 'background') {
          return {
            ...current,
            appearance: {
              ...current.appearance,
              background: {
                attachmentId: asset.id,
                url: asset.url,
              },
            },
          };
        }
        return {
          ...current,
          server: {
            ...current.server,
            [asset.kind === 'icon' ? 'iconAttachmentId' : 'bannerAttachmentId']: asset.id,
            [asset.kind === 'icon' ? 'iconUrl' : 'bannerUrl']: asset.url,
          },
        };
      });
    },
    onError: () => {
      setActiveLookDrop(false);
    },
  });

  const createRoleMutation = useMutation({
    mutationFn: () =>
      apiPost<Role>('/api/v1/roles', {
        name: 'New Role',
        color: '#6bd7ff',
        position: roles[0] ? roles[0].position + 1 : 1,
        permissions: ['SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE'] satisfies Permission[],
      }),
    onSuccess: async (role) => {
      setSelectedRoleId(role.id);
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
  });

  const saveRoleMutation = useMutation({
    mutationFn: () => {
      if (!selectedRole || !roleDraft) {
        throw new Error('Select a role first.');
      }
      return apiPatch<Role>(`/api/v1/roles/${selectedRole.id}`, roleDraft);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
  });

  const deleteRoleMutation = useMutation({
    mutationFn: (roleId: string) => apiDelete(`/api/v1/roles/${roleId}`),
    onSuccess: async () => {
      setSelectedRoleId('');
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      await queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });

  const saveMemberRolesMutation = useMutation({
    mutationFn: () => {
      if (!selectedMember) {
        throw new Error('Select a member first.');
      }
      return apiPatch<MemberOption>(`/api/v1/admin/members/${selectedMember.id}/roles`, {
        roleIds: memberRoleDraft,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['members'] });
      await queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  });

  const moderationMutation = useMutation({
    mutationFn: () => {
      if (!selectedMember) {
        throw new Error('Select a member first.');
      }
      return apiPost('/api/v1/moderation/actions', {
        targetUserId: selectedMember.id,
        type: moderationType,
        reason: moderationReason.trim() || undefined,
      });
    },
    onSuccess: async () => {
      setModerationReason('');
      await queryClient.invalidateQueries({ queryKey: ['admin-moderation-logs'] });
      await queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });

  const saveChannelMutation = useMutation({
    mutationFn: () => {
      if (!selectedChannel || !channelDraft) {
        throw new Error('Select a channel first.');
      }
      return apiPatch<Channel>(`/api/v1/channels/${selectedChannel.id}`, channelDraft);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['channels'] });
      await queryClient.invalidateQueries({ queryKey: ['channels', 'admin-settings'] });
    },
  });

  const saveOverwritesMutation = useMutation({
    mutationFn: () => {
      if (!selectedChannel) {
        throw new Error('Select a channel first.');
      }
      return apiPut<ChannelPermissionOverwrite[]>(
        `/api/v1/admin/channels/${selectedChannel.id}/overwrites`,
        { overwrites: overwriteDrafts },
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-channel-overwrites', selectedChannelId] });
    },
  });

  const createInviteMutation = useMutation({
    mutationFn: () =>
      apiPost<Invite>('/api/v1/invites', {
        maxUses: inviteMaxUses ? Number(inviteMaxUses) : undefined,
      }),
    onSuccess: async () => {
      setInviteMaxUses('');
      await queryClient.invalidateQueries({ queryKey: ['admin-invites'] });
    },
  });

  const deleteInviteMutation = useMutation({
    mutationFn: (code: string) => apiDelete(`/api/v1/invites/${code}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-invites'] });
    },
  });

  const createAutomodMutation = useMutation({
    mutationFn: () =>
      apiPost<AutomodRule>('/api/v1/automod/rules', {
        name: automodName.trim() || 'New automod rule',
        type: automodType,
        enabled: true,
        payload: JSON.parse(automodPayload) as Record<string, unknown>,
      }),
    onSuccess: async () => {
      setAutomodName('');
      await queryClient.invalidateQueries({ queryKey: ['admin-automod-rules'] });
    },
  });

  const patchAutomodMutation = useMutation({
    mutationFn: ({ ruleId, patch }: { ruleId: string; patch: Partial<AutomodRule> }) =>
      apiPatch<AutomodRule>(`/api/v1/automod/rules/${ruleId}`, patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-automod-rules'] });
    },
  });

  const deleteAutomodMutation = useMutation({
    mutationFn: (ruleId: string) => apiDelete(`/api/v1/automod/rules/${ruleId}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-automod-rules'] });
    },
  });

  const transferOwnershipMutation = useMutation({
    mutationFn: (targetUserId: string) =>
      apiPost<{ ownerUserId: string }>('/api/v1/admin/ownership/transfer', {
        targetUserId,
      }),
    onSuccess: async (payload) => {
      const newOwner = membersById.get(payload.ownerUserId);
      setTransferNotice(
        newOwner
          ? `Ownership transferred to ${newOwner.displayName} (@${newOwner.handle}).`
          : 'Ownership transferred successfully.',
      );
      setPendingTransferTargetId(null);
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      await queryClient.invalidateQueries({ queryKey: ['members'] });
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-moderation-logs'] });
    },
  });

  const claimHostOwnershipMutation = useMutation({
    mutationFn: () => apiPost<{ ownerUserId: string }>('/api/v1/admin/ownership/claim-host'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['session'] });
      await queryClient.invalidateQueries({ queryKey: ['roles'] });
      await queryClient.invalidateQueries({ queryKey: ['members'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
    },
  });

  const factoryResetMutation = useMutation({
    mutationFn: () =>
      apiPost<{ configured: false; resetAt: string; attachmentFilesDeleted: number }>(
        '/api/v1/admin/settings/factory-reset',
        {
          confirmation: factoryResetConfirmation,
        },
      ),
    onSuccess: () => {
      setFactoryResetConfirmOpen(false);
      setFactoryResetConfirmation('');
      queryClient.clear();
      window.location.assign('/');
    },
  });

  if (!open) {
    return null;
  }

  const updateDraft = <TSection extends keyof SettingsDraft>(
    section: TSection,
    patch: Partial<SettingsDraft[TSection]>,
  ) => {
    setDraft((current) => current ? {
      ...current,
      [section]: {
        ...current[section],
        ...patch,
      },
    } : current);
  };

  const updateLookBackground = (asset: PanelBackgroundAsset) => {
    setDraft((current) => current ? {
      ...current,
      appearance: {
        ...current.appearance,
        background: asset,
      },
    } : current);
  };

  const updateLookAppearanceColor = (field: AppearanceColorField, color: string) => {
    setDraft((current) => current ? {
      ...current,
      appearance: {
        ...current.appearance,
        [field]: color,
      },
    } : current);
  };

  const applyLookAppearanceColor = (field: AppearanceColorField, color: string) => {
    const normalized = normalizePanelColorValue(color);
    if (!normalized) {
      return;
    }
    setAppearanceColorText((current) => ({
      ...current,
      [field]: normalized,
    }));
    updateLookAppearanceColor(field, normalized);
  };

  const handleAppearanceColorTextChange = (field: AppearanceColorField, value: string) => {
    if (!isPanelColorDraftText(value)) {
      return;
    }

    setAppearanceColorText((current) => ({
      ...current,
      [field]: value,
    }));
    if (value.trim() === '') {
      updateLookAppearanceColor(field, '');
      return;
    }

    const normalized = normalizePanelColorValue(value);
    if (normalized) {
      updateLookAppearanceColor(field, normalized);
    }
  };

  const handlePanelEyeDropper = (field: AppearanceColorField) => {
    const desktopPicker = getDesktopColorPicker();
    const EyeDropper = desktopPicker || shouldDisableNativeEyeDropper() ? null : getEyeDropperConstructor();
    if (EyeDropper) {
      void new EyeDropper().open().then((result) => {
        const sampled = normalizePanelColorValue(result.sRGBHex);
        if (sampled) {
          applyLookAppearanceColor(field, sampled);
        }
      }).catch(() => {
        setOpenAppearanceColorPicker(field);
      });
      return;
    }

    panelColorSamplingFieldRef.current = field;
    panelEyeDropperActiveRef.current = true;
    panelColorSamplingRef.current = false;
    ignoreSettingsBackdropCloseUntilRef.current = 0;
    setPanelEyeDropperActive(true);
    setOpenAppearanceColorPicker(null);
  };

  const hidePanelColorPickChromeForSampling = () => {
    const changedElements: Array<{
      element: HTMLElement;
      visibility: string;
      pointerEvents: string;
    }> = [];
    const hideElement = (element: HTMLElement | null) => {
      if (!element) {
        return;
      }
      changedElements.push({
        element,
        visibility: element.style.visibility,
        pointerEvents: element.style.pointerEvents,
      });
      element.style.visibility = 'hidden';
      element.style.pointerEvents = 'none';
    };
    const overlay = document.querySelector<HTMLElement>('.settings-app-eyedropper-target');
    hideElement(overlay);

    return () => {
      for (const changed of changedElements.reverse()) {
        changed.element.style.visibility = changed.visibility;
        changed.element.style.pointerEvents = changed.pointerEvents;
      }
    };
  };

  const finishPanelColorPick = () => {
    panelColorSamplingRef.current = false;
    ignoreSettingsBackdropCloseUntilRef.current = Date.now() + 750;
    setPanelEyeDropperSampling(false);
    setOpenAppearanceColorPicker(panelColorSamplingFieldRef.current);
  };

  const samplePanelColorAtPoint = (point: { x: number; y: number }) => {
    panelEyeDropperActiveRef.current = false;
    panelColorSamplingRef.current = true;
    ignoreSettingsBackdropCloseUntilRef.current = Date.now() + 2000;
    const restoreColorPickChrome = hidePanelColorPickChromeForSampling();
    setPanelEyeDropperSampling(true);
    setPanelEyeDropperActive(false);

    const picker = getDesktopColorPicker();
    if (!picker) {
      const sampled = sampleElementColorAtPoint(point);
      if (sampled) {
        applyLookAppearanceColor(panelColorSamplingFieldRef.current, sampled);
      }
      restoreColorPickChrome();
      finishPanelColorPick();
      return;
    }

    void new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      .then(() => picker(point))
      .then(decodeCapturedColor)
      .then((sampled) => {
        if (sampled) {
          applyLookAppearanceColor(panelColorSamplingFieldRef.current, sampled);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        restoreColorPickChrome();
        finishPanelColorPick();
      });
  };
  samplePanelColorAtPointRef.current = samplePanelColorAtPoint;

  const samplePanelColorFromPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    samplePanelColorAtPoint({ x: event.clientX, y: event.clientY });
  };

  const handleSettingsBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (Date.now() < ignoreSettingsBackdropCloseUntilRef.current) {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      ignoreSettingsBackdropCloseUntilRef.current = 0;
      return;
    }

    onClose();
  };

  const uploadLookBackgroundFile = (file?: File) => {
    if (!file || !file.type.startsWith('image/')) {
      setActiveLookDrop(false);
      return;
    }
    uploadAssetMutation.mutate({ kind: 'background', file });
  };

  const handleLookDragOver = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setActiveLookDrop(true);
  };

  const handleLookDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    uploadLookBackgroundFile(event.dataTransfer.files[0]);
  };

  const toggleRolePermission = (permission: Permission) => {
    setRoleDraft((current) => {
      if (!current) {
        return current;
      }
      const permissions = current.permissions.includes(permission)
        ? current.permissions.filter((entry) => entry !== permission)
        : [...current.permissions, permission];
      return {
        ...current,
        permissions,
      };
    });
  };

  const toggleMemberRole = (roleId: string) => {
    setMemberRoleDraft((current) =>
      current.includes(roleId) ? current.filter((id) => id !== roleId) : [...current, roleId],
    );
  };

  const permissionState = (overwrite: ChannelPermissionOverwrite, permission: Permission) => {
    if (overwrite.allow.includes(permission)) {
      return 'allow';
    }
    if (overwrite.deny.includes(permission)) {
      return 'deny';
    }
    return 'inherit';
  };

  const setOverwritePermission = (
    overwriteIndex: number,
    permission: Permission,
    state: 'inherit' | 'allow' | 'deny',
  ) => {
    setOverwriteDrafts((current) =>
      current.map((overwrite, index) => {
        if (index !== overwriteIndex) {
          return overwrite;
        }
        return {
          ...overwrite,
          allow:
            state === 'allow'
              ? [...new Set([...overwrite.allow.filter((entry) => entry !== permission), permission])]
              : overwrite.allow.filter((entry) => entry !== permission),
          deny:
            state === 'deny'
              ? [...new Set([...overwrite.deny.filter((entry) => entry !== permission), permission])]
              : overwrite.deny.filter((entry) => entry !== permission),
        };
      }),
    );
  };

  const addOverwrite = () => {
    if (!overwriteTarget) {
      return;
    }
    const [targetType, targetId] = overwriteTarget.split(':') as ['role' | 'user', string];
    if (!targetType || !targetId || overwriteDrafts.some((overwrite) => overwrite.targetType === targetType && overwrite.targetId === targetId)) {
      return;
    }
    setOverwriteDrafts((current) => [
      ...current,
      {
        id: `draft-${targetType}-${targetId}`,
        channelId: selectedChannelId,
        targetType,
        targetId,
        allow: [],
        deny: [],
      },
    ]);
    setOverwriteTarget('');
  };

  const removeOverwrite = (index: number) => {
    setOverwriteDrafts((current) => current.filter((_, entryIndex) => entryIndex !== index));
  };

  const confirmOwnershipTransfer = () => {
    if (pendingTransferTarget) {
      transferOwnershipMutation.mutate(pendingTransferTarget.id);
    }
  };

  const renderFieldLabel = (label: string, path?: string) => (
    <span className="settings-field-label">
      {label}
      {path && <SettingBadge path={path} settings={settingsQuery.data} />}
    </span>
  );

  const renderOverview = () => {
    if (!draft) {
      return <div className="settings-empty-inline">Loading server settings...</div>;
    }
    return (
      <div className="settings-panel-grid">
        <section className="settings-panel wide">
          <div className="settings-banner-preview" style={draft.server.bannerUrl ? { backgroundImage: `url(${draft.server.bannerUrl})` } : undefined}>
          </div>
          <div className="settings-brand-row">
            <div className="settings-icon-preview">
              {draft.server.iconUrl ? <img src={draft.server.iconUrl} alt="" /> : draft.server.name.charAt(0).toUpperCase()}
            </div>
            <label className="settings-upload-button">
              Upload Icon
              <input
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    uploadAssetMutation.mutate({ kind: 'icon', file });
                  }
                }}
              />
            </label>
          </div>
        </section>

        <section className="settings-panel">
          <h3>Server Identity</h3>
          <label>
            {renderFieldLabel('Server name')}
            <input value={draft.server.name} onChange={(event) => updateDraft('server', { name: event.target.value })} />
          </label>
          <label>
            {renderFieldLabel('Slug')}
            <input value={draft.server.slug} onChange={(event) => updateDraft('server', { slug: event.target.value })} />
          </label>
          <label>
            {renderFieldLabel('Public URL')}
            <input value={draft.server.publicUrl} onChange={(event) => updateDraft('server', { publicUrl: event.target.value })} />
          </label>
        </section>

        <section className="settings-panel">
          <h3>Access</h3>
          <label>
            {renderFieldLabel('Registration mode')}
            <select value={draft.server.registrationMode} onChange={(event) => updateDraft('server', { registrationMode: event.target.value as RegistrationMode })}>
              <option value="invite_only">Invite only</option>
              <option value="open_signup">Open signup</option>
              <option value="manual_approval">Manual approval</option>
            </select>
          </label>
          <label>
            {renderFieldLabel('Authentication mode')}
            <select value={draft.auth.mode} onChange={(event) => updateDraft('auth', { mode: event.target.value as AuthMode })}>
              <option value="atproto">Bluesky OAuth</option>
              <option value="lan">LAN screen-name</option>
            </select>
          </label>
          <label>
            {renderFieldLabel('LAN handoff base URL')}
            <input value={draft.auth.lanRedirectBaseUrl} onChange={(event) => updateDraft('auth', { lanRedirectBaseUrl: event.target.value })} />
          </label>
        </section>
      </div>
    );
  };

  const renderLook = () => {
    if (!draft) {
      return <div className="settings-empty-inline">Loading look settings...</div>;
    }

    const asset = draft.appearance.background;
    const eyeDropperAvailable = canPickPanelColor();

    const renderAppearanceColorCard = (
      field: AppearanceColorField,
      title: string,
      summary: string,
    ) => {
      const defaultColor = DEFAULT_APPEARANCE_COLORS[field];
      const color = draft.appearance[field] || defaultColor;
      const rgb = hexToRgbColor(color) ?? hexToRgbColor(defaultColor)!;
      const hsv = rgbToHsvColor(rgb);
      const hueColor = rgbToHexColor(hsvToRgbColor({ h: hsv.h, s: 1, v: 1 }));
      const pickerOpen = openAppearanceColorPicker === field;
      const pickerStyle = {
        '--panel-picker-hue': hueColor,
        '--panel-picker-x': `${hsv.s * 100}%`,
        '--panel-picker-y': `${(1 - hsv.v) * 100}%`,
        '--panel-picker-hue-x': `${(hsv.h / 360) * 100}%`,
      } as CSSProperties;
      const updateSaturationFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const s = clampNumber((event.clientX - rect.left) / rect.width, 0, 1);
        const v = 1 - clampNumber((event.clientY - rect.top) / rect.height, 0, 1);
        applyLookAppearanceColor(field, rgbToHexColor(hsvToRgbColor({ ...hsv, s, v })));
      };
      const updateHueFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const h = clampNumber((event.clientX - rect.left) / rect.width, 0, 1) * 360;
        applyLookAppearanceColor(field, rgbToHexColor(hsvToRgbColor({ ...hsv, h })));
      };
      const updateRgbChannel = (channel: ColorChannel, value: string) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          return;
        }
        applyLookAppearanceColor(field, rgbToHexColor({
          ...rgb,
          [channel]: clampNumber(parsed, 0, 255),
        }));
      };

      return (
        <div className="settings-panel-color-card">
          <div className="settings-panel-color-heading">
            <div>
              <strong>{title}</strong>
              <small>{summary}</small>
            </div>
            <button
              className="settings-panel-color-trigger"
              type="button"
              aria-label={title}
              aria-expanded={pickerOpen}
              onClick={() => setOpenAppearanceColorPicker((current) => (current === field ? null : field))}
            >
              <span className="settings-panel-color-preview" style={{ backgroundColor: color }} />
              <span>{color}</span>
            </button>
          </div>
          <div className="settings-panel-color-controls">
            <input
              className="settings-panel-color-hex"
              value={appearanceColorText[field]}
              inputMode="text"
              maxLength={7}
              spellCheck={false}
              aria-label={`${title} hex value`}
              placeholder={defaultColor}
              onChange={(event) => handleAppearanceColorTextChange(field, event.target.value)}
            />
            <button
              type="button"
              className="settings-color-reset"
              disabled={!draft.appearance[field]}
              onClick={() => {
                setAppearanceColorText((current) => ({
                  ...current,
                  [field]: '',
                }));
                updateLookAppearanceColor(field, '');
              }}
            >
              Default
            </button>
          </div>
          {pickerOpen && (
            <div
              className="settings-panel-color-popover"
              style={pickerStyle}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div
                className="settings-panel-color-area"
                role="slider"
                aria-label={`${title} saturation and brightness`}
                aria-valuetext={color}
                tabIndex={0}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  updateSaturationFromPointer(event);
                }}
                onPointerMove={(event) => {
                  if (event.buttons === 1) {
                    updateSaturationFromPointer(event);
                  }
                }}
              >
                <span className="settings-panel-color-area-cursor" />
              </div>
              <div className="settings-panel-color-tools">
                <button
                  className="settings-panel-eyedropper"
                  type="button"
                  title={eyeDropperAvailable ? 'Pick color from app' : 'Eyedropper is unavailable in this browser'}
                  aria-label="Pick color from screen"
                  disabled={!eyeDropperAvailable}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handlePanelEyeDropper(field);
                  }}
                >
                  <EyeDropperIcon />
                </button>
                <span className="settings-panel-color-current" style={{ backgroundColor: color }} />
                <div
                  className="settings-panel-hue-slider"
                  role="slider"
                  aria-label={`${title} hue`}
                  aria-valuemin={0}
                  aria-valuemax={360}
                  aria-valuenow={Math.round(hsv.h)}
                  tabIndex={0}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    updateHueFromPointer(event);
                  }}
                  onPointerMove={(event) => {
                    if (event.buttons === 1) {
                      updateHueFromPointer(event);
                    }
                  }}
                >
                  <span className="settings-panel-hue-cursor" />
                </div>
              </div>
              <div className="settings-panel-rgb-grid">
                {(['r', 'g', 'b'] as const).map((channel) => (
                  <label key={channel}>
                    <input
                      type="number"
                      min={0}
                      max={255}
                      value={Math.round(rgb[channel])}
                      onChange={(event) => updateRgbChannel(channel, event.target.value)}
                    />
                    <span>{channel.toUpperCase()}</span>
                  </label>
                ))}
              </div>
              <div className="settings-panel-color-popover-actions">
                <button type="button" onClick={() => setOpenAppearanceColorPicker(null)}>Done</button>
              </div>
            </div>
          )}
        </div>
      );
    };

    return (
      <section
        className={`settings-panel wide look-drop-card ${activeLookDrop ? 'drag-over' : ''}`}
        onDragOver={handleLookDragOver}
        onDragLeave={() => setActiveLookDrop(false)}
        onDrop={handleLookDrop}
      >
        <div
          className="look-drop-preview look-drop-preview-large"
          style={asset.url ? { backgroundImage: `url(${asset.url})` } : undefined}
        >
          <div className="look-drop-preview-content">
            <PanelUploadIcon />
            <strong>App Background</strong>
            <small>{asset.url ? 'Drop to replace' : 'Drop image here'}</small>
          </div>
        </div>
        <div className="settings-inline look-actions">
          <label className="settings-upload-button">
            Choose Image
            <input
              type="file"
              accept="image/*"
              onChange={(event) => uploadLookBackgroundFile(event.target.files?.[0])}
            />
          </label>
          <button
            type="button"
            onClick={() => updateLookBackground({})}
            disabled={!asset.attachmentId || uploadAssetMutation.isPending}
          >
            Clear
          </button>
        </div>
        {renderAppearanceColorCard('panelColor', 'Panel Color', 'Channels and members panes')}
        <div className="settings-bubble-color-grid">
          {renderAppearanceColorCard('ownMessageColor', 'Your Bubble Accent', 'Messages sent by you')}
          {renderAppearanceColorCard('otherMessageColor', 'Other Bubble Accent', 'Messages from everyone else')}
        </div>
      </section>
    );
  };

  const renderRoles = () => (
    <div className="settings-split">
      <aside className="settings-list">
        <button className="settings-primary-button" onClick={() => createRoleMutation.mutate()} disabled={createRoleMutation.isPending}>
          Create Role
        </button>
        {roles.map((role) => (
          <button key={role.id} className={selectedRoleId === role.id ? 'active' : ''} onClick={() => setSelectedRoleId(role.id)}>
            <span className="settings-color-dot" style={{ background: role.color }} />
            <span>{role.name}</span>
            <small>{role.permissions.length}</small>
          </button>
        ))}
      </aside>
      <section className="settings-panel">
        {selectedRole && roleDraft ? (
          <>
            <h3>{selectedRole.name}</h3>
            <label>
              {renderFieldLabel('Role name')}
              <input value={roleDraft.name} onChange={(event) => setRoleDraft({ ...roleDraft, name: event.target.value })} />
            </label>
            <div className="settings-two-col">
              <label>
                {renderFieldLabel('Color')}
                <input type="color" value={roleDraft.color} onChange={(event) => setRoleDraft({ ...roleDraft, color: event.target.value })} />
              </label>
              <label>
                {renderFieldLabel('Position')}
                <input type="number" value={roleDraft.position} onChange={(event) => setRoleDraft({ ...roleDraft, position: Number(event.target.value) })} />
              </label>
            </div>
            <div className="settings-permission-grid">
              {PERMISSIONS.map((permission) => (
                <label key={permission} className="settings-check-row">
                  <input
                    type="checkbox"
                    checked={roleDraft.permissions.includes(permission)}
                    onChange={() => toggleRolePermission(permission)}
                  />
                  <span>{formatPermission(permission)}</span>
                </label>
              ))}
            </div>
            <div className="settings-actions">
              <button onClick={() => saveRoleMutation.mutate()} disabled={saveRoleMutation.isPending}>Save Role</button>
              <button className="danger" onClick={() => deleteRoleMutation.mutate(selectedRole.id)} disabled={deleteRoleMutation.isPending}>Delete Role</button>
            </div>
          </>
        ) : (
          <div className="settings-empty-inline">Select a role to edit.</div>
        )}
      </section>
    </div>
  );

  const renderMembers = () => (
    <div className="settings-split">
      <aside className="settings-list">
        <input className="settings-search" placeholder="Search members" value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} />
        {filteredMembers.map((member) => (
          <button key={member.id} className={selectedMemberId === member.id ? 'active' : ''} onClick={() => setSelectedMemberId(member.id)}>
            <span>{member.displayName}</span>
            <small>@{member.handle}</small>
          </button>
        ))}
      </aside>
      <section className="settings-panel">
        {selectedMember ? (
          <>
            <h3>{selectedMember.displayName}</h3>
            <p className="settings-note">@{selectedMember.handle}</p>
            <div className="settings-role-chip-grid">
              {roles.map((role) => (
                <label key={role.id} className="settings-check-row">
                  <input type="checkbox" checked={memberRoleDraft.includes(role.id)} onChange={() => toggleMemberRole(role.id)} />
                  <span className="settings-color-dot" style={{ background: role.color }} />
                  <span>{role.name}</span>
                </label>
              ))}
            </div>
            <button onClick={() => saveMemberRolesMutation.mutate()} disabled={saveMemberRolesMutation.isPending}>
              Save Member Roles
            </button>
            <hr className="settings-divider" />
            <h3>Moderation</h3>
            <div className="settings-two-col">
              <label>
                {renderFieldLabel('Action')}
                <select value={moderationType} onChange={(event) => setModerationType(event.target.value as typeof moderationType)}>
                  <option value="warn">Warn</option>
                  <option value="mute">Mute</option>
                  <option value="timeout">Timeout</option>
                  <option value="kick">Kick</option>
                  <option value="ban">Ban</option>
                </select>
              </label>
              <label>
                {renderFieldLabel('Reason')}
                <input value={moderationReason} onChange={(event) => setModerationReason(event.target.value)} />
              </label>
            </div>
            <button className="danger" onClick={() => moderationMutation.mutate()} disabled={moderationMutation.isPending}>
              Apply Moderation Action
            </button>
          </>
        ) : (
          <div className="settings-empty-inline">Select a member to manage.</div>
        )}
      </section>
    </div>
  );

  const renderChannels = () => (
    <div className="settings-split">
      <aside className="settings-list">
        {channels.map((channel) => (
          <button key={channel.id} className={selectedChannelId === channel.id ? 'active' : ''} onClick={() => setSelectedChannelId(channel.id)}>
            <span>{channel.type === 'category' ? 'Category' : channel.type === 'voice' ? 'Voice' : '#'} {channel.name}</span>
            <small>{channel.locked ? 'Locked' : channel.type}</small>
          </button>
        ))}
      </aside>
      <section className="settings-panel wide">
        {selectedChannel && channelDraft ? (
          <>
            <h3>#{selectedChannel.name}</h3>
            <div className="settings-two-col">
              <label>
                {renderFieldLabel('Name')}
                <input value={channelDraft.name} onChange={(event) => setChannelDraft({ ...channelDraft, name: event.target.value })} />
              </label>
              <label>
                {renderFieldLabel('Type')}
                <select value={channelDraft.type} onChange={(event) => setChannelDraft({ ...channelDraft, type: event.target.value as Channel['type'] })}>
                  <option value="text">Text</option>
                  <option value="voice">Voice</option>
                  <option value="category">Category</option>
                  <option value="dm">DM</option>
                </select>
              </label>
            </div>
            <label>
              {renderFieldLabel('Topic')}
              <input value={channelDraft.topic} onChange={(event) => setChannelDraft({ ...channelDraft, topic: event.target.value })} />
            </label>
            <div className="settings-two-col">
              <label>
                {renderFieldLabel('Slowmode seconds')}
                <input type="number" value={channelDraft.slowmodeSeconds} onChange={(event) => setChannelDraft({ ...channelDraft, slowmodeSeconds: Number(event.target.value) })} />
              </label>
              <label className="settings-check-row padded">
                <input type="checkbox" checked={channelDraft.locked} onChange={(event) => setChannelDraft({ ...channelDraft, locked: event.target.checked })} />
                <span>Locked</span>
              </label>
            </div>
            <button onClick={() => saveChannelMutation.mutate()} disabled={saveChannelMutation.isPending}>Save Channel</button>

            <hr className="settings-divider" />
            <h3>Permission Overwrites</h3>
            <div className="settings-inline">
              <select value={overwriteTarget} onChange={(event) => setOverwriteTarget(event.target.value)}>
                <option value="">Add role or member override</option>
                {roles.map((role) => <option key={`role:${role.id}`} value={`role:${role.id}`}>Role: {role.name}</option>)}
                {members.map((member) => <option key={`user:${member.id}`} value={`user:${member.id}`}>Member: {member.displayName}</option>)}
              </select>
              <button onClick={addOverwrite}>Add</button>
            </div>
            <div className="settings-overwrite-list">
              {overwriteDrafts.map((overwrite, index) => {
                const label = overwrite.targetType === 'role'
                  ? rolesById.get(overwrite.targetId)?.name ?? 'Unknown role'
                  : membersById.get(overwrite.targetId)?.displayName ?? 'Unknown member';
                return (
                  <div key={`${overwrite.targetType}:${overwrite.targetId}`} className="settings-overwrite">
                    <header>
                      <strong>{label}</strong>
                      <button onClick={() => removeOverwrite(index)}>Remove</button>
                    </header>
                    {PERMISSIONS.map((permission) => (
                      <div key={permission} className="settings-overwrite-row">
                        <span>{formatPermission(permission)}</span>
                        <div className="settings-tristate">
                          {(['inherit', 'allow', 'deny'] as const).map((state) => (
                            <button
                              key={state}
                              className={permissionState(overwrite, permission) === state ? 'active' : ''}
                              onClick={() => setOverwritePermission(index, permission, state)}
                            >
                              {state}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            <button onClick={() => saveOverwritesMutation.mutate()} disabled={saveOverwritesMutation.isPending}>
              Save Permission Overwrites
            </button>
          </>
        ) : (
          <div className="settings-empty-inline">Select a channel to manage.</div>
        )}
      </section>
    </div>
  );

  const renderInvites = () => (
    <section className="settings-panel wide">
      <h3>Invites</h3>
      <div className="settings-inline">
        <input placeholder="Max uses (optional)" value={inviteMaxUses} onChange={(event) => setInviteMaxUses(event.target.value)} />
        <button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>Create Invite</button>
      </div>
      <ul className="settings-log-list">
        {(invitesQuery.data ?? []).map((invite) => (
          <li key={invite.code}>
            <div>
              <strong>{invite.code}</strong>
              <small>{invite.usedCount}{invite.maxUses ? `/${invite.maxUses}` : ''} uses {invite.revoked ? '· revoked' : ''}</small>
            </div>
            <button onClick={() => deleteInviteMutation.mutate(invite.code)}>Revoke</button>
          </li>
        ))}
        {invitesQuery.data?.length === 0 && <li className="settings-empty-inline">No invites yet.</li>}
      </ul>
    </section>
  );

  const renderAutomod = () => (
    <section className="settings-panel wide">
      <h3>Automod Rules</h3>
      <div className="settings-two-col">
        <label>
          {renderFieldLabel('Name')}
          <input value={automodName} onChange={(event) => setAutomodName(event.target.value)} />
        </label>
        <label>
          {renderFieldLabel('Type')}
          <select value={automodType} onChange={(event) => setAutomodType(event.target.value as AutomodRule['type'])}>
            <option value="keyword">Keyword</option>
            <option value="regex">Regex</option>
            <option value="mention_spam">Mention spam</option>
            <option value="link_policy">Link policy</option>
          </select>
        </label>
      </div>
      <label>
        {renderFieldLabel('Payload JSON')}
        <textarea value={automodPayload} onChange={(event) => setAutomodPayload(event.target.value)} />
      </label>
      <button onClick={() => createAutomodMutation.mutate()} disabled={createAutomodMutation.isPending}>Create Rule</button>
      <ul className="settings-log-list">
        {(automodQuery.data ?? []).map((rule) => (
          <li key={rule.id}>
            <div>
              <strong>{rule.name}</strong>
              <small>{rule.type} · {rule.enabled ? 'Enabled' : 'Disabled'}</small>
            </div>
            <div className="settings-inline">
              <button onClick={() => patchAutomodMutation.mutate({ ruleId: rule.id, patch: { enabled: !rule.enabled } })}>
                {rule.enabled ? 'Disable' : 'Enable'}
              </button>
              <button className="danger" onClick={() => deleteAutomodMutation.mutate(rule.id)}>Delete</button>
            </div>
          </li>
        ))}
        {automodQuery.data?.length === 0 && <li className="settings-empty-inline">No automod rules yet.</li>}
      </ul>
    </section>
  );

  const renderLogs = () => (
    <section className="settings-panel wide">
      <h3>Moderation Log</h3>
      <ul className="settings-log-list">
        {moderationLogsQuery.isLoading && <li className="settings-empty-inline">Loading moderation logs...</li>}
        {moderationLogsQuery.error instanceof Error && <li className="settings-empty-inline settings-error">{moderationLogsQuery.error.message}</li>}
        {(moderationLogsQuery.data ?? []).map((entry) => {
          const actor = entry.actorId ? membersById.get(entry.actorId) : undefined;
          const target = entry.targetId ? membersById.get(entry.targetId) : undefined;
          return (
            <li key={entry.id}>
              <div>
                <strong>{entry.summary}</strong>
                <small>{entry.source.toUpperCase()} · {new Date(entry.createdAt).toLocaleString()}</small>
              </div>
              <small>{actor ? `By ${actor.displayName}` : 'By system'}{target ? ` · Target: ${target.displayName}` : ''}</small>
            </li>
          );
        })}
        {moderationLogsQuery.data?.length === 0 && !moderationLogsQuery.isLoading && <li className="settings-empty-inline">No moderation logs yet.</li>}
      </ul>
    </section>
  );

  const renderSecurity = () => (
    <section className="settings-panel wide">
      <h3>Shared IP Insights</h3>
      <ul className="shared-ip-list">
        {sharedIpsQuery.isLoading && <li className="settings-empty-inline">Loading shared IP insights...</li>}
        {sharedIpsQuery.error instanceof Error && <li className="settings-empty-inline settings-error">{sharedIpsQuery.error.message}</li>}
        {(sharedIpsQuery.data ?? []).map((group) => (
          <li key={group.ipAddress}>
            <div>
              <strong>{group.ipAddress}</strong>
              <small>{group.userCount} users · {group.totalHits} hits · last seen {new Date(group.lastSeenAt).toLocaleString()}</small>
            </div>
            <p>{group.users.map((user) => `${user.displayName} (@${user.handle})`).join(', ')}</p>
          </li>
        ))}
        {sharedIpsQuery.data?.length === 0 && !sharedIpsQuery.isLoading && <li className="settings-empty-inline">No shared IP addresses detected yet.</li>}
      </ul>
    </section>
  );

  const renderEncryption = () => (
    <section className="settings-panel wide">
      <h3>Message Encryption</h3>
      <div className={`settings-e2ee-panel ${e2eeState.status === 'ready' ? 'ready' : 'blocked'}`}>
        <div>
          <strong>
            {e2eeState.status === 'ready'
              ? 'Shared Room Key Active'
              : e2eeState.status === 'loading'
                ? 'Shared Room Key Loading'
                : 'Shared Room Key Unavailable'}
          </strong>
          <small>
            {e2eeState.status === 'ready'
              ? `Key fingerprint: ${e2eeState.keyId}`
              : e2eeState.status === 'loading'
                ? 'Current is preparing the authenticated room key for this server.'
                : e2eeState.reason}
          </small>
        </div>
        <div className="settings-e2ee-actions">
          <button onClick={onCopyE2eeKey} disabled={e2eeState.status !== 'ready'}>Copy Room Key</button>
          <button onClick={onImportE2eeKey}>Import Legacy Key</button>
        </div>
      </div>
      <p className="settings-note">
        Text message bodies are encrypted in the browser with a room key shared by authenticated users.
      </p>
    </section>
  );

  const renderAdvanced = () => {
    if (!draft) {
      return <div className="settings-empty-inline">Loading config...</div>;
    }
    return (
      <div className="settings-panel-grid">
        <section className="settings-panel">
          <h3>Network</h3>
          <div className="settings-two-col">
            <label>{renderFieldLabel('Host', 'server.host')}<input value={draft.server.host} onChange={(event) => updateDraft('server', { host: event.target.value })} /></label>
            <label>{renderFieldLabel('Port', 'server.port')}<input type="number" value={draft.server.port} onChange={(event) => updateDraft('server', { port: Number(event.target.value) })} /></label>
          </div>
          <label>{renderFieldLabel('Public URL')}<input value={draft.server.publicUrl} onChange={(event) => updateDraft('server', { publicUrl: event.target.value })} /></label>
          <label className="settings-check-row padded"><input type="checkbox" checked={draft.server.tlsEnabled} onChange={(event) => updateDraft('server', { tlsEnabled: event.target.checked })} /><span>Enable HTTPS</span></label>
          <label>{renderFieldLabel('TLS cert path', 'server.tls')}<input value={draft.server.tlsCertPath} onChange={(event) => updateDraft('server', { tlsCertPath: event.target.value })} /></label>
          <label>{renderFieldLabel('TLS key path', 'server.tls')}<input value={draft.server.tlsKeyPath} onChange={(event) => updateDraft('server', { tlsKeyPath: event.target.value })} /></label>
        </section>
        <section className="settings-panel">
          <h3>OAuth</h3>
          <label>{renderFieldLabel('Client ID')}<input value={draft.auth.atprotoClientId} onChange={(event) => updateDraft('auth', { atprotoClientId: event.target.value })} /></label>
          <label>{renderFieldLabel('Redirect URI')}<input value={draft.auth.redirectUri} onChange={(event) => updateDraft('auth', { redirectUri: event.target.value })} /></label>
          <label>{renderFieldLabel('Scope')}<input value={draft.auth.scope} onChange={(event) => updateDraft('auth', { scope: event.target.value })} /></label>
          <label>{renderFieldLabel('Cookie secret')}<input type="password" value={draft.auth.cookieSecret} placeholder={settingsQuery.data?.secrets.cookieSecretConfigured ? 'Configured' : 'Unset'} onChange={(event) => updateDraft('auth', { cookieSecret: event.target.value })} /></label>
          <label className="settings-check-row padded"><input type="checkbox" checked={draft.auth.allowDevLogin} onChange={(event) => updateDraft('auth', { allowDevLogin: event.target.checked })} /><span>Allow dev login</span></label>
        </section>
        <section className="settings-panel">
          <h3>Storage & Media</h3>
          <label>{renderFieldLabel('SQLite path', 'storage.sqlitePath')}<input value={draft.storage.sqlitePath} onChange={(event) => updateDraft('storage', { sqlitePath: event.target.value })} /></label>
          <label>{renderFieldLabel('Upload dir', 'storage.uploadDir')}<input value={draft.storage.uploadDir} onChange={(event) => updateDraft('storage', { uploadDir: event.target.value })} /></label>
          <label>{renderFieldLabel('Media backend', 'storage.mediaBackend')}<select value={draft.storage.mediaBackend} onChange={(event) => updateDraft('storage', { mediaBackend: event.target.value as MediaBackend })}><option value="local">Local</option><option value="s3">S3</option></select></label>
          <label>{renderFieldLabel('Max attachment bytes')}<input type="number" value={draft.media.maxAttachmentBytes} onChange={(event) => updateDraft('media', { maxAttachmentBytes: Number(event.target.value) })} /></label>
          <label>{renderFieldLabel('Allowed MIME prefixes')}<textarea value={draft.media.allowedMimePrefixesText} onChange={(event) => updateDraft('media', { allowedMimePrefixesText: event.target.value })} /></label>
          <label>{renderFieldLabel('GIF service')}<select value={draft.media.gifProvider} onChange={(event) => {
            const gifProvider = event.target.value as GifProvider;
            updateDraft('media', {
              gifProvider,
              gifFallbackProvider: draft.media.gifFallbackProvider === gifProvider ? 'none' : draft.media.gifFallbackProvider,
            });
          }}><option value="klipy">Klipy</option><option value="giphy">Giphy</option></select></label>
          <label>{renderFieldLabel('GIF backup service')}<select value={draft.media.gifFallbackProvider} onChange={(event) => updateDraft('media', { gifFallbackProvider: event.target.value as GifFallbackProvider })}><option value="none">None</option><option value="klipy" disabled={draft.media.gifProvider === 'klipy'}>Klipy</option><option value="giphy" disabled={draft.media.gifProvider === 'giphy'}>Giphy</option></select></label>
          <label>{renderFieldLabel('Klipy API key')}<input type="password" value={draft.media.klipyApiKey} placeholder={settingsQuery.data?.secrets.klipyApiKeyConfigured ? 'Configured' : 'Unset'} onChange={(event) => updateDraft('media', { klipyApiKey: event.target.value, clearKlipyApiKey: false })} /></label>
          <label className="settings-check-row padded"><input type="checkbox" checked={draft.media.clearKlipyApiKey} onChange={(event) => updateDraft('media', { clearKlipyApiKey: event.target.checked, klipyApiKey: '' })} /><span>Clear Klipy API key on save</span></label>
          <label>{renderFieldLabel('Giphy API key')}<input type="password" value={draft.media.giphyApiKey} placeholder={settingsQuery.data?.secrets.giphyApiKeyConfigured ? 'Configured' : 'Unset'} onChange={(event) => updateDraft('media', { giphyApiKey: event.target.value, clearGiphyApiKey: false })} /></label>
          <label className="settings-check-row padded"><input type="checkbox" checked={draft.media.clearGiphyApiKey} onChange={(event) => updateDraft('media', { clearGiphyApiKey: event.target.checked, giphyApiKey: '' })} /><span>Clear Giphy API key on save</span></label>
        </section>
        <section className="settings-panel">
          <h3>Moderation Defaults</h3>
          <label>{renderFieldLabel('Default slowmode')}<input type="number" value={draft.moderation.defaultSlowmodeSeconds} onChange={(event) => updateDraft('moderation', { defaultSlowmodeSeconds: Number(event.target.value) })} /></label>
          <label>{renderFieldLabel('Max mentions per message')}<input type="number" value={draft.moderation.maxMentionsPerMessage} onChange={(event) => updateDraft('moderation', { maxMentionsPerMessage: Number(event.target.value) })} /></label>
          <label>{renderFieldLabel('Link policy')}<select value={draft.moderation.linkPolicy} onChange={(event) => updateDraft('moderation', { linkPolicy: event.target.value as LinkPolicy })}><option value="allow">Allow</option><option value="members_only">Members only</option><option value="deny">Deny</option></select></label>
        </section>
        <section className="settings-panel">
          <h3>RTC</h3>
          <div className="settings-two-col">
            <label>{renderFieldLabel('Listen IP', 'rtc.listenIp')}<input value={draft.rtc.listenIp} onChange={(event) => updateDraft('rtc', { listenIp: event.target.value })} /></label>
            <label>{renderFieldLabel('Announced IP', 'rtc.announcedIp')}<input value={draft.rtc.announcedIp} onChange={(event) => updateDraft('rtc', { announcedIp: event.target.value })} /></label>
            <label>{renderFieldLabel('UDP min', 'rtc.udpMinPort')}<input type="number" value={draft.rtc.udpMinPort} onChange={(event) => updateDraft('rtc', { udpMinPort: Number(event.target.value) })} /></label>
            <label>{renderFieldLabel('UDP max', 'rtc.udpMaxPort')}<input type="number" value={draft.rtc.udpMaxPort} onChange={(event) => updateDraft('rtc', { udpMaxPort: Number(event.target.value) })} /></label>
            <label>{renderFieldLabel('SFU workers', 'rtc.workerCount')}<input type="number" min="1" max="8" value={draft.rtc.workerCount} onChange={(event) => updateDraft('rtc', { workerCount: Number(event.target.value) })} /></label>
            <label>{renderFieldLabel('Session timeout ms', 'rtc.sessionTimeoutMs')}<input type="number" min="5000" value={draft.rtc.sessionTimeoutMs} onChange={(event) => updateDraft('rtc', { sessionTimeoutMs: Number(event.target.value) })} /></label>
          </div>
          <label>{renderFieldLabel('TURN URLs', 'rtc.turnUrls')}<textarea value={draft.rtc.turnUrlsText} onChange={(event) => updateDraft('rtc', { turnUrlsText: event.target.value })} /></label>
          <label>{renderFieldLabel('TURN username', 'rtc.turnUsername')}<input value={draft.rtc.turnUsername} placeholder={settingsQuery.data?.secrets.turnUsernameConfigured ? 'Configured' : 'Unset'} onChange={(event) => updateDraft('rtc', { turnUsername: event.target.value, clearTurnUsername: false })} /></label>
          <label>{renderFieldLabel('TURN credential', 'rtc.turnCredential')}<input type="password" value={draft.rtc.turnCredential} placeholder={settingsQuery.data?.secrets.turnCredentialConfigured ? 'Configured' : 'Unset'} onChange={(event) => updateDraft('rtc', { turnCredential: event.target.value, clearTurnCredential: false })} /></label>
        </section>
        <section className="settings-panel">
          <h3>Observability</h3>
          <label className="settings-check-row padded"><input type="checkbox" checked={draft.observability.metricsEnabled} onChange={(event) => updateDraft('observability', { metricsEnabled: event.target.checked })} /><span>Metrics enabled</span></label>
          <label>{renderFieldLabel('Log level', 'observability.logLevel')}<select value={draft.observability.logLevel} onChange={(event) => updateDraft('observability', { logLevel: event.target.value as LogLevel })}><option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option></select></label>
        </section>
      </div>
    );
  };

  const renderOwnership = () => (
    <section className="settings-panel wide">
      <h3>Ownership Transfer</h3>
      <p>Current owner: <strong>{owner?.displayName ?? 'Unassigned'}</strong>{owner?.handle ? ` (@${owner.handle})` : ''}</p>
      {transferCandidates.length === 0 ? (
        <div className="settings-empty-inline">Add at least one more member before transferring ownership.</div>
      ) : (
        <>
          <label>
            {renderFieldLabel('Transfer to')}
            <select value={selectedOwnerId} onChange={(event) => setSelectedOwnerId(event.target.value)}>
              <option value="" disabled>Select a member</option>
              {transferCandidates.map((member) => (
                <option key={member.id} value={member.id}>{member.displayName} (@{member.handle})</option>
              ))}
            </select>
          </label>
          <button onClick={() => selectedTransferTarget && setPendingTransferTargetId(selectedTransferTarget.id)} disabled={!selectedTransferTarget}>
            Transfer Ownership
          </button>
        </>
      )}
      {transferNotice && <small className="settings-success">{transferNotice}</small>}
      {transferOwnershipMutation.error instanceof Error && <small className="settings-error">{transferOwnershipMutation.error.message}</small>}
    </section>
  );

  const renderFactoryReset = () => (
    <section className="settings-panel wide settings-danger-zone">
      <h3>Factory Reset</h3>
      <p className="settings-note">
        This erases users, sessions, roles, channels, messages, invites, moderation history, audit logs, gateway history, and uploaded attachments. Server setup will run again after the reset.
      </p>
      <button className="danger" onClick={() => setFactoryResetConfirmOpen(true)}>
        Factory Reset Server
      </button>
      {factoryResetMutation.error instanceof Error && (
        <small className="settings-error">{factoryResetMutation.error.message}</small>
      )}
    </section>
  );

  const renderActiveSection = () => {
    if (settingsQuery.isLoading && activeSection !== 'encryption') {
      return <div className="settings-empty-inline">Loading settings...</div>;
    }
    if (settingsQuery.error instanceof Error) {
      return <div className="settings-empty-inline settings-error">{settingsQuery.error.message}</div>;
    }

    switch (activeSection) {
      case 'overview':
        return renderOverview();
      case 'look':
        return renderLook();
      case 'roles':
        return renderRoles();
      case 'members':
        return renderMembers();
      case 'channels':
        return renderChannels();
      case 'invites':
        return renderInvites();
      case 'automod':
        return renderAutomod();
      case 'logs':
        return renderLogs();
      case 'security':
        return renderSecurity();
      case 'encryption':
        return renderEncryption();
      case 'advanced':
        return renderAdvanced();
      case 'ownership':
        return renderOwnership();
      case 'factory-reset':
        return renderFactoryReset();
    }
  };

  return (
    <div
      className={`settings-modal-backdrop${panelEyeDropperActive || panelEyeDropperSampling ? ' settings-eyedropper-active' : ''}`}
      onClick={handleSettingsBackdropClick}
    >
      <section
        className={`settings-modal discord-settings liquid-surface ${overLight ? 'over-light-background' : ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div className="settings-title-block">
            <div className="settings-title-pill glass-panel">
              <LiquidGlassBackdrop
                className="channel-title-liquid-glass"
                cornerRadius={999}
                displacementScale={128}
                blurAmount={0.1}
                saturation={145}
                aberrationIntensity={2}
                elasticity={0.04}
                mode="prominent"
                overLight={overLight}
              />
              <h2>Server Settings</h2>
            </div>
            <small>{activeCopy.summary}</small>
          </div>
          <button className="settings-close" onClick={onClose}>x</button>
        </header>

        {!canManageServer ? (
          <div className="settings-empty">
            <p>You need `MANAGE_SERVER` (or `ADMINISTRATOR`) permission to access Server Settings.</p>
            <button className="settings-claim-host-button" onClick={() => claimHostOwnershipMutation.mutate()} disabled={claimHostOwnershipMutation.isPending}>
              {claimHostOwnershipMutation.isPending ? 'Claiming...' : 'Claim Host Ownership'}
            </button>
            {claimHostOwnershipMutation.isError && (
              <small>{claimHostOwnershipMutation.error instanceof Error ? claimHostOwnershipMutation.error.message : 'Could not claim ownership from this machine.'}</small>
            )}
          </div>
        ) : (
          <div className="settings-layout">
            <aside className="settings-nav glass-panel" aria-label="Server settings sections">
              <div className="settings-nav-scroll">
                <input className="settings-search" placeholder="Search settings" value={settingsSearch} onChange={(event) => setSettingsSearch(event.target.value)} />
                {visibleSections.map((section) => (
                  <button key={section.id} className={activeSection === section.id ? 'active' : ''} onClick={() => setActiveSection(section.id)}>
                    <span>{section.label}</span>
                    <small>{section.summary}</small>
                  </button>
                ))}
              </div>
            </aside>

            <main className="settings-content glass-panel">
              <div className="settings-content-scroll">
                <section className="settings-page">
                  <header className="settings-page-header">
                    <div className="settings-page-title-block">
                      <h3>{activeCopy.label}</h3>
                      <p>{activeCopy.summary}</p>
                    </div>
                    {settingsQuery.data?.restartRequired && (
                      <span className="settings-restart-badge">Restart required</span>
                    )}
                  </header>
                  {renderActiveSection()}
                </section>
              </div>
            </main>
          </div>
        )}

        {dirty && (
          <footer className="settings-save-bar glass-panel">
            <span>You have unsaved server config changes.</span>
            <div>
              <button onClick={() => savedDraft && setDraft(savedDraft)} disabled={saveSettingsMutation.isPending}>Reset</button>
              <button onClick={() => saveSettingsMutation.mutate()} disabled={saveSettingsMutation.isPending}>
                {saveSettingsMutation.isPending ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </footer>
        )}
        {saveSettingsMutation.error instanceof Error && <small className="settings-floating-error">{saveSettingsMutation.error.message}</small>}

        {pendingTransferTarget && (
          <div className="settings-warning-backdrop" onClick={() => setPendingTransferTargetId(null)}>
            <section
              className={`settings-warning danger liquid-surface ${overLight ? 'over-light-background' : ''}`}
              onClick={(event) => event.stopPropagation()}
            >
              <LiquidGlassBackdrop
                className="modal-liquid-glass"
                cornerRadius={18}
                displacementScale={128}
                blurAmount={0.12}
                saturation={145}
                aberrationIntensity={2}
                elasticity={0.04}
                mode="prominent"
                overLight={overLight}
              />
              <h4>Confirm Ownership Transfer</h4>
              <p>You are about to transfer server ownership to <strong>{pendingTransferTarget.displayName} (@{pendingTransferTarget.handle})</strong>.</p>
              <p className="settings-warning-copy">This grants full administrative control and may lock you out of owner-only controls.</p>
              <div className="settings-warning-actions">
                <button onClick={() => setPendingTransferTargetId(null)} disabled={transferOwnershipMutation.isPending}>Cancel</button>
                <button className="danger" onClick={confirmOwnershipTransfer} disabled={transferOwnershipMutation.isPending}>
                  {transferOwnershipMutation.isPending ? 'Transferring...' : 'Transfer Ownership'}
                </button>
              </div>
            </section>
          </div>
        )}

        {factoryResetConfirmOpen && (
          <div className="settings-warning-backdrop" onClick={() => setFactoryResetConfirmOpen(false)}>
            <section
              className={`settings-warning factory-reset-warning liquid-surface ${overLight ? 'over-light-background' : ''}`}
              onClick={(event) => event.stopPropagation()}
            >
              <LiquidGlassBackdrop
                className="modal-liquid-glass"
                cornerRadius={18}
                displacementScale={128}
                blurAmount={0.12}
                saturation={145}
                aberrationIntensity={2}
                elasticity={0.04}
                mode="prominent"
                overLight={overLight}
              />
              <h4>Confirm Factory Reset</h4>
              <p>This will permanently erase the current server and return Current to setup.</p>
              <label>
                Confirmation phrase
                <input
                  value={factoryResetConfirmation}
                  placeholder={FACTORY_RESET_CONFIRMATION}
                  onChange={(event) => setFactoryResetConfirmation(event.target.value)}
                />
              </label>
              {factoryResetMutation.error instanceof Error && (
                <small className="settings-error">{factoryResetMutation.error.message}</small>
              )}
              <div className="settings-warning-actions">
                <button onClick={() => setFactoryResetConfirmOpen(false)} disabled={factoryResetMutation.isPending}>
                  Cancel
                </button>
                <button
                  className="danger"
                  onClick={() => factoryResetMutation.mutate()}
                  disabled={
                    factoryResetMutation.isPending ||
                    factoryResetConfirmation !== FACTORY_RESET_CONFIRMATION
                  }
                >
                  {factoryResetMutation.isPending ? 'Resetting...' : 'Factory Reset'}
                </button>
              </div>
            </section>
          </div>
        )}
      </section>
      {panelEyeDropperActive && (
        <div
          className="settings-app-eyedropper-target"
          role="button"
          tabIndex={0}
          aria-label="Pick panel color from app"
          onPointerDown={samplePanelColorFromPoint}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.nativeEvent.stopImmediatePropagation();
            samplePanelColorAtPoint({ x: event.clientX, y: event.clientY });
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <span>Click anywhere in the app to sample color</span>
        </div>
      )}
    </div>
  );
}
