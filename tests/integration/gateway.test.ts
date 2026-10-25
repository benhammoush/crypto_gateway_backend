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
import { readFileSync } from 'node:fs';
import worker from '../../src/index';
import { config } from '../../src/config';
import { getPayment, retryVerification, settle } from '../../src/payments';
import { SOL_MINT } from '../../src/price';
import { base58Length, sha256 } from '../../src/security';
import {
  DEVNET_GENESIS,
  MEMO_PROGRAM,
  ParsedTransaction,
  validateTransfer,
} from '../../src/solana';
import { Env, Merchant, Payment } from '../../src/types';
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
  for (const sql of readFileSync('migrations/0001_payments.sql', 'utf8')
    .split(';')
    .filter((sql) => sql.trim())) {
    await db.prepare(sql).run();
  }
  env = {
    DB: db,
    APP_ENV: 'local',
    PAYMENTS_ENABLED: 'true',
    CHECKOUT_ORIGIN: 'http://localhost:5173',
    CHECKOUT_SECRET: 'fixture_checkout_secret_12345678901234567890',
    SOLANA_RPC_URL: 'https://rpc.example.org',
    JUPITER_API_KEY: 'fixture-price-key',
    MERCHANTS_JSON: JSON.stringify([
      { id: 'merchant', apiKeyHash: await sha256(credential), recipient },
    ]),
  };
}, 30_000);

beforeEach(async () => {
  await env.DB.batch(
    ['events', 'attempts', 'payments', 'rate_limits'].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
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
    const merchants = JSON.parse(env.MERCHANTS_JSON!) as Merchant[];
    const alternateEnv = {
      ...env,
      MERCHANTS_JSON: JSON.stringify([
        ...merchants,
        { id: 'other', apiKeyHash: await sha256(other), recipient },
      ]),
    };
    const result = await worker.fetch(
      new Request(`http://localhost/v1/payments/${current.id}`, {
        headers: { authorization: `Bearer ${other}` },
      }),
      alternateEnv,
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
    settings.merchants[0].webhookUrl = 'https://merchant.example.org/webhook';
    settings.merchants[0].webhookSecret =
      'fixture_webhook_secret_123456789012345';
    fetchMock.mockImplementationOnce(
      async (_url: string, options?: RequestInit) => {
        const headers = options?.headers as Record<string, string>;
        const timestamp = Number(
          /^t=(\d+)/.exec(headers['crypto-gateway-signature'])![1],
        );
        expect(headers['crypto-gateway-signature']).toBe(
          await webhookSignature(
            settings.merchants[0].webhookSecret!,
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
    const merchants = JSON.parse(env.MERCHANTS_JSON!) as Merchant[];
    for (const url of [
      'http://merchant.example.org/hook',
      'https://127.0.0.1/hook',
      'https://localhost/hook',
      'https://merchant.example.org:8080/hook',
    ]) {
      expect(() =>
        config({
          ...env,
          WEBHOOK_HOSTS: new URL(url).hostname,
          MERCHANTS_JSON: JSON.stringify([
            { ...merchants[0], webhookUrl: url, webhookSecret: 'x'.repeat(32) },
          ]),
        }),
      ).toThrow();
    }
  });
});
