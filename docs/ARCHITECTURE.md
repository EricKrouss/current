# Current Architecture

## Layers

- **Transport layer**
  - `apps/server/src/api`: HTTP routes and request validation
  - `apps/server/src/realtime`: WebSocket gateway + event replay
- **Domain layer**
  - `apps/server/src/services`, `apps/server/src/auth`, `apps/server/src/setup`, `apps/server/src/voice`
  - Business logic for chat, auth, moderation, setup, invites, and voice state
- **Persistence layer**
  - `apps/server/src/db/repositories`
  - SQL encapsulation for SQLite data access
- **Shared contracts**
  - `packages/types`: domain entities
  - `packages/protocol`: gateway event contracts
  - `packages/config`: versioned config schema/migration

## Runtime Components

- **API service (Fastify)**
  - Handles auth/session, setup wizard, channels/messages, moderation, voice endpoints
  - Auth mode is config-driven: `auth.mode=atproto` (Bluesky OAuth) or `auth.mode=lan` (local screen-name login)
  - Provides admin settings endpoints for GIF provider config, ownership transfer, moderation feed, and shared-IP insights
  - Exposes discoverable OAuth metadata at `/api/v1/auth/client-metadata.json` for HTTPS domain deployments
  - Supports LAN OAuth handoff flow for loopback-mode Bluesky auth (`/auth/lan/handoffs/*`) with configurable host link base URL
- **Gateway service (WebSocket)**
  - Broadcasts typed events with sequence IDs
  - Supports replay from `lastEventSeq`
- **Voice service**
  - Runs an embedded mediasoup SFU for Opus/WebRTC voice
  - Lazily creates one router per active voice channel and tears it down when empty
  - Uses the gateway for voice state, producer, and speaking updates
  - Supports direct UDP/TCP WebRTC with optional TURN and optional HTTPS for LAN browser microphone access
- **Metrics service**
  - Request/error/message/voice counters exposed at `/api/v1/admin/metrics`

## Clients

- `apps/web`: shared React UI for setup, auth, chat, voice, admin
  - Includes server-icon context menu entry for `Server Settings` admin control panel
- `apps/desktop`: Electron shell loading web client for desktop usage
