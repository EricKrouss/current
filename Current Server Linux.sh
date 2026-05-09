#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR" || exit 1

node "$ROOT_DIR/scripts/start-current-server.mjs"
CURRENT_EXIT_CODE=$?

if [[ "$CURRENT_EXIT_CODE" -ne 0 ]]; then
  echo
  read -r -p "Current server stopped with exit code $CURRENT_EXIT_CODE. Press Return to close this window."
fi

exit "$CURRENT_EXIT_CODE"
