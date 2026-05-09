# Current API (v1)

Base path: `/api/v1`

Paginated list endpoints return:

```ts
type PageResponse<T> = {
  items: T[];
  pageInfo: {
    hasMore: boolean;
    nextCursor?: string;
  };
};
```

Pagination defaults and caps:

- `GET /channels`: default `limit=75`
- `GET /members`: default `limit=100`
- `GET /channels/:channelId/messages`: default `limit=40`
- All paginated list endpoints enforce `1 <= limit <= 200`

## Setup

- `GET /setup/status` (includes `authMode: "atproto" | "lan"`)
- `POST /setup/bootstrap`

## Auth

- `POST /auth/lan-login` (LAN mode only; screen-name sign-in without Bluesky)
- `GET /auth/oauth/start?handle=you.bsky.social&returnTo=http://localhost:8080`
- `GET /auth/oauth/callback?...` (processes OAuth response and sets `current_session` cookie)
- `GET /auth/client-metadata.json` (discoverable OAuth metadata when `server.publicUrl` is HTTPS domain)
- `GET /auth/lan/handoffs/:handoffId/start` (host-machine OAuth step for LAN loopback mode)
- `GET /auth/lan/handoffs/:handoffId/complete` (host callback completion page for LAN handoff)
- `GET /auth/lan/handoffs/:handoffId` (handoff status polling endpoint)
- `POST /auth/lan/handoffs/:handoffId/claim` (claims handoff auth ticket for session exchange)
- `POST /auth/exchange` (one-time auth ticket exchange for cross-host local dev redirects)
- `POST /auth/dev-login` (local testing, gated by `auth.allowDevLogin`)
- `GET /auth/session`
- `POST /auth/logout`

## Server

- `GET /server`
- `PATCH /server/registration-mode`
- `GET /members?limit=100&after=<cursor>` (paginated)
- `GET /admin/settings` (includes `auth.lanRedirectBaseUrl` for LAN OAuth handoff links)
- `PATCH /admin/settings` (supports `authMode`, `lanRedirectBaseUrl`, `registrationMode`, and `klipyApiKey`)
- `POST /admin/ownership/transfer`
- `GET /admin/moderation/logs`
- `GET /admin/shared-ips`

## Chat + Media

- `GET /channels?limit=75&after=<cursor>` (paginated)
- `POST /channels`
- `PATCH /channels/:channelId`
- `DELETE /channels/:channelId`
- `GET /channels/:channelId/messages?limit=40&before=<cursor>` (paginated)
- `POST /channels/:channelId/messages`
- `POST /channels/:channelId/typing`
- `PATCH /messages/:messageId`
- `DELETE /messages/:messageId`
- `POST /messages/:messageId/reactions`
- `POST /media/attachments`
- `GET /media/attachments/:attachmentId`
- `GET /media/gifs/search?q=...` (uses the configured Klipy or Giphy provider, with optional backup fallback)
- `GET /server/e2ee-key`
- `POST /server/e2ee-key`

Text message bodies can be sent as browser-encrypted envelopes. Authenticated clients claim or fetch the shared room key through `/server/e2ee-key`, then send:

```ts
type EncryptedMessageContent = {
  version: 1;
  algorithm: 'AES-GCM';
  keyId: string;
  nonce: string;
  ciphertext: string;
};
```

For encrypted messages, send `content: ""` plus `encryptedContent`. The API rejects requests that include both an encrypted envelope and plaintext body content.

## Moderation

- `GET /roles`
- `POST /roles`
- `PATCH /roles/:roleId`
- `DELETE /roles/:roleId`
- `GET /moderation/actions`
- `POST /moderation/actions`
- `PATCH /channels/:channelId/moderation`
- `GET /automod/rules`
- `POST /automod/rules`
- `PATCH /automod/rules/:ruleId`
- `DELETE /automod/rules/:ruleId`
- `GET /audit/logs`
- `GET /invites`
- `POST /invites`
- `DELETE /invites/:code`

## Voice

- `POST /voice/channels/:channelId/token`
- `POST /voice/channels/:channelId/join`
  - Joins an Opus/WebRTC SFU voice channel and returns the voice state, SFU session ID, router RTP capabilities, ICE servers, and existing producers.
- `POST /voice/channels/:channelId/leave`
- `POST /voice/channels/:channelId/transports`
- `POST /voice/transports/:transportId/connect`
- `POST /voice/transports/:transportId/produce`
- `PATCH /voice/producers/:producerId`
- `POST /voice/transports/:transportId/consume`
- `POST /voice/consumers/:consumerId/resume`
- `POST /voice/sessions/:sessionId/heartbeat`
- `PATCH /voice/state`
- `GET /voice/channels/:channelId/state`
- `GET /voice/diagnostics`

## Health and Metrics

- `GET /health`
- `GET /ready`
- `GET /admin/metrics`
