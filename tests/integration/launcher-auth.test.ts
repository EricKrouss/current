import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '../helpers/test-app.js';

async function createDpopProof(input: {
  accessToken: string;
  htm: string;
  htu: string;
  jti: string;
}): Promise<string> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  return new SignJWT({
    ath: createHash('sha256').update(input.accessToken).digest('base64url'),
    htm: input.htm,
    htu: input.htu,
    iat: Math.floor(Date.now() / 1000),
    jti: input.jti,
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'dpop+jwt',
      jwk: publicJwk,
    })
    .sign(privateKey);
}

describe('launcher auth route', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires Gaia launcher DPoP credentials', async () => {
    const { app, close } = await createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/launcher',
      payload: {
        profile: {
          did: 'did:plc:launcher-test',
          handle: 'launcher.test',
        },
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: 'MISSING_LAUNCHER_TOKEN',
      },
    });

    await close();
  });

  it('stays disabled for LAN auth instances', async () => {
    const { app, context, close } = await createTestApp();
    const config = context.serverConfig.get();
    context.serverConfig.set({
      ...config,
      auth: {
        ...config.auth,
        mode: 'lan',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/launcher',
      payload: {
        profile: {
          did: 'did:plc:launcher-test',
          handle: 'launcher.test',
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'ATPROTO_AUTH_DISABLED',
      },
    });

    await close();
  });

  it('accepts a PDS resource proof when the launcher access token is not locally verifiable', async () => {
    const { app, close } = await createTestApp();
    const accessToken = 'opaque-atproto-access-token';
    const dpopProof = await createDpopProof({
      accessToken,
      htm: 'POST',
      htu: 'http://127.0.0.1:8080/api/v1/auth/launcher',
      jti: 'launcher-route-proof',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof URL ? input.href : String(input));
      if (url.href === 'https://plc.directory/did:plc:launcher-test') {
        return new Response(
          JSON.stringify({
            id: 'did:plc:launcher-test',
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: 'https://pds.example',
              },
            ],
          }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (url.pathname === '/xrpc/com.atproto.server.getSession') {
        return new Response(JSON.stringify({ did: 'did:plc:launcher-test' }), {
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          did: 'did:plc:launcher-test',
          handle: 'launcher.test',
          displayName: 'Launcher Test',
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/launcher',
      headers: {
        authorization: `DPoP ${accessToken}`,
        dpop: dpopProof,
        host: '127.0.0.1:8080',
      },
      payload: {
        profile: {
          did: 'did:plc:launcher-test',
          handle: 'launcher.test',
        },
        token: {
          issuer: 'https://bsky.social',
          audience: 'https://pds.example',
          scope: 'atproto transition:generic',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        resourceProof: {
          method: 'GET',
          url: 'https://pds.example/xrpc/com.atproto.server.getSession',
          dpopProof: 'resource-dpop-proof',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.cookies.some((cookie) => cookie.name === 'current_session')).toBe(true);
    expect(response.json()).toMatchObject({
      user: {
        did: 'did:plc:launcher-test',
        handle: 'launcher.test',
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://pds.example/xrpc/com.atproto.server.getSession'),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `DPoP ${accessToken}`,
          dpop: 'resource-dpop-proof',
        }),
      }),
    );

    await close();
  });

  it('rejects resource proofs from a server that is not the profile PDS', async () => {
    const { app, close } = await createTestApp();
    const accessToken = 'opaque-atproto-access-token';
    const dpopProof = await createDpopProof({
      accessToken,
      htm: 'POST',
      htu: 'http://127.0.0.1:8080/api/v1/auth/launcher',
      jti: 'launcher-wrong-pds-proof',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof URL ? input.href : String(input));
      if (url.href === 'https://plc.directory/did:plc:launcher-test') {
        return new Response(
          JSON.stringify({
            id: 'did:plc:launcher-test',
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: 'https://pds.example',
              },
            ],
          }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ did: 'did:plc:launcher-test' }), {
        headers: { 'content-type': 'application/json' },
      });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/launcher',
      headers: {
        authorization: `DPoP ${accessToken}`,
        dpop: dpopProof,
        host: '127.0.0.1:8080',
      },
      payload: {
        profile: {
          did: 'did:plc:launcher-test',
          handle: 'launcher.test',
        },
        resourceProof: {
          method: 'GET',
          url: 'https://evil.example/xrpc/com.atproto.server.getSession',
          dpopProof: 'resource-dpop-proof',
        },
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: 'LAUNCHER_AUTH_FAILED',
      },
    });

    await close();
  });
});
