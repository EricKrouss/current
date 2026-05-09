import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

describe('web client hosting', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it('serves the built web GUI and keeps API misses as JSON 404s', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'current-web-dist-'));
    mkdirSync(join(distDir, 'assets'), { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><div id="root">Current</div>');
    writeFileSync(join(distDir, 'assets/app.js'), 'console.log("current");');

    const { app, close } = await createTestApp({ webDistDir: distDir });
    cleanup.push(close);

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toContain('text/html');
    expect(root.body).toContain('Current');

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('text/javascript');
    expect(asset.headers['cache-control']).toContain('immutable');

    const clientRoute = await app.inject({ method: 'GET', url: '/channels/general' });
    expect(clientRoute.statusCode).toBe(200);
    expect(clientRoute.body).toContain('Current');

    const apiMiss = await app.inject({ method: 'GET', url: '/api/v1/not-real' });
    expect(apiMiss.statusCode).toBe(404);
    expect(apiMiss.headers['content-type']).toContain('application/json');
  });
});
