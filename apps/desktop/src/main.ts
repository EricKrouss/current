import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function appendUniqueSwitchValues(name: string, values: string[]): void {
  const existingValues = app.commandLine
    .getSwitchValue(name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  app.commandLine.appendSwitch(name, Array.from(new Set([...existingValues, ...values])).join(','));
}

function isWaylandEnvironment(): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland';
}

function resolveLinuxOzonePlatform(): string | undefined {
  const explicit = process.env.CURRENT_OZONE_PLATFORM?.trim();
  if (explicit && explicit !== 'auto') {
    return explicit;
  }
  return isWaylandEnvironment() ? 'wayland' : undefined;
}

function configureHighRefreshRendering(): void {
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-oop-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  appendUniqueSwitchValues('enable-features', ['CanvasOopRasterization']);

  if (process.env.CURRENT_RENDER_BENCH_FLAGS === '1') {
    app.commandLine.appendSwitch('disable-frame-rate-limit');
    app.commandLine.appendSwitch('disable-gpu-vsync');
  }

  if (process.platform === 'linux') {
    const ozonePlatform = resolveLinuxOzonePlatform();

    if (ozonePlatform) {
      process.env.ELECTRON_OZONE_PLATFORM_HINT = ozonePlatform;
      if (ozonePlatform === 'wayland') {
        process.env.XDG_SESSION_TYPE = process.env.XDG_SESSION_TYPE || 'wayland';
        process.env.GDK_BACKEND = process.env.GDK_BACKEND || 'wayland,x11';
      }
      app.commandLine.appendSwitch('ozone-platform', ozonePlatform);
    } else {
      app.commandLine.appendSwitch('use-gl', 'desktop');
    }

    app.commandLine.appendSwitch('ozone-platform-hint', ozonePlatform ?? 'auto');
    appendUniqueSwitchValues('enable-features', [
      'UseOzonePlatform',
      'WebRTCPipeWireCapturer',
      'WaylandWindowDecorations',
      'WaylandPerSurfaceScale',
      'WaylandFractionalScaleV1',
    ]);

    if (ozonePlatform === 'wayland') {
      app.commandLine.appendSwitch('enable-wayland-ime');
      app.commandLine.appendSwitch('disable-vulkan');
      appendUniqueSwitchValues('disable-features', ['Vulkan']);
    }
  }
}

configureHighRefreshRendering();

interface ColorPickPoint {
  x?: number;
  y?: number;
}

function sanitizeColorPickPoint(point: ColorPickPoint): Electron.Rectangle {
  return {
    x: Math.max(0, Math.floor(Number(point.x) || 0)),
    y: Math.max(0, Math.floor(Number(point.y) || 0)),
    width: 1,
    height: 1,
  };
}

ipcMain.handle('current:pick-color-at-point', async (event, point: ColorPickPoint): Promise<string | null> => {
  const image = await event.sender.capturePage(sanitizeColorPickPoint(point));
  return image.isEmpty() ? null : image.toDataURL();
});

const renderSwitchNames = [
  'disable-frame-rate-limit',
  'disable-gpu-vsync',
  'disable-background-timer-throttling',
  'disable-renderer-backgrounding',
  'disable-backgrounding-occluded-windows',
  'enable-gpu-rasterization',
  'enable-oop-rasterization',
  'enable-zero-copy',
  'ignore-gpu-blocklist',
  'enable-features',
  'disable-features',
  'enable-wayland-ime',
  'disable-vulkan',
  'ozone-platform',
  'ozone-platform-hint',
  'use-gl',
];

function getRenderSwitchSnapshot(): Record<string, string | boolean> {
  return Object.fromEntries(
    renderSwitchNames.map((name) => {
      const value = app.commandLine.getSwitchValue(name);
      return [name, value || app.commandLine.hasSwitch(name)];
    }),
  );
}

async function logPerformanceDiagnostics(): Promise<void> {
  if (process.env.CURRENT_PERF_DIAG !== '1') {
    return;
  }

  const gpuInfo = await app.getGPUInfo('basic').catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));

  console.info('[Current perf diag]', {
    platform: process.platform,
    sessionType: process.env.XDG_SESSION_TYPE ?? null,
    waylandDisplay: Boolean(process.env.WAYLAND_DISPLAY),
    electronOzonePlatformHint: process.env.ELECTRON_OZONE_PLATFORM_HINT ?? null,
    currentOzonePlatform: process.env.CURRENT_OZONE_PLATFORM ?? null,
    ozonePlatform: app.commandLine.getSwitchValue('ozone-platform') || null,
    switches: getRenderSwitchSnapshot(),
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    gpuInfo,
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    title: 'Current',
    backgroundColor: '#0a111b',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  window.webContents.backgroundThrottling = false;

  const devUrl = process.env.CURRENT_WEB_URL ?? 'http://127.0.0.1:5173';

  if (process.env.CURRENT_DEV === '1') {
    void window.loadURL(devUrl);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    const webDistPath = join(__dirname, '../../web/dist/index.html');
    void window.loadURL(pathToFileURL(webDistPath).toString());
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  void logPerformanceDiagnostics();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
