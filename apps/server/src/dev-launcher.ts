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

function run(command: string, args: string[], label: string) {
  const child = spawn(command, args, {
    cwd: serverRoot,
    env: {
      ...process.env,
      CURRENT_WEB_DIST_DIR: webDistDir,
      FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
    },
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
      env: {
        ...process.env,
        CURRENT_WEB_DIST_DIR: webDistDir,
        FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
      },
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
  await runOnce(pnpm, ['--filter', '@current/web', 'build'], 'web build');

  console.log('[launcher] Starting web build watcher and Current server...');
  run(pnpm, ['--filter', '@current/web', 'build:watch'], 'web watcher');
  run(pnpm, ['exec', 'tsx', 'watch', 'src/index.ts'], 'server');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
