/**
 * Gateway payment lifecycle, settlement and HTTP boundary regressions.
 * @packageDocumentation
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrate, seedMerchant, fixtureKeys } from '../fixtures';
import {
  encryptWebhookSecret,
  merchantKeyring,
} from '../../src/merchant-crypto';
import { validateWebhookUrl } from '../../src/merchants';
import worker from '../../src/index';
import { config } from '../../src/config';
import { getPayment, retryVerification, settle } from '../../src/payments';
import { SOL_MINT } from '../../src/price';
import { base58Length } from '../../src/security';
import {
  DEVNET_GENESIS,
  MEMO_PROGRAM,
  ParsedTransaction,
  validateTransfer,
} from '../../src/solana';
import { Env, Payment } from '../../src/types';
import document from '../../openapi.json';
import { deliverWebhooks, webhookSignature } from '../../src/webhooks';
import Ajv from 'ajv/dist/2020';

const schemas: unknown = JSON.parse(
  JSON.stringify(document.components.schemas).replaceAll(
    '#/components/schemas/',
    '#/$defs/',
  ),
);
const ajv = new Ajv();
ajv.addSchema({
  $id: 'gateway',
  $defs: schemas,
});
const validatePayment = ajv.compile({ $ref: 'gateway#/$defs/PaymentEnvelope' });
const validateReferencePrice = ajv.compile({
  $ref: 'gateway#/$defs/ReferencePriceEnvelope',
});

const credential = 'fixture_merchant_credential_1234567890';
const recipient = 'So11111111111111111111111111111111111111112';
const signature = '1'.repeat(64);
const otherSignature = '1'.repeat(63) + '2';
let mf: Miniflare;
let env: Env;
let transaction: ParsedTransaction | null = null;
let fetchMock =
  vi.fn<(url: string, options?: RequestInit) => Promise<Response>>();

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("fixture") } }',
      compatibilityDate: '2026-10-04',
      d1Databases: { DB: 'crypto-gateway-tests' },
    }),
  );
  const db = await mf.getD1Database('DB');
  await migrate(db);
  env = {
    DB: db,
    APP_ENV: 'local',
    PAYMENTS_ENABLED: 'true',
    CHECKOUT_ORIGIN: 'http://localhost:5173',
    CHECKOUT_SECRET: 'fixture_checkout_secret_12345678901234567890',
    SOLANA_RPC_URL: 'https://rpc.example.org',
    JUPITER_API_KEY: 'fixture-price-key',
    MERCHANT_ENCRYPTION_KEYS: fixtureKeys,
    WEBHOOK_HOSTS: 'merchant.example.org',
  };
}, 30_000);

beforeEach(async () => {
  await env.DB.batch(
    [
      'events',
      'attempts',
      'payments',
      'rate_limits',
      'merchant_audit',
      'merchants',
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  await seedMerchant(env.DB, 'merchant', credential, recipient);
  transaction = null;
  fetchMock = vi.fn((url: string, options?: RequestInit) => {
    if (String(url).startsWith('https://api.jup.ag/'))
      return Promise.resolve(
        Response.json({
          [SOL_MINT]: { usdPrice: '150.25', blockId: 123, decimals: 9 },
        }),
      );
    if (typeof options?.body !== 'string')
      return Promise.reject(new Error('Unexpected upstream body.'));
    const body = JSON.parse(options.body) as { method?: unknown };
    if (body.method === 'getGenesisHash')
      return Promise.resolve(Response.json({ result: DEVNET_GENESIS }));
    if (body.method === 'getTransaction')
      return Promise.resolve(Response.json({ result: transaction }));
    return Promise.reject(new Error('Unexpected external request.'));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await mf?.dispose();
});

/** Invoke the gateway with controlled request inputs and isolated bindings.
 * @param path - Local gateway route under test.
 * @param token - Synthetic merchant or checkout credential.
 * @param body - Optional JSON request body; omitted for GETs.
 * @param key - Synthetic idempotency key for payment creation.
 * @returns HTTP status and parsed response after validating successful payment envelopes.
 */
async function call(
  path: string,
  token = credential,
  body?: unknown,
  key = 'fixture_idempotency_key',
) {
  const request = new Request(`http://localhost:8787${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await worker.fetch(request, env);
  const parsed = await response.json<{
    data: Record<string, unknown>;
    error: { code: string };
  }>();
  if (response.ok)
    expect(
      validatePayment(parsed),
      JSON.stringify(validatePayment.errors),
    ).toBe(true);
  return { status: response.status, body: parsed };
}

it('returns a bounded public reference without creating or changing payments', async () => {
  const created = await call('/v1/payments', credential, {
    usdCents: 1000,
    merchantReference: 'price-reference',
  });
  expect(created.status).toBe(200);
  const before = await env.DB.prepare('SELECT * FROM payments').all();
  const response = await worker.fetch(
    new Request('http://localhost:8787/v1/price', {
      headers: { origin: env.CHECKOUT_ORIGIN! },
    }),
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('access-control-allow-origin')).toBe(
    env.CHECKOUT_ORIGIN,
  );
  const body = await response.json<{
    data: { usdPrice: string; blockId: number; fetchedAt: number };
  }>();
  expect(validateReferencePrice(body)).toBe(true);
  expect(body.data).toEqual({
    usdPrice: '150.25',
    blockId: 123,
    fetchedAt: body.data.fetchedAt,
  });
  expect(Math.abs(Date.now() - body.data.fetchedAt)).toBeLessThan(1000);
  expect(
    (await env.DB.prepare('SELECT * FROM payments').all()).results,
  ).toEqual(before.results);
  expect(fetchMock).toHaveBeenLastCalledWith(
    expect.stringContaining('https://api.jup.ag/'),
    expect.objectContaining({ headers: { 'x-api-key': 'fixture-price-key' } }),
  );
  expect(JSON.stringify(body)).not.toContain('fixture-price-key');
});

it('guards reference reads with origin, enablement, method and rate limits before provider work', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_010_000);
  const url = 'http://localhost:8787/v1/price';
  expect(
    (
      await worker.fetch(
        new Request(url, { headers: { origin: 'https://evil.example' } }),
        env,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await worker.fetch(new Request(url), {
        ...env,
        PAYMENTS_ENABLED: 'false',
      })
    ).status,
  ).toBe(503);
  expect(
    (await worker.fetch(new Request(url, { method: 'POST' }), env)).ok,
  ).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  for (let i = 0; i < 6; i++)
    expect((await worker.fetch(new Request(url), env)).status).toBe(200);
  expect((await worker.fetch(new Request(url), env)).status).toBe(429);
  expect(fetchMock).toHaveBeenCalledTimes(6);
});

it('enforces the global reference budget across different client IPs', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_010_000);
  const bucket = Math.floor(Date.now() / 60_000);
  const { sha256 } = await import('../../src/security');
  await env.DB.prepare(
    'INSERT INTO rate_limits (key, count, expires_at) VALUES (?, ?, ?)',
  )
    .bind(await sha256(`price:global:${bucket}`), 60, (bucket + 2) * 60_000)
    .run();
  const response = await worker.fetch(
    new Request('http://localhost:8787/v1/price', {
      headers: { 'cf-connecting-ip': '192.0.2.123' },
    }),
    env,
  );
  expect(response.status).toBe(429);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('sanitizes reference provider failures', async () => {
  fetchMock.mockRejectedValueOnce(new Error('private provider details'));
  const response = await worker.fetch(
    new Request('http://localhost:8787/v1/price'),
    env,
  );
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('PRICE_UNAVAILABLE');
});

it.each(['true', 'false'])(
  'checks dev log lookup with payments enabled=%s, authentication, rate limits and no payment or provider work',
  async (PAYMENTS_ENABLED) => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dev = {
      ...env,
      APP_ENV: 'dev',
      PAYMENTS_ENABLED,
      CHECKOUT_ORIGIN: 'https://checkout.example.com',
    };
    const url =
      'https://api.example.com/v1/support/log-check?private=never-log-this';
    /** Build a synthetic log check without real credentials.
     * @param token - Fixture authorization input.
     * @param method - Method under test.
     * @returns Synthetic request carrying a URL canary.
     */
    const request = (token: string, method = 'POST') =>
      new Request(url, {
        method,
        headers: { authorization: `Bearer ${token}` },
      });
    for (const APP_ENV of ['local', 'production']) {
      const unavailable = await worker.fetch(request(credential), {
        ...dev,
        APP_ENV,
        PAYMENTS_ENABLED: 'true',
        CHECKOUT_ORIGIN:
          APP_ENV === 'local' ? env.CHECKOUT_ORIGIN : dev.CHECKOUT_ORIGIN,
      });
      expect(unavailable.status).toBe(404);
    }
    expect((await worker.fetch(request('invalid'), dev)).status).toBe(401);
    expect((await worker.fetch(request(credential, 'GET'), dev)).status).toBe(
      404,
    );
    expect(logs).not.toHaveBeenCalled();
    const result = await worker.fetch(request(credential), dev);
    expect(result.status).toBe(500);
    const body = await result.json<{
      error: { code: string; requestId: string };
    }>();
    expect(body.error.code).toBe('SUPPORT_LOG_CHECK');
    expect(logs).toHaveBeenCalledExactlyOnceWith({
      event: 'api.failure',
      requestId: result.headers.get('x-request-id'),
      operation: 'support_log_check',
      code: 'SUPPORT_LOG_CHECK',
    });
    expect(body.error.requestId).toBe(result.headers.get('x-request-id'));
    expect((await worker.fetch(request(credential), dev)).status).toBe(429);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM payments').first(
        'count',
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM attempts').first(
        'count',
      ),
    ).toBe(0);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM events').first(
        'count',
      ),
    ).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    if (PAYMENTS_ENABLED === 'false') {
      const payment = await worker.fetch(
        new Request('https://api.example.com/v1/payments', {
          method: 'POST',
          headers: { authorization: `Bearer ${credential}` },
        }),
        dev,
      );
      expect(payment.status).toBe(503);
      expect(await payment.json()).toMatchObject({
        error: { code: 'PAYMENTS_DISABLED' },
      });
      expect(logs).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  },
);

/** Create a fixture payment through the HTTP boundary under test.
 * @param key - Synthetic merchant-scoped idempotency key.
 * @param cents - Integer USD cents to quote.
 * @returns The fixture payment, identifier and checkout capability.
 */
async function create(key = 'fixture_idempotency_key', cents = 1000) {
  const result = await call(
    '/v1/payments',
    credential,
    { usdCents: cents, merchantReference: 'invoice-1' },
    key,
  );
  expect(result.status).toBe(200);
  const id = result.body.data.id as string;
  const token = new URL(result.body.data.checkoutUrl as string).hash.slice(1);
  return {
    id,
    token,
    view: result.body.data,
    payment: await getPayment(env.DB, id),
  };
}

/** Build controlled finalized transfer evidence for the selected payment.
 * @param payment - Persisted fixture payment whose amount and memo must match.
 * @param sig - Candidate signature included in the finalized evidence.
 * @returns A controlled parsed transaction for settlement validation.
 */
function transfer(payment: Payment, sig = signature): ParsedTransaction {
  return {
    blockTime: Math.floor(payment.created_at / 1000),
    meta: {
      err: null,
      preBalances: [1_000_000_000, 0],
      postBalances: [1, Number(payment.lamports)],
    },
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: [
          { pubkey: 'payer', signer: true },
          { pubkey: recipient, signer: false },
        ],
        instructions: [
          {
            programId: '11111111111111111111111111111111',
            parsed: {
              type: 'transfer',
              info: {
                source: 'payer',
                destination: recipient,
                lamports: Number(payment.lamports),
              },
            },
          },
          { programId: MEMO_PROGRAM, parsed: `crypto_gateway:${payment.id}` },
        ],
      },
    },
  };
}

describe('checkout RPC authorization and limits', () => {
  it('allows the SDK metadata header in approved-origin preflight only', async () => {
    /** Issue a CORS preflight from the selected test origin.
     * @param origin - Browser origin to test against checkout CORS policy.
     * @returns The gateway's preflight response.
     */
    const preflight = (origin: string) =>
      worker.fetch(
        new Request(
          'http://localhost:8787/v1/checkout/22222222-2222-4222-8222-222222222222/rpc',
          {
            method: 'OPTIONS',
            headers: {
              origin,
              'access-control-request-method': 'POST',
              'access-control-request-headers':
                'authorization,content-type,solana-client',
            },
          },
        ),
        env,
      );
    const approved = await preflight('http://localhost:5173');
    expect(approved.status).toBe(200);
    expect(approved.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5173',
    );
    const headers = approved.headers
      .get('access-control-allow-headers')!
      .toLowerCase()
      .split(/,\s*/);
    expect(headers).toEqual(
      expect.arrayContaining([
        'authorization',
        'content-type',
        'solana-client',
      ]),
    );
    const rejected = await preflight('https://attacker.example.org');
    expect(rejected.status).toBe(403);
    expect(rejected.headers.has('access-control-allow-origin')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** Exercise checkout RPC forwarding using the fixture payment capability.
   * @param id - Fixture payment identifier.
   * @param token - Synthetic checkout capability.
   * @param body - Controlled JSON-RPC request, including invalid-input fixtures.
   * @param origin - Browser origin to exercise CORS and rate limits.
   * @returns The gateway RPC response without reaching a real provider.
   */
  async function rpcCall(
    id: string,
    token: string,
    body: unknown = {
      jsonrpc: '2.0',
      id: 7,
      method: 'getGenesisHash',
      params: [],
    },
    origin = 'http://localhost:5173',
  ) {
    return worker.fetch(
      new Request(`http://localhost:8787/v1/checkout/${id}/rpc`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          origin,
        },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  it('requires the owning checkout capability and rejects batches/origins', async () => {
    const { id, token } = await create();
    const other = await create('another_checkout_key');
    fetchMock.mockClear();
    for (const wrong of [credential, other.token, 'x'.repeat(64)]) {
      expect((await rpcCall(id, wrong)).status).toBe(401);
    }
    expect((await rpcCall(id, token, [])).status).toBe(400);
    expect(
      (await rpcCall(id, token, { padding: 'x'.repeat(4097) })).status,
    ).toBe(413);
    expect(
      (await rpcCall(id, token, {}, 'https://attacker.example.org')).status,
    ).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(
      Response.json({ jsonrpc: '2.0', id: 1, result: DEVNET_GENESIS }),
    );
    const response = await rpcCall(id, token);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5173',
    );
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: DEVNET_GENESIS,
    });
  });

  // Repeated local D1 requests need the same bounded budget as the aggregate-limit test.
  it('bounds upstream calls per checkout and rejects inactive payments', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(
      Math.floor(Date.now() / 60_000) * 60_000 + 1,
    );
    const { id, token } = await create();
    const inactive = await create('inactive_checkout_key');
    fetchMock.mockClear();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json({ jsonrpc: '2.0', id: 1, result: DEVNET_GENESIS }),
      ),
    );
    for (let i = 0; i < 12; i++)
      expect((await rpcCall(id, token)).status).toBe(200);
    expect((await rpcCall(id, token)).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(12);
    await env.DB.prepare('UPDATE payments SET expires_at = 0 WHERE id = ?')
      .bind(inactive.id)
      .run();
    fetchMock.mockClear();
    expect((await rpcCall(inactive.id, inactive.token)).status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (
        await worker.fetch(
          new Request(`http://localhost:8787/v1/checkout/${id}/rpc`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body: '{}',
          }),
          { ...env, PAYMENTS_ENABLED: 'false' },
        )
      ).status,
    ).toBe(503);
  }, 30_000);
});

it('bounds aggregate RPC use across checkout capabilities', async () => {
  const payments = [];
  for (let i = 0; i < 6; i++)
    payments.push(await create(`rpc_global_fixture_${i}`));
  fetchMock.mockClear();
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      Response.json({ jsonrpc: '2.0', id: 1, result: DEVNET_GENESIS }),
    ),
  );
  const start = Math.floor(Date.now() / 60_000) * 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(start + 1);
  let count = 0;
  for (const { id, token } of payments) {
    for (let i = 0; i < 12; i++) {
      const response = await worker.fetch(
        new Request(`http://localhost:8787/v1/checkout/${id}/rpc`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getGenesisHash',
            params: [],
          }),
        }),
        env,
      );
      expect(response.status).toBe(++count <= 60 ? 200 : 429);
    }
  }
  expect(fetchMock).toHaveBeenCalledTimes(60);
}, 30_000);

describe('pricing', () => {
  it('fails closed on invalid provider data', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ result: DEVNET_GENESIS })),
    );
    const result = await call('/v1/payments', credential, {
      usdCents: 100,
      merchantReference: 'ref',
    });
    expect(result.status).toBe(503);
    expect(
      (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM payments').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });
});

describe('merchant API', () => {
  it('creates idempotently, rejects conflicts, and never reprices an existing request', async () => {
    const first = await create();
    fetchMock.mockRejectedValue(new Error('Provider unavailable.'));
    const repeated = await create();
    expect(repeated.id).toBe(first.id);
    expect(repeated.view.checkoutUrl).toBe(first.view.checkoutUrl);
    const conflict = await call('/v1/payments', credential, {
      usdCents: 2000,
      merchantReference: 'invoice-1',
    });
    expect(conflict.status).toBe(409);
  });
  it('handles concurrent creates with one record', async () => {
    const [a, b] = await Promise.all([create(), create()]);
    expect(a.id).toBe(b.id);
  });
  it('rejects credentials, cross-merchant reads, and merchant use of checkout tokens', async () => {
    const current = await create();
    expect(
      (await call(`/v1/payments/${current.id}`, current.token)).status,
    ).toBe(401);
    expect((await call(`/v1/checkout/${current.id}`, credential)).status).toBe(
      401,
    );
    const other = 'fixture_other_merchant_credential_1234567890';
    await seedMerchant(env.DB, 'other', other, recipient);
    const result = await worker.fetch(
      new Request(`http://localhost/v1/payments/${current.id}`, {
        headers: { authorization: `Bearer ${other}` },
      }),
      env,
    );
    expect(result.status).toBe(404);
  });
  it('rejects browser origins and unexpected request fields', async () => {
    const rejected = await worker.fetch(
      new Request('http://localhost/v1/payments', {
        headers: { origin: 'https://evil.example' },
      }),
      env,
    );
    expect(rejected.status).toBe(403);
    expect(
      (
        await call('/v1/payments', credential, {
          usdCents: 100,
          merchantReference: 'ref',
          recipient: 'override',
        })
      ).status,
    ).toBe(400);
  });
  it('rejects wrong network and disabled configuration', async () => {
    fetchMock.mockResolvedValue(Response.json({ result: 'mainnet' }));
    expect(
      (
        await call('/v1/payments', credential, {
          usdCents: 100,
          merchantReference: 'ref',
        })
      ).status,
    ).toBe(503);
    const result = await worker.fetch(new Request('http://localhost/ready'), {
      ...env,
      PAYMENTS_ENABLED: 'false',
    });
    expect(result.status).toBe(503);
    expect(() => config({ ...env, APP_ENV: 'staging' })).toThrow();
  });
});

describe('settlement', () => {
  it('persists pending candidates and retries after browser disconnect', async () => {
    const current = await create();
    const pending = await call(
      `/v1/checkout/${current.id}/transactions`,
      current.token,
      { signature },
    );
    expect(pending.body.data.status).toBe('verifying');
    transaction = transfer(current.payment);
    await env.DB.prepare('UPDATE attempts SET next_attempt_at = 0').run();
    await retryVerification(env.DB, config(env));
    expect(
      (await call(`/v1/checkout/${current.id}`, current.token)).body.data
        .status,
    ).toBe('settled');
    const txRequest = fetchMock.mock.calls.find(
      ([, options]) =>
        typeof options?.body === 'string' &&
        options.body.includes('getTransaction'),
    );
    expect(txRequest?.[1]?.body).toEqual(expect.stringContaining('finalized'));
  });
  it('settles once and atomically creates one outbox event under concurrent verification', async () => {
    const current = await create();
    transaction = transfer(current.payment);
    const results = await Promise.all(
      [1, 2].map(() =>
        call(`/v1/checkout/${current.id}/transactions`, current.token, {
          signature,
        }),
      ),
    );
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(
      (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await call(`/v1/checkout/${current.id}/transactions`, current.token, {
          signature,
        })
      ).body.data.status,
    ).toBe('settled');
    expect(
      (
        await call(`/v1/checkout/${current.id}/transactions`, current.token, {
          signature: otherSignature,
        })
      ).status,
    ).toBe(409);
  });
  it('enforces transaction uniqueness even if application validation were bypassed', async () => {
    const first = await create('first_key');
    const second = await create('second_key');
    await settle(env.DB, first.payment, signature, 'payer');
    await expect(
      settle(env.DB, second.payment, signature, 'payer'),
    ).rejects.toThrow();
    expect((await getPayment(env.DB, second.id)).signature).toBeNull();
    expect(
      (
        await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });
  it('rolls back settlement when outbox persistence fails', async () => {
    const current = await create();
    await env.DB.prepare(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    ).run();
    try {
      await expect(
        settle(env.DB, current.payment, signature, 'payer'),
      ).rejects.toThrow();
      expect((await getPayment(env.DB, current.id)).signature).toBeNull();
      expect(
        (
          await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{
            n: number;
          }>()
        )?.n,
      ).toBe(0);
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_outbox').run();
    }
  });
  it('rejects mismatched attribution without permanently invalidating the payment', async () => {
    const current = await create();
    transaction = transfer(current.payment);
    transaction.transaction.message.instructions[1].parsed = 'wrong-reference';
    const rejected = await call(
      `/v1/checkout/${current.id}/transactions`,
      current.token,
      { signature },
    );
    expect(rejected.body.data.status).toBe('pending');
    expect((rejected.body.data.attempts as { state: string }[])[0].state).toBe(
      'rejected',
    );
    transaction = transfer(current.payment, otherSignature);
    expect(
      (
        await call(`/v1/checkout/${current.id}/transactions`, current.token, {
          signature: otherSignature,
        })
      ).body.data.status,
    ).toBe('settled');
  });
  it('accepts pre-expiry execution finalized later, rejects late/early/wrong/failed transfers', async () => {
    const current = await create();
    const good = transfer(current.payment);
    vi.spyOn(Date, 'now').mockReturnValue(current.payment.expires_at + 60_000);
    expect(validateTransfer(good, signature, current.payment)).toBe('payer');
    const invalid = [
      { ...good, blockTime: Math.ceil(current.payment.expires_at / 1000) + 1 },
      { ...good, blockTime: Math.floor(current.payment.created_at / 1000) - 1 },
      { ...good, meta: { ...good.meta!, err: { failure: true } } },
      {
        ...good,
        meta: {
          ...good.meta!,
          postBalances: [0, Number(current.payment.lamports) + 1],
        },
      },
    ];
    for (const tx of invalid)
      expect(() => validateTransfer(tx, signature, current.payment)).toThrow();
    expect(() =>
      validateTransfer(good, otherSignature, current.payment),
    ).toThrow();
    transaction = good;
    expect(
      (
        await call(`/v1/checkout/${current.id}/transactions`, current.token, {
          signature,
        })
      ).body.data.status,
    ).toBe('settled');
  });
  it('validates decoded signature lengths', () => {
    expect(base58Length(signature)).toBe(64);
    expect(base58Length('not_a_signature')).toBe(-1);
    expect(base58Length(recipient)).toBe(32);
  });
});

describe('webhooks', () => {
  it('signs exact bytes, retries failures and does not redeliver acknowledged events', async () => {
    const current = await create();
    await settle(env.DB, current.payment, signature, 'payer');
    const settings = config(env);
    const secret = 'fixture_webhook_secret_123456789012345';
    await env.DB.prepare(
      'UPDATE merchants SET webhook_url = ?, webhook_secret_encrypted = ?, revision = revision + 1 WHERE id = ?',
    )
      .bind(
        'https://merchant.example.org/webhook',
        await encryptWebhookSecret(
          merchantKeyring(fixtureKeys),
          'local',
          'merchant',
          secret,
        ),
        'merchant',
      )
      .run();
    fetchMock.mockImplementationOnce(
      async (_url: string, options?: RequestInit) => {
        const headers = options?.headers as Record<string, string>;
        const timestamp = Number(
          /^t=(\d+)/.exec(headers['crypto-gateway-signature'])![1],
        );
        expect(headers['crypto-gateway-signature']).toBe(
          await webhookSignature(
            secret,
            timestamp,
            typeof options?.body === 'string' ? options.body : '',
          ),
        );
        expect(options?.redirect).toBe('manual');
        return new Response(null, { status: 503 });
      },
    );
    await deliverWebhooks(env.DB, settings);
    expect(
      (
        await env.DB.prepare('SELECT delivered_at FROM events').first<{
          delivered_at: number | null;
        }>()
      )?.delivered_at,
    ).toBeNull();
    await env.DB.prepare('UPDATE events SET next_attempt_at = 0').run();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await Promise.all([
      deliverWebhooks(env.DB, settings),
      deliverWebhooks(env.DB, settings),
    ]);
    expect(
      (
        await env.DB.prepare('SELECT delivered_at FROM events').first<{
          delivered_at: number | null;
        }>()
      )?.delivered_at,
    ).toBeTypeOf('number');
    const count = fetchMock.mock.calls.length;
    await deliverWebhooks(env.DB, settings);
    expect(fetchMock.mock.calls.length).toBe(count);
  });
  it('rejects unapproved and unsafe webhook configuration', () => {
    for (const url of [
      'http://merchant.example.org/hook',
      'https://127.0.0.1/hook',
      'https://localhost/hook',
      'https://merchant.example.org:8080/hook',
    ]) {
      expect(() => validateWebhookUrl(url, [new URL(url).hostname])).toThrow();
    }
  });
});
