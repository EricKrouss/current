import { contextBridge, ipcRenderer } from 'electron';

const isWayland =
  process.platform === 'linux' &&
  (Boolean(process.env.WAYLAND_DISPLAY) ||
    process.env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' ||
    process.env.CURRENT_OZONE_PLATFORM === 'wayland' ||
    process.env.ELECTRON_OZONE_PLATFORM_HINT === 'wayland');

contextBridge.exposeInMainWorld('currentDesktop', {
  platform: process.platform,
  isWayland,
  disableNativeEyeDropper: isWayland,
  pickColorAtPoint: (point: { x: number; y: number }) => ipcRenderer.invoke('current:pick-color-at-point', point),
});
