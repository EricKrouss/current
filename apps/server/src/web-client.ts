import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { lookup } from 'mime-types';

const here = dirname(fileURLToPath(import.meta.url));

export function resolveWebDistDir() {
  const candidates = [
    process.env.CURRENT_WEB_DIST_DIR,
    join(process.cwd(), '../web/dist'),
    join(process.cwd(), 'apps/web/dist'),
    join(here, '../../web/dist'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const distDir = resolve(candidate);
    if (existsSync(join(distDir, 'index.html'))) {
      return distDir;
    }
  }

  return undefined;
}

function isInside(baseDir: string, targetPath: string) {
  const path = relative(baseDir, targetPath);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function sendStaticFile(reply: FastifyReply, filePath: string, immutable = false) {
  try {
    const file = statSync(filePath);
    if (!file.isFile()) {
      return false;
    }

    const mimeType = lookup(filePath);
    if (mimeType) {
      reply.type(mimeType);
    }

    const body = readFileSync(filePath);
    reply.header('content-length', file.size);
    reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    reply.send(body);
    return true;
  } catch {
    return false;
  }
}

function isApiOrGatewayPath(pathname: string) {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/gateway' ||
    pathname.startsWith('/gateway/')
  );
}

async function serveWebClient(
  request: FastifyRequest,
  reply: FastifyReply,
  webDistDir: string,
) {
  const url = new URL(request.url, 'http://current.local');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    reply.code(400).send({ error: 'Invalid path.' });
    return;
  }

  if (isApiOrGatewayPath(pathname)) {
    reply.code(404).send({ error: 'Not found.' });
    return;
  }

  const indexPath = join(webDistDir, 'index.html');
  const requestedPath = resolve(webDistDir, `.${pathname}`);

  if (!isInside(webDistDir, requestedPath)) {
    reply.code(403).send({ error: 'Forbidden.' });
    return;
  }

  const isAsset = pathname.startsWith('/assets/');
  if (sendStaticFile(reply, requestedPath, isAsset)) {
    return;
  }

  if (extname(pathname)) {
    reply.code(404).send({ error: 'Not found.' });
    return;
  }

  sendStaticFile(reply, indexPath);
}

export function registerWebClientRoutes(
  app: FastifyInstance,
  webDistDir: string | false | undefined = resolveWebDistDir(),
) {
  const resolvedWebDistDir = webDistDir === false ? undefined : webDistDir;

  if (!resolvedWebDistDir) {
    app.get('/', async () => {
      return {
        name: 'Current API',
        version: '0.1.0',
        docs: '/api/v1/health',
        web: 'Run pnpm --filter @current/web build to serve the web GUI from this server.',
      };
    });
    return;
  }

  app.log.info(`Serving Current web GUI from ${resolvedWebDistDir}`);

  app.get('/', async (request, reply) => serveWebClient(request, reply, resolvedWebDistDir));
  app.get('/*', async (request, reply) => serveWebClient(request, reply, resolvedWebDistDir));
}
