import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = existsSync(join(here, 'package.json')) ? here : join(here, '..');
const webDistDir = join(serverRoot, '../web/dist');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const children = new Set<ChildProcess>();
let shuttingDown = false;

function parsePortOverride(): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('Missing value for --port.');
      }
      return normalizePort(value);
    }
    if (arg.startsWith('--port=')) {
      return normalizePort(arg.slice('--port='.length));
    }
  }

  const envValue = process.env.CURRENT_PORT ?? process.env.CURRENT_SERVER_PORT ?? process.env.PORT;
  return envValue ? normalizePort(envValue) : undefined;
}

function normalizePort(value: string): string {
  const trimmed = value.trim();
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${value}". Use a number from 1 to 65535.`);
  }
  return String(port);
}

const portOverride = parsePortOverride();
const childEnv = {
  ...process.env,
  ...(portOverride ? { CURRENT_PORT: portOverride } : {}),
  CURRENT_WEB_DIST_DIR: webDistDir,
  FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
};

function run(command: string, args: string[], label: string) {
  const child = spawn(command, args, {
    cwd: serverRoot,
    env: childEnv,
    stdio: 'inherit',
  });

  children.add(child);

  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      const reason = signal ? signal : `exit code ${code ?? 1}`;
      console.error(`[launcher] ${label} stopped with ${reason}`);
      shutdown(code ?? 1);
    }
  });

  return child;
}

function runOnce(command: string, args: string[], label: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: serverRoot,
      env: childEnv,
      stdio: 'inherit',
    });

    children.add(child);

    child.on('exit', (code, signal) => {
      children.delete(child);
      if (code === 0) {
        resolve();
        return;
      }

      const reason = signal ? signal : `exit code ${code ?? 1}`;
      reject(new Error(`${label} failed with ${reason}`));
    });
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    child.kill('SIGTERM');
  }

  setTimeout(() => {
    for (const child of children) {
      child.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, 750).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  console.log('[launcher] Building web GUI...');
  if (portOverride) {
    console.log(`[launcher] Server port override: ${portOverride}`);
  }
  await runOnce(pnpm, ['--filter', '@current/web', 'build'], 'web build');

  console.log('[launcher] Starting web build watcher and Current server...');
  run(pnpm, ['--filter', '@current/web', 'build:watch'], 'web watcher');
  run(pnpm, ['exec', 'tsx', 'watch', 'src/index.ts'], 'server');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
