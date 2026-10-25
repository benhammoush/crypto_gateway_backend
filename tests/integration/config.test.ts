/**
 * Configuration rejection and safe diagnostic regressions.
 * @packageDocumentation
 */

import { afterEach, expect, it, vi } from 'vitest';
import Ajv from 'ajv/dist/2020';
import document from '../../openapi.json';
import { config, ConfigurationError } from '../../src/config';
import worker from '../../src/index';
import { Env } from '../../src/types';

const secret = 'synthetic_secret_must_never_appear_1234567890';
const merchant = {
  id: 'fixture',
  apiKeyHash: 'a'.repeat(64),
  recipient: 'So11111111111111111111111111111111111111112',
};
const env: Env = {
  DB: new Proxy({} as D1Database, {
    /** Simulate a binding getter failure without disclosing its secret text. */
    get() {
      throw new Error('Unexpected database access.');
    },
  }),
  APP_ENV: 'dev',
  PAYMENTS_ENABLED: 'true',
  CHECKOUT_ORIGIN: 'https://checkout.example.org',
  CHECKOUT_SECRET: secret,
  SOLANA_RPC_URL: `https://devnet.helius-rpc.com/?api-key=${secret}`,
  JUPITER_API_KEY: secret,
  MERCHANTS_JSON: JSON.stringify([merchant]),
};
const validateError = new Ajv().compile(
  document.components.schemas.ErrorEnvelope,
);

afterEach(() => vi.unstubAllGlobals());

const failures: [string, Partial<Env>][] = [
  ['CHECKOUT_ORIGIN_INVALID', { CHECKOUT_ORIGIN: secret }],
  [
    'CHECKOUT_ORIGIN_INVALID',
    { CHECKOUT_ORIGIN: `https://checkout.example.org/${secret}` },
  ],
  ['RPC_URL_INVALID', { SOLANA_RPC_URL: undefined }],
  ['RPC_URL_INVALID', { SOLANA_RPC_URL: secret }],
  ['RPC_URL_INVALID', { SOLANA_RPC_URL: `"${env.SOLANA_RPC_URL}"` }],
  ['RPC_URL_NOT_HTTPS', { SOLANA_RPC_URL: `http://rpc.example.org/${secret}` }],
  [
    'RPC_URL_HAS_CREDENTIALS',
    { SOLANA_RPC_URL: `https://${secret}:password@rpc.example.org/` },
  ],
  ['MERCHANTS_JSON_INVALID', { MERCHANTS_JSON: secret }],
  ['MERCHANTS_JSON_INVALID', { MERCHANTS_JSON: JSON.stringify({ secret }) }],
  [
    'MERCHANT_CONFIGURATION_INVALID',
    { MERCHANTS_JSON: JSON.stringify([{ ...merchant, id: secret + '!' }]) },
  ],
  [
    'WEBHOOK_CONFIGURATION_INVALID',
    { MERCHANTS_JSON: JSON.stringify([{ ...merchant, webhookUrl: secret }]) },
  ],
  [
    'WEBHOOK_CONFIGURATION_INVALID',
    {
      MERCHANTS_JSON: JSON.stringify([
        { ...merchant, webhookUrl: secret, webhookSecret: secret },
      ]),
    },
  ],
  ['PRICE_KEY_MISSING', { JUPITER_API_KEY: undefined }],
  ['CHECKOUT_SECRET_TOO_SHORT', { CHECKOUT_SECRET: 'short' }],
  ['MERCHANTS_MISSING', { MERCHANTS_JSON: '[]' }],
];

it.each(failures)(
  'classifies %s without retaining sensitive values',
  (code, patch) => {
    try {
      config({ ...env, ...patch });
      expect.fail('Expected configuration rejection.');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({ diagnostic: code });
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(error).not.toHaveProperty('cause');
    }
  },
);

it.each(failures)(
  'exposes only the fixed %s diagnostic on dev GET /ready',
  async (code, patch) => {
    const fetch = vi.fn(() => {
      throw new Error('Unexpected provider request.');
    });
    vi.stubGlobal('fetch', fetch);
    const response = await worker.fetch(
      new Request('https://gateway.example.org/ready'),
      {
        ...env,
        ...patch,
      },
    );
    const text = await response.text();
    const body = JSON.parse(text) as { error: Record<string, unknown> };
    expect(response.status).toBe(503);
    expect(body.error).toEqual({
      code: 'NOT_CONFIGURED',
      message: 'Gateway configuration is incomplete.',
      requestId: response.headers.get('x-request-id'),
      diagnostic: code,
    });
    expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
    expect(body.error.requestId).toEqual(expect.any(String));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(text).not.toContain(secret);
    expect(validateError(body)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([
  ['production', '/ready', 'GET'],
  ['local', '/ready', 'GET'],
  ['dev', '/ready', 'POST'],
  ['dev', '/v1/payments', 'GET'],
  ['dev', '/v1/payments', 'POST'],
])(
  'keeps %s %s %s configuration errors generic',
  async (environment, path, method) => {
    const response = await worker.fetch(
      new Request(`https://gateway.example.org${path}`, { method }),
      {
        ...env,
        APP_ENV: environment,
        CHECKOUT_ORIGIN:
          environment === 'local'
            ? 'http://localhost:5173'
            : env.CHECKOUT_ORIGIN,
        SOLANA_RPC_URL: secret,
      },
    );
    expect(response.status).toBe(503);
    const body = await response.json<unknown>();
    expect(body).toEqual({
      error: {
        code: 'NOT_CONFIGURED',
        message: 'Gateway configuration is incomplete.',
        requestId: response.headers.get('x-request-id'),
      },
    });
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String));
  },
);

it('does not expose unexpected exceptions as diagnostic messages', async () => {
  const response = await worker.fetch(
    new Request('https://gateway.example.org/ready'),
    {
      ...env,
      MERCHANTS_JSON: JSON.stringify([{ ...merchant, recipient: { secret } }]),
    },
  );
  const text = await response.text();
  expect(response.status).toBe(503);
  const body = JSON.parse(text) as { error: unknown };
  expect(body.error).not.toHaveProperty('diagnostic');
  expect(text).not.toContain(secret);
});

it('retains configuration-only readiness without provider or database calls', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const rpc of [
    env.SOLANA_RPC_URL,
    `https://mainnet.helius-rpc.com/?api-key=${secret}`,
    'https://devnet.helius-rpc.com/',
    `  ${env.SOLANA_RPC_URL}  `,
  ]) {
    const response = await worker.fetch(
      new Request('https://gateway.example.org/ready'),
      {
        ...env,
        SOLANA_RPC_URL: rpc,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { ready: true, environment: 'dev', network: 'solana-devnet' },
    });
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects invalid environments and leaves health available', async () => {
  expect(() => config({ ...env, APP_ENV: 'staging' })).toThrow(
    ConfigurationError,
  );
  const response = await worker.fetch(
    new Request('https://gateway.example.org/health'),
    {
      ...env,
      SOLANA_RPC_URL: secret,
    },
  );
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain(secret);
});
