#!/usr/bin/env bash
set -euo pipefail

unset ELECTRON_OVERRIDE_DIST_PATH
unset ELECTRON_RUN_AS_NODE
unset ELECTRON_FORCE_IS_PACKAGED
unset ELECTRON_IS_DEV
unset ELECTRON_NO_ATTACH_CONSOLE

electron_args=()
enable_features=(
  "CanvasOopRasterization"
  "UseOzonePlatform"
  "WebRTCPipeWireCapturer"
)
disable_features=()

session_type="${XDG_SESSION_TYPE:-}"
session_type="${session_type,,}"
if [[ -n "${WAYLAND_DISPLAY:-}" || "${session_type}" == "wayland" ]]; then
  export XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-wayland}"
  export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-wayland}"
  export GDK_BACKEND="${GDK_BACKEND:-wayland,x11}"
  current_ozone_platform="${CURRENT_OZONE_PLATFORM:-wayland}"
  if [[ "${current_ozone_platform}" == "auto" ]]; then
    current_ozone_platform="wayland"
  fi
  export CURRENT_OZONE_PLATFORM="${current_ozone_platform}"
  electron_args+=(
    "--ozone-platform=${CURRENT_OZONE_PLATFORM}"
    "--ozone-platform-hint=${CURRENT_OZONE_PLATFORM}"
    "--enable-wayland-ime"
    "--disable-vulkan"
  )
  disable_features+=("Vulkan")
  enable_features+=(
    "WaylandWindowDecorations"
    "WaylandPerSurfaceScale"
    "WaylandFractionalScaleV1"
  )
else
  electron_args+=("--ozone-platform-hint=auto")
fi

features_csv="$(IFS=,; echo "${enable_features[*]}")"
electron_args+=("--enable-features=${features_csv}")
if [[ "${#disable_features[@]}" -gt 0 ]]; then
  disable_features_csv="$(IFS=,; echo "${disable_features[*]}")"
  electron_args+=("--disable-features=${disable_features_csv}")
fi

exec electron "${electron_args[@]}" ./dist/main.js "$@"
