#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Please run install-current.sh as root (sudo)."
  exit 1
fi

CURRENT_USER="${SUDO_USER:-$(whoami)}"
CURRENT_WORKDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_TEMPLATE="$CURRENT_WORKDIR/deploy/current.service"
SERVICE_TARGET="/etc/systemd/system/current.service"
CONFIG_DIR="/etc/current"
CONFIG_PATH="$CONFIG_DIR/current.config.json"

if [[ ! -f "$SERVICE_TEMPLATE" ]]; then
  echo "Missing service template: $SERVICE_TEMPLATE"
  exit 1
fi

mkdir -p "$CONFIG_DIR"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "Creating default config at $CONFIG_PATH"
  cat > "$CONFIG_PATH" <<'JSON'
{
  "version": 1,
  "server": {
    "name": "Current Server",
    "slug": "current-server",
    "host": "0.0.0.0",
    "port": 6414,
    "publicUrl": "http://127.0.0.1:6414",
    "registrationMode": "invite_only"
  },
  "auth": {
    "atprotoClientId": "",
    "redirectUri": "http://127.0.0.1:6414/api/v1/auth/oauth/callback",
    "authorizationEndpoint": "https://bsky.social/oauth/authorize",
    "tokenEndpoint": "https://bsky.social/oauth/token",
    "profileEndpoint": "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile",
    "scope": "atproto transition:generic",
    "cookieSecret": "change-me-super-secret-cookie-key-please",
    "allowDevLogin": true
  },
  "storage": {
    "sqlitePath": "apps/server/data/current.sqlite",
    "uploadDir": "apps/server/uploads",
    "mediaBackend": "local"
  },
  "media": {
    "maxAttachmentBytes": 10485760,
    "allowedMimePrefixes": ["image/", "video/", "audio/", "application/pdf"],
    "tenorApiKey": ""
  },
  "moderation": {
    "defaultSlowmodeSeconds": 0,
    "maxMentionsPerMessage": 8,
    "linkPolicy": "members_only"
  },
  "rtc": {
    "listenIp": "0.0.0.0",
    "announcedIp": "127.0.0.1",
    "udpMinPort": 40000,
    "udpMaxPort": 40100,
    "turnUrls": []
  },
  "observability": {
    "metricsEnabled": true,
    "logLevel": "info"
  }
}
JSON
fi

sed \
  -e "s|{{CURRENT_USER}}|$CURRENT_USER|g" \
  -e "s|{{CURRENT_WORKDIR}}|$CURRENT_WORKDIR|g" \
  "$SERVICE_TEMPLATE" > "$SERVICE_TARGET"

chown -R "$CURRENT_USER":"$CURRENT_USER" "$CURRENT_WORKDIR/apps/server/data" "$CURRENT_WORKDIR/apps/server/uploads" 2>/dev/null || true

cd "$CURRENT_WORKDIR"

if command -v pnpm >/dev/null 2>&1; then
  PM="pnpm"
elif command -v npm >/dev/null 2>&1; then
  PM="npm"
else
  echo "A package manager is required (pnpm or npm)."
  exit 1
fi

if [[ "$PM" == "pnpm" ]]; then
  pnpm install
  pnpm --filter @current/types build
  pnpm --filter @current/protocol build
  pnpm --filter @current/config build
  pnpm --filter @current/web build
  pnpm --filter @current/server build
else
  npm install
  npm run build --workspace=@current/types
  npm run build --workspace=@current/protocol
  npm run build --workspace=@current/config
  npm run build --workspace=@current/web
  npm run build --workspace=@current/server
fi

systemctl daemon-reload
systemctl enable current.service
systemctl restart current.service

echo "Current installed and started."
echo "Service status: systemctl status current.service"
echo "Config file: $CONFIG_PATH"
