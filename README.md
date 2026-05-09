# Current

Current is a local-first, Discord-style chat platform with browser + Electron clients, self-hosted community data, and Bluesky atproto OAuth identity.

## Highlights

- Local server ownership for chat, media, and voice metadata
- Browser-side encryption for new web-client text message bodies with a shared key available to authenticated users
- atproto OAuth-only authentication flow
- Text channels, DMs, reactions, attachments, GIF search (Tenor)
- Voice channel signaling and state (WebRTC SFU-ready config surface)
- Strong moderation baseline: roles, automod rules, invite controls, moderation actions, audit logs
- Setup wizard and admin studio UI
- Linux-first native hosting with `systemd` installer script

## Monorepo Structure

- `apps/server`: Fastify API, gateway, voice signaling, services, repositories
- `apps/web`: React/Vite app for setup, chat, voice, and admin controls
- `apps/desktop`: Electron shell wrapping the shared web UI
- `packages/types`: domain types shared across apps
- `packages/protocol`: typed gateway event contracts
- `packages/config`: versioned config schema + migration helpers
- `packages/ui`: reusable UI primitives
- `tests`: unit/integration/realtime/voice/load test suites

## Modularity Principles

- Transport adapters (`api`, `realtime`) only orchestrate request/response/event flow
- Domain services (`services`, `setup`, `voice`, `auth`) hold business logic
- Repositories isolate all SQL and persistence concerns
- Shared contracts live in workspace packages and are imported by all apps

## Quick Start

For a one-click local server, use the launcher for your OS:

- Windows: double-click `Current Server.cmd`
- macOS: double-click `Current Server.command`
- Linux: double-click `Current Server Linux.desktop`, or `Current Server Linux.sh` if your desktop environment prefers shell launchers

The launcher installs dependencies when needed, starts the server in a terminal, and keeps the terminal attached so you can stop it with `Ctrl+C`.
It will ask which server instance to run:

- Standard: the normal Current server using `apps/server/config/current.config.json`
- LAN: a separate LAN-only instance using `apps/server/config/current-lan.config.json`, `apps/server/data/lan/`, `apps/server/uploads/lan/`, and port `8081`

It will ask for a launch mode:

- Normal: builds once, then runs the server without source watchers
- Dev: builds/watches the web GUI and restarts the server on source changes

If the configured port is already in use, the launcher will stop before building and offer to open the existing server or retry after you close the other process.

Open `http://127.0.0.1:8080` for the standard instance, or `http://127.0.0.1:8081` for the LAN instance.

Manual equivalent:

```bash
pnpm install
pnpm launch:server:normal
# or
pnpm launch:server:dev
# or
pnpm launch:server:lan:normal
```

The server dev launcher builds and watches the web GUI, then serves it from the API server.
For API-only development, run `pnpm --filter @current/server dev:api` and start the Vite client separately with `pnpm --filter @current/web dev`.
For the old workspace-wide dev watchers, run `pnpm dev:workspace`.

Text messages are encrypted in the browser before they are sent. Authenticated clients automatically claim or fetch the shared room key so messages stay readable across browsers.

If Bluesky OAuth is not configured yet, use `Local Dev Sign-In` on the auth screen.
This is controlled by `auth.allowDevLogin` in server config (enabled by default for local testing).

## Desktop App

```bash
pnpm --filter @current/desktop build
pnpm --filter @current/desktop start
```

For dev mode (web + electron):

```bash
pnpm --filter @current/desktop dev
```

## Config

Server config is loaded from:

- `CURRENT_CONFIG_PATH` env var, or
- `config/current.config.json`

On first run, a default config file is generated automatically.

OAuth defaults to atproto loopback mode (no custom `atprotoClientId` required).
Use a `127.0.0.1` callback URL for local testing.

## Linux Native Install (`systemd`)

```bash
sudo ./scripts/install-current.sh
```

This installs dependencies, builds server packages, writes `/etc/systemd/system/current.service`, and starts the service.

## Tests

```bash
pnpm test
```

## Reliability Roadmap

- v1 GA target: stable for up to 500 concurrent users
- hardening milestone target: validated up to 2,000 concurrent users with expanded load/soak gates
