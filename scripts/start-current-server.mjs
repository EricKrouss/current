#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverRoot = join(rootDir, 'apps', 'server');
const webDistDir = join(rootDir, 'apps', 'web', 'dist');
const isWindows = process.platform === 'win32';
const checkOnly = process.argv.includes('--check');
const validModes = new Set(['normal', 'dev']);
const validInstances = new Set(['standard', 'lan']);
const standardConfigPath = join(serverRoot, 'config', 'current.config.json');
const lanConfigPath = join(serverRoot, 'config', 'current-lan.config.json');
const standardStorage = {
  sqlitePath: 'apps/server/data/current.sqlite',
  uploadDir: 'apps/server/uploads',
};
const lanStorage = {
  sqlitePath: 'apps/server/data/lan/current.sqlite',
  uploadDir: 'apps/server/uploads/lan',
};

function commandName(name) {
  return isWindows ? `${name}.cmd` : name;
}

function commandWorks(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'ignore',
    shell: false,
  });
  return result.status === 0;
}

function resolvePackageManager() {
  const pnpm = commandName('pnpm');
  if (commandWorks(pnpm)) {
    return {
      label: 'pnpm',
      command: pnpm,
      prefixArgs: [],
    };
  }

  const corepack = commandName('corepack');
  if (commandWorks(corepack, ['--version'])) {
    return {
      label: 'corepack pnpm',
      command: corepack,
      prefixArgs: ['pnpm'],
    };
  }

  return null;
}

function needsInstall() {
  return !existsSync(join(rootDir, 'node_modules', '.pnpm')) || !existsSync(join(rootDir, 'apps', 'server', 'node_modules'));
}

function resolveConfigPath(instance) {
  const configuredPath = process.env.CURRENT_CONFIG_PATH?.trim();
  if (!configuredPath) {
    return instance === 'lan' ? lanConfigPath : standardConfigPath;
  }
  return resolve(serverRoot, configuredPath);
}

function normalizeBrowserHost(host) {
  const trimmed = typeof host === 'string' ? host.trim() : '';
  if (!trimmed || trimmed === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (trimmed === '::' || trimmed === '[::]') {
    return '[::1]';
  }
  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

function defaultLaunchConfig(instance) {
  const port = instance === 'lan' ? 8081 : 8080;
  return {
    host: '0.0.0.0',
    port,
    url: `http://127.0.0.1:${port}`,
  };
}

async function readServerLaunchConfig(instance) {
  const fallback = defaultLaunchConfig(instance);
  const configPath = resolveConfigPath(instance);
  if (!existsSync(configPath)) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    const server = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.server : undefined;
    const host = typeof server?.host === 'string' ? server.host : fallback.host;
    const port = Number.isInteger(server?.port) && server.port > 0 ? server.port : fallback.port;
    const protocol = server?.tls?.enabled ? 'https' : 'http';
    const url = `${protocol}://${normalizeBrowserHost(host)}:${port}`;
    return {
      host,
      port,
      url,
    };
  } catch {
    return fallback;
  }
}

function buildLanDefaultConfig() {
  return {
    version: 1,
    server: {
      name: 'Current LAN Server',
      slug: 'current-lan-server',
      host: '0.0.0.0',
      port: 8081,
      publicUrl: 'http://127.0.0.1:8081',
      registrationMode: 'open_signup',
      tls: {
        enabled: false,
        certPath: '',
        keyPath: '',
      },
    },
    auth: {
      mode: 'lan',
      atprotoClientId: '',
      redirectUri: 'http://127.0.0.1:8081/api/v1/auth/oauth/callback',
      lanRedirectBaseUrl: '',
      authorizationEndpoint: 'https://bsky.social/oauth/authorize',
      tokenEndpoint: 'https://bsky.social/oauth/token',
      profileEndpoint: 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile',
      scope: 'atproto transition:generic',
      cookieSecret: 'change-me-super-secret-lan-cookie-key-please',
      allowDevLogin: true,
    },
    storage: {
      sqlitePath: lanStorage.sqlitePath,
      uploadDir: lanStorage.uploadDir,
      mediaBackend: 'local',
    },
    media: {
      maxAttachmentBytes: 10 * 1024 * 1024,
      allowedMimePrefixes: ['image/', 'video/', 'audio/', 'application/pdf'],
      gifProvider: 'klipy',
      gifFallbackProvider: 'none',
      klipyApiKey: '',
      giphyApiKey: '',
    },
    appearance: {
      backgroundAttachmentId: '',
      panelColor: '',
      ownMessageColor: '',
      otherMessageColor: '',
    },
    moderation: {
      defaultSlowmodeSeconds: 0,
      maxMentionsPerMessage: 8,
      linkPolicy: 'members_only',
    },
    rtc: {
      listenIp: '0.0.0.0',
      announcedIp: '127.0.0.1',
      udpMinPort: 40101,
      udpMaxPort: 40200,
      workerCount: 1,
      sessionTimeoutMs: 45_000,
      turnUrls: [],
    },
    observability: {
      metricsEnabled: true,
      logLevel: 'info',
    },
  };
}

function patchLanConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
    ? rawConfig
    : {};
  const server = config.server && typeof config.server === 'object' && !Array.isArray(config.server)
    ? config.server
    : {};
  const auth = config.auth && typeof config.auth === 'object' && !Array.isArray(config.auth)
    ? config.auth
    : {};
  const storage = config.storage && typeof config.storage === 'object' && !Array.isArray(config.storage)
    ? config.storage
    : {};
  const defaultConfig = buildLanDefaultConfig();

  return {
    ...defaultConfig,
    ...config,
    server: {
      ...defaultConfig.server,
      ...server,
      port: server.port === 8080 || server.port === undefined ? 8081 : server.port,
      publicUrl:
        typeof server.publicUrl === 'string' && server.publicUrl.length > 0 && !server.publicUrl.includes(':8080')
          ? server.publicUrl
          : 'http://127.0.0.1:8081',
    },
    auth: {
      ...defaultConfig.auth,
      ...auth,
      mode: 'lan',
      redirectUri:
        typeof auth.redirectUri === 'string' && auth.redirectUri.length > 0 && !auth.redirectUri.includes(':8080')
          ? auth.redirectUri
          : 'http://127.0.0.1:8081/api/v1/auth/oauth/callback',
    },
    storage: {
      ...defaultConfig.storage,
      ...storage,
      sqlitePath:
        storage.sqlitePath === standardStorage.sqlitePath || storage.sqlitePath === undefined
          ? lanStorage.sqlitePath
          : storage.sqlitePath,
      uploadDir:
        storage.uploadDir === standardStorage.uploadDir || storage.uploadDir === undefined
          ? lanStorage.uploadDir
          : storage.uploadDir,
    },
  };
}

async function ensureInstanceConfig(instance) {
  const configPath = resolveConfigPath(instance);
  if (instance !== 'lan' || checkOnly) {
    return configPath;
  }

  let nextConfig = buildLanDefaultConfig();
  if (existsSync(configPath)) {
    try {
      nextConfig = patchLanConfig(JSON.parse(await readFile(configPath, 'utf8')));
    } catch {
      nextConfig = buildLanDefaultConfig();
    }
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  return configPath;
}

function canListen(host, port) {
  return new Promise((resolveCanListen, rejectCanListen) => {
    const server = createServer();
    server.once('error', (error) => {
      resolveCanListen({
        available: false,
        code: error.code,
        message: error.message,
      });
    });
    server.once('listening', () => {
      server.close((error) => {
        if (error) {
          rejectCanListen(error);
          return;
        }
        resolveCanListen({ available: true });
      });
    });
    server.listen({
      host,
      port,
      exclusive: true,
    });
  });
}

function openUrl(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function ask(question) {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

function parseInstanceArg() {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--lan' || arg === 'lan') {
      return 'lan';
    }
    if (arg === '--standard' || arg === 'standard') {
      return 'standard';
    }
    if (arg.startsWith('--instance=')) {
      return arg.slice('--instance='.length).trim().toLowerCase();
    }
  }

  return process.env.CURRENT_SERVER_INSTANCE?.trim().toLowerCase();
}

async function chooseInstance() {
  const requestedInstance = parseInstanceArg();
  if (requestedInstance) {
    if (validInstances.has(requestedInstance)) {
      return requestedInstance;
    }
    throw new Error(`Unknown server instance "${requestedInstance}". Use standard or lan.`);
  }

  if (checkOnly) {
    return 'standard';
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return 'standard';
  }

  console.log('');
  console.log('Choose server instance:');
  console.log('  1) Standard - normal Current server using the standard config/data');
  console.log('  2) LAN      - separate LAN-only server using its own config/data on port 8081');

  const answer = (await ask('Server instance [1/standard, 2/lan] (default: standard): ')).trim().toLowerCase();
  if (!answer || answer === '1' || answer === 'standard' || answer === 's') {
    return 'standard';
  }
  if (answer === '2' || answer === 'lan' || answer === 'l') {
    return 'lan';
  }
  throw new Error(`Unknown server instance "${answer}". Use standard or lan.`);
}

function localLanUrls(port) {
  const urls = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) {
        continue;
      }
      urls.push(`http://${address.address}:${port}`);
    }
  }
  return urls;
}

async function ensurePortAvailable(config) {
  while (true) {
    const status = await canListen(config.host, config.port);
    if (status.available) {
      return true;
    }

    if (status.code !== 'EADDRINUSE') {
      throw new Error(`Could not check ${config.host}:${config.port}: ${status.message}`);
    }

    console.log('');
    console.log(`[Current] Port ${config.port} is already in use on ${config.host}.`);
    console.log(`[Current] Another Current server may already be running at ${config.url}.`);

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(`Port ${config.port} is busy. Stop the process using it, then run the launcher again.`);
    }

    console.log('');
    console.log('What would you like to do?');
    console.log('  1) Open the existing server and exit');
    console.log('  2) I stopped the other process, retry the port check');
    console.log('  3) Exit');
    const answer = (await ask('Choose [1/open, 2/retry, 3/exit] (default: open): ')).trim().toLowerCase();

    if (!answer || answer === '1' || answer === 'open' || answer === 'o') {
      openUrl(config.url);
      console.log(`[Current] Opened ${config.url}.`);
      return false;
    }

    if (answer === '2' || answer === 'retry' || answer === 'r') {
      continue;
    }

    if (answer === '3' || answer === 'exit' || answer === 'e') {
      return false;
    }

    console.log(`[Current] Unknown choice "${answer}".`);
  }
}

function parseModeArg() {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dev' || arg === 'dev') {
      return 'dev';
    }
    if (arg === '--normal' || arg === 'normal') {
      return 'normal';
    }
    if (arg.startsWith('--mode=')) {
      return arg.slice('--mode='.length).trim().toLowerCase();
    }
  }

  return process.env.CURRENT_LAUNCH_MODE?.trim().toLowerCase();
}

async function chooseMode() {
  const requestedMode = parseModeArg();
  if (requestedMode) {
    if (validModes.has(requestedMode)) {
      return requestedMode;
    }
    throw new Error(`Unknown launch mode "${requestedMode}". Use normal or dev.`);
  }

  if (checkOnly) {
    return 'normal';
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return 'normal';
  }

  console.log('');
  console.log('Choose launch mode:');
  console.log('  1) Normal - builds once and runs the server without watchers');
  console.log('  2) Dev    - builds/watches the web GUI and restarts the server on source changes');

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await readline.question('Start mode [1/normal, 2/dev] (default: normal): ')).trim().toLowerCase();
    if (!answer || answer === '1' || answer === 'normal' || answer === 'n') {
      return 'normal';
    }
    if (answer === '2' || answer === 'dev' || answer === 'd') {
      return 'dev';
    }
    throw new Error(`Unknown launch mode "${answer}". Use normal or dev.`);
  } finally {
    readline.close();
  }
}

function run(command, args, label, extraEnv = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: {
        ...process.env,
        FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
        ...extraEnv,
      },
      stdio: 'inherit',
      shell: false,
    });

    child.on('error', (error) => {
      rejectRun(error);
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      const reason = signal ? signal : `exit code ${code ?? 1}`;
      rejectRun(new Error(`${label} stopped with ${reason}`));
    });
  });
}

async function buildForNormalMode(pm) {
  console.log('[Current] Building production server assets...');
  await run(...pm(['--filter', '@current/types', 'build']), 'types build');
  await run(...pm(['--filter', '@current/protocol', 'build']), 'protocol build');
  await run(...pm(['--filter', '@current/config', 'build']), 'config build');
  await run(...pm(['--filter', '@current/web', 'build']), 'web build');
  await run(...pm(['--filter', '@current/server', 'build']), 'server build');
}

async function main() {
  if (!existsSync(join(rootDir, 'package.json'))) {
    throw new Error(`Could not find Current repo root from ${rootDir}`);
  }

  const packageManager = resolvePackageManager();
  if (!packageManager) {
    throw new Error(
      [
        'Could not find pnpm.',
        'Install Node.js 20+ from https://nodejs.org, then run "corepack enable" once, or install pnpm directly.',
      ].join(' '),
    );
  }

  const pm = (args) => [packageManager.command, [...packageManager.prefixArgs, ...args]];
  const instance = await chooseInstance();
  const configPath = await ensureInstanceConfig(instance);
  const mode = await chooseMode();
  const launchConfig = await readServerLaunchConfig(instance);

  console.log(`[Current] Repo: ${rootDir}`);
  console.log(`[Current] Package manager: ${packageManager.label}`);
  console.log(`[Current] Instance: ${instance}`);
  console.log(`[Current] Config: ${configPath}`);
  console.log(`[Current] Mode: ${mode}`);
  console.log(`[Current] The server will be available at ${launchConfig.url} after startup.`);
  if (instance === 'lan') {
    const urls = localLanUrls(launchConfig.port);
    if (urls.length > 0) {
      console.log(`[Current] LAN clients can try: ${urls.join(', ')}`);
    }
  }

  if (checkOnly) {
    console.log('[Current] Launcher check passed.');
    return;
  }

  const shouldStart = await ensurePortAvailable(launchConfig);
  if (!shouldStart) {
    return;
  }

  if (needsInstall()) {
    console.log('[Current] Installing dependencies. This is only needed on first launch or after dependency changes.');
    await run(...pm(['install']), 'dependency install');
  }

  if (mode === 'dev') {
    console.log('[Current] Starting dev server with source watchers. Press Ctrl+C in this terminal to stop it.');
    await run(...pm(['dev']), 'Current dev server', {
      CURRENT_CONFIG_PATH: configPath,
      CURRENT_SERVER_INSTANCE: instance,
    });
    return;
  }

  await buildForNormalMode(pm);
  console.log('[Current] Starting normal server. Press Ctrl+C in this terminal to stop it.');
  await run(
    ...pm(['--filter', '@current/server', 'start']),
    'Current normal server',
    {
      CURRENT_CONFIG_PATH: configPath,
      CURRENT_SERVER_INSTANCE: instance,
      CURRENT_WEB_DIST_DIR: webDistDir,
    },
  );
}

main().catch((error) => {
  console.error(`[Current] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
