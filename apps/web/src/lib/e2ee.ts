import type { EncryptedMessageContent, Message } from '@current/types';
import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { apiGet, apiPost } from './api';

const E2EE_STORAGE_PREFIX = 'current:e2ee:v1:';
const RAW_KEY_BYTES = 32;
const NONCE_BYTES = 12;

interface SharedE2eeKeyResponse {
  exportedKey: string;
}

const SHARED_KEY_FETCH_RETRY_COUNT = 6;
const SHARED_KEY_FETCH_RETRY_DELAY_MS = 750;

export type E2eeKeyState =
  | {
      status: 'ready';
      key?: CryptoKey;
      rawKey: Uint8Array;
      keyId: string;
      exportedKey: string;
    }
  | {
      status: 'unsupported';
      reason: string;
    };

export interface MessageAad {
  channelId: string;
  authorId: string;
}

function getSubtleCrypto() {
  return globalThis.crypto?.subtle;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function keyIdForRawKey(rawKey: Uint8Array): string {
  return encodeBase64Url(sha256(rawKey).slice(0, 12));
}

async function importWebCryptoKey(rawKey: Uint8Array): Promise<CryptoKey | undefined> {
  const subtle = getSubtleCrypto();
  if (!subtle) {
    return undefined;
  }

  if (rawKey.byteLength !== RAW_KEY_BYTES) {
    throw new Error('E2EE keys must be 32 bytes.');
  }

  return subtle.importKey('raw', toArrayBuffer(rawKey), { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function storageKey(serverId: string) {
  return `${E2EE_STORAGE_PREFIX}${serverId}`;
}

async function stateFromRawKey(rawKey: Uint8Array): Promise<Extract<E2eeKeyState, { status: 'ready' }>> {
  if (rawKey.byteLength !== RAW_KEY_BYTES) {
    throw new Error('E2EE keys must be 32 bytes.');
  }

  const key = await importWebCryptoKey(rawKey);
  const keyId = keyIdForRawKey(rawKey);
  return {
    status: 'ready',
    key,
    rawKey: new Uint8Array(rawKey),
    keyId,
    exportedKey: encodeBase64Url(rawKey),
  };
}

function createRawKey(): Uint8Array {
  const rawKey = new Uint8Array(RAW_KEY_BYTES);
  globalThis.crypto.getRandomValues(rawKey);
  return rawKey;
}

async function getLocalKeyState(serverId: string): Promise<Extract<E2eeKeyState, { status: 'ready' }>> {
  const existing = window.localStorage.getItem(storageKey(serverId));
  if (existing) {
    try {
      return stateFromRawKey(decodeBase64Url(existing));
    } catch {
      window.localStorage.removeItem(storageKey(serverId));
    }
  }

  const state = await stateFromRawKey(createRawKey());
  window.localStorage.setItem(storageKey(serverId), state.exportedKey);
  return state;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function fetchSharedE2eeKey(): Promise<Extract<E2eeKeyState, { status: 'ready' }>> {
  const sharedKey = await apiGet<SharedE2eeKeyResponse>('/api/v1/server/e2ee-key');
  return stateFromRawKey(decodeBase64Url(sharedKey.exportedKey));
}

async function claimSharedE2eeKey(exportedKey: string): Promise<Extract<E2eeKeyState, { status: 'ready' }>> {
  try {
    const sharedKey = await apiPost<SharedE2eeKeyResponse>('/api/v1/server/e2ee-key', {
      exportedKey,
    });

    return stateFromRawKey(decodeBase64Url(sharedKey.exportedKey));
  } catch (error) {
    for (let attempt = 0; attempt < SHARED_KEY_FETCH_RETRY_COUNT; attempt += 1) {
      await delay(SHARED_KEY_FETCH_RETRY_DELAY_MS);
      try {
        return await fetchSharedE2eeKey();
      } catch {
        // Another browser that can read legacy ciphertext may still be claiming the key.
      }
    }
    throw error;
  }
}

export async function loadOrCreateE2eeKey(serverId: string): Promise<E2eeKeyState> {
  if (!globalThis.crypto?.getRandomValues) {
    return {
      status: 'unsupported',
      reason: 'Secure random values are not available in this browser context.',
    };
  }

  const localState = await getLocalKeyState(serverId);
  const sharedState = await claimSharedE2eeKey(localState.exportedKey);
  window.localStorage.setItem(storageKey(serverId), sharedState.exportedKey);
  return sharedState;
}

export async function importE2eeKey(serverId: string, exportedKey: string): Promise<E2eeKeyState> {
  const state = await claimSharedE2eeKey(exportedKey);
  window.localStorage.setItem(storageKey(serverId), state.exportedKey);
  return state;
}

function encodeAad(input: MessageAad): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      channelId: input.channelId,
      authorId: input.authorId,
    }),
  );
}

export async function encryptMessageContent(
  keyState: Extract<E2eeKeyState, { status: 'ready' }>,
  plaintext: string,
  aad: MessageAad,
): Promise<EncryptedMessageContent> {
  const nonce = new Uint8Array(NONCE_BYTES);
  globalThis.crypto.getRandomValues(nonce);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const aadBytes = encodeAad(aad);

  const ciphertext = keyState.key
    ? await globalThis.crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: toArrayBuffer(nonce),
          additionalData: toArrayBuffer(aadBytes),
        },
        keyState.key,
        toArrayBuffer(plaintextBytes),
      )
    : gcm(keyState.rawKey, nonce, aadBytes).encrypt(plaintextBytes);

  return {
    version: 1,
    algorithm: 'AES-GCM',
    keyId: keyState.keyId,
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(ciphertext instanceof ArrayBuffer ? new Uint8Array(ciphertext) : ciphertext),
  };
}

export async function decryptMessageContent(
  keyState: Extract<E2eeKeyState, { status: 'ready' }>,
  message: Pick<Message, 'channelId' | 'authorId' | 'encryptedContent'>,
): Promise<string> {
  const encryptedContent = message.encryptedContent;
  if (!encryptedContent) {
    return '';
  }

  if (encryptedContent.keyId !== keyState.keyId) {
    throw new Error('This message was encrypted with a different room key.');
  }

  const nonce = decodeBase64Url(encryptedContent.nonce);
  const ciphertext = decodeBase64Url(encryptedContent.ciphertext);
  const aad = encodeAad({
    channelId: message.channelId,
    authorId: message.authorId,
  });

  const plaintext = keyState.key
    ? await globalThis.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: toArrayBuffer(nonce),
          additionalData: toArrayBuffer(aad),
        },
        keyState.key,
        toArrayBuffer(ciphertext),
      )
    : gcm(keyState.rawKey, nonce, aad).decrypt(ciphertext);

  return new TextDecoder().decode(plaintext);
}
