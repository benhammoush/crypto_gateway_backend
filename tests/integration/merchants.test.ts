/** D1 merchant provisioning, isolation, encryption and audit regressions with synthetic data.
 * @packageDocumentation
 */
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { migrate, fixtureKeys } from '../fixtures';
import { provisionMerchant } from '../../scripts/merchant';
import type { MerchantOperation, Query } from '../../scripts/merchant';
import { authenticateMerchant } from '../../src/merchants';
import type { MerchantRecord } from '../../src/merchants';
import {
  merchantKeyring,
  encryptWebhookSecret,
  decryptWebhookSecret,
} from '../../src/merchant-crypto';
import { deliverWebhooks } from '../../src/webhooks';
import { config } from '../../src/config';
import worker from '../../src/index';

let mf: Miniflare;
let db: D1Database;
const recipient = 'So11111111111111111111111111111111111111112';
const signingSecret = 'fixture_signing_secret_123456789012345';
const secrets = { keys: fixtureKeys, hosts: 'merchant.example.org' };

/** Execute parameterized operator SQL against an isolated real D1 database.
 * @param sql - Provisioning statement.
 * @param params - Bound operation values.
 * @returns D1 rows and actual change metrics.
 */
const query: Query = async (sql, params) => {
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<MerchantRecord>();
  return { results: result.results, changes: result.meta.changes };
};

/** Build explicit synthetic operation confirmation for a known revision.
 * @param operation - Operation under test.
 * @param revision - Expected current revision.
 * @param id - Synthetic merchant identity.
 * @returns Operator request with no secret arguments.
 */
function options(
  operation: MerchantOperation['operation'] = 'add',
  revision = 0,
  id = 'fixture',
): MerchantOperation {
  return {
    environment: 'local',
    operation,
    id,
    revision,
    operator: 'fixture-operator',
    confirm: `local:${id}:${operation}:${revision}`,
  };
}

/** Provision a merchant without contacts or webhooks.
 * @param id - Synthetic identity.
 * @returns One-time API credential and revision summary.
 */
function add(id = 'fixture') {
  return provisionMerchant(
    query,
    options('add', 0, id),
    { name: 'Fixture', recipient },
    secrets,
  );
}

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("fixture") } }',
      compatibilityDate: '2026-10-04',
      d1Databases: { DB: 'merchant-tests' },
    }),
  );
  db = await mf.getD1Database('DB');
  await migrate(db);
}, 30_000);
beforeEach(async () => {
  await db.batch(
    [
      'events',
      'attempts',
      'payments',
      'rate_limits',
      'merchant_audit',
      'merchants',
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
});
afterAll(async () => {
  await mf?.dispose();
});

it('adds individual merchants with optional contacts, unique credentials and private audit metadata', async () => {
  const first = await add();
  await add('other');
  expect(first.apiKey).toMatch(/^[a-f0-9]{64}$/);
  expect(await authenticateMerchant(db, first.apiKey!)).toEqual({
    id: 'fixture',
    recipient,
  });
  expect(await authenticateMerchant(db, 'unknown')).toBeNull();
  const rows = await db
    .prepare('SELECT * FROM merchants')
    .all<MerchantRecord>();
  expect(rows.results).toHaveLength(2);
  expect(rows.results[0].email).toBeNull();
  expect(JSON.stringify(rows.results)).not.toContain(first.apiKey);
  const audit = await db.prepare('SELECT * FROM merchant_audit').all();
  expect(audit.results).toHaveLength(2);
  expect(JSON.stringify(audit.results)).not.toContain('Fixture');
  await expect(add()).rejects.toThrow();
});

it('updates one profile with optimistic revisions and does not change another merchant', async () => {
  await add();
  await add('other');
  await provisionMerchant(
    query,
    options('update', 1),
    {
      name: 'Renamed',
      email: 'support@example.org',
      phone: '+33123456789',
      country_code: 'FR',
      legal_name: 'Fixture Ltd',
    },
    secrets,
  );
  await expect(
    provisionMerchant(query, options('update', 1), { name: 'Stale' }, secrets),
  ).rejects.toThrow();
  const rows = await db
    .prepare('SELECT * FROM merchants ORDER BY id')
    .all<MerchantRecord>();
  expect(rows.results[0]).toMatchObject({
    name: 'Renamed',
    revision: 2,
    country_code: 'FR',
  });
  expect(rows.results[1].name).toBe('Fixture');
  const audit = await db
    .prepare('SELECT changed_fields FROM merchant_audit WHERE revision = 2')
    .first<{ changed_fields: string }>();
  expect(JSON.parse(audit!.changed_fields)).toMatchObject({
    name: 1,
    email: 1,
  });
  expect(audit!.changed_fields).not.toContain('support@example.org');
});

it('rejects concurrent writes at the database boundary without duplicate audit entries', async () => {
  await add();
  const results = await Promise.allSettled([
    provisionMerchant(query, options('update', 1), { name: 'First' }, secrets),
    provisionMerchant(query, options('update', 1), { name: 'Second' }, secrets),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(
    (await db
      .prepare('SELECT COUNT(*) AS count FROM merchant_audit')
      .first<{ count: number }>())!.count,
  ).toBe(2);
});

it('rotates keys, disables access, and enables it again without deleting merchants', async () => {
  const first = await add();
  const rotated = await provisionMerchant(
    query,
    options('rotate-key', 1),
    {},
    secrets,
  );
  expect(await authenticateMerchant(db, first.apiKey!)).toBeNull();
  expect(await authenticateMerchant(db, rotated.apiKey!)).toMatchObject({
    id: 'fixture',
  });
  await provisionMerchant(query, options('disable', 2), {}, secrets);
  expect(await authenticateMerchant(db, rotated.apiKey!)).toBeNull();
  await provisionMerchant(query, options('enable', 3), {}, secrets);
  expect(await authenticateMerchant(db, rotated.apiKey!)).toMatchObject({
    id: 'fixture',
  });
});

it.each([
  { email: 'invalid' },
  { phone: '1234' },
  { country_code: 'fr' },
  { name: '' },
  { recipient: '11111111111111111111111111111111' },
  { status: 'active' },
  { name: 'bad\nname' },
  { webhook_url: 'https://merchant.example.org/hook' },
  { webhook_url: 'https://127.0.0.1/hook', webhook_secret: signingSecret },
])('rejects invalid profile fields before writes: %j', async (patch) => {
  await expect(
    provisionMerchant(
      query,
      options(),
      { name: 'Fixture', recipient, ...patch },
      secrets,
    ),
  ).rejects.toThrow();
  expect(
    (await db
      .prepare('SELECT COUNT(*) AS count FROM merchants')
      .first<{ count: number }>())!.count,
  ).toBe(0);
});

it('requires exact confirmation before any database access', async () => {
  const forbidden = vi.fn<Query>();
  await expect(
    provisionMerchant(
      forbidden,
      { ...options(), confirm: 'wrong' },
      {},
      secrets,
    ),
  ).rejects.toThrow();
  expect(forbidden).not.toHaveBeenCalled();
});

it('stores only authenticated ciphertext and re-encrypts incrementally under a new key', async () => {
  await provisionMerchant(
    query,
    options(),
    {
      name: 'Fixture',
      recipient,
      webhook_url: 'https://merchant.example.org/hook',
      webhook_secret: signingSecret,
    },
    secrets,
  );
  const row = await db
    .prepare('SELECT * FROM merchants')
    .first<MerchantRecord>();
  expect(JSON.stringify(row)).not.toContain(signingSecret);
  expect(
    await decryptWebhookSecret(
      merchantKeyring(fixtureKeys),
      'local',
      'fixture',
      row!.webhook_secret_encrypted!,
    ),
  ).toBe(signingSecret);
  const keys = JSON.stringify({
    active: 'next',
    keys: { fixture: 'ab'.repeat(32), next: 'cd'.repeat(32) },
  });
  await provisionMerchant(
    query,
    options('reencrypt', 1),
    {},
    { ...secrets, keys },
  );
  const updated = await db
    .prepare('SELECT * FROM merchants')
    .first<MerchantRecord>();
  expect(updated!.webhook_secret_encrypted).toMatch(/^v1:next:/);
  expect(
    await decryptWebhookSecret(
      merchantKeyring(
        JSON.stringify({ active: 'next', keys: { next: 'cd'.repeat(32) } }),
      ),
      'local',
      'fixture',
      updated!.webhook_secret_encrypted!,
    ),
  ).toBe(signingSecret);
});

it('uses fresh nonces and rejects tampering, swapped identity/environment and missing keys', async () => {
  const ring = merchantKeyring(fixtureKeys);
  const a = await encryptWebhookSecret(ring, 'dev', 'fixture', signingSecret);
  expect(
    await encryptWebhookSecret(ring, 'dev', 'fixture', signingSecret),
  ).not.toBe(a);
  for (const [environment, id, ciphertext] of [
    ['production', 'fixture', a],
    ['dev', 'other', a],
    ['dev', 'fixture', a.slice(0, -1) + (a.endsWith('0') ? '1' : '0')],
    ['dev', 'fixture', a.replace('v1:', 'v2:')],
  ]) {
    await expect(
      decryptWebhookSecret(ring, environment, id, ciphertext),
    ).rejects.toThrow('Webhook secret could not be decrypted.');
  }
  await expect(
    decryptWebhookSecret(
      merchantKeyring(
        JSON.stringify({ active: 'next', keys: { next: 'cd'.repeat(32) } }),
      ),
      'dev',
      'fixture',
      a,
    ),
  ).rejects.toThrow();
});

it('rolls back profile writes when the atomic audit trigger rejects a duplicate revision', async () => {
  await add();
  await expect(
    db
      .prepare("UPDATE merchants SET name = 'Unaudited' WHERE id = 'fixture'")
      .run(),
  ).rejects.toThrow();
  expect(
    (await db
      .prepare("SELECT name FROM merchants WHERE id = 'fixture'")
      .first<{ name: string }>())!.name,
  ).toBe('Fixture');
});

it('rejects duplicate API-key hashes without creating another merchant or audit row', async () => {
  await add();
  await expect(
    db
      .prepare(
        "INSERT INTO merchants (id, name, api_key_hash, recipient, created_at, updated_at, updated_by) SELECT 'duplicate', name, api_key_hash, recipient, created_at, updated_at, updated_by FROM merchants WHERE id = 'fixture'",
      )
      .run(),
  ).rejects.toThrow();
  expect(
    (await db
      .prepare('SELECT COUNT(*) AS count FROM merchant_audit')
      .first<{ count: number }>())!.count,
  ).toBe(1);
});

it('preserves existing payment ownership and recipient when a merchant changes profile or rotates credentials', async () => {
  await add();
  const id = '11111111-1111-4111-8111-111111111111';
  await db
    .prepare(
      "INSERT INTO payments (id, merchant_id, merchant_reference, idempotency_key, request_hash, usd_cents, lamports, usd_price, price_block_id, recipient, created_at, expires_at) VALUES (?, 'fixture', 'ref', 'key', 'hash', 1, '100', '100', 1, ?, 0, 1)",
    )
    .bind(id, recipient)
    .run();
  await provisionMerchant(
    query,
    options('update', 1),
    {
      name: 'Renamed',
      recipient: '3D2TThLPj8Uduw6BXkAqTbrDR1C8cCVd8spPCmjnCasJ',
    },
    secrets,
  );
  const rotated = await provisionMerchant(
    query,
    options('rotate-key', 2),
    {},
    secrets,
  );
  const response = await worker.fetch(
    new Request(`http://localhost/v1/payments/${id}`, {
      headers: { authorization: `Bearer ${rotated.apiKey}` },
    }),
    {
      DB: db,
      APP_ENV: 'local',
      PAYMENTS_ENABLED: 'true',
      CHECKOUT_ORIGIN: 'http://localhost:5173',
      CHECKOUT_SECRET: 'x'.repeat(32),
      SOLANA_RPC_URL: 'https://rpc.example.org',
      JUPITER_API_KEY: 'fixture',
    },
  );
  expect(response.status).toBe(200);
  const body = await response.json<{ data: Record<string, unknown> }>();
  expect(body.data.recipient).toBe(recipient);
  expect(body.data).not.toHaveProperty('name');
  expect(body.data).not.toHaveProperty('email');
  expect(
    await db
      .prepare('SELECT merchant_id, recipient FROM payments WHERE id = ?')
      .bind(id)
      .first(),
  ).toEqual({ merchant_id: 'fixture', recipient });
});

it('does not expose profiles in errors, and no public provisioning route exists', async () => {
  const first = await add();
  const response = await worker.fetch(
    new Request('http://localhost/v1/merchants', {
      method: 'POST',
      headers: { authorization: `Bearer ${first.apiKey}` },
    }),
    {
      DB: db,
      APP_ENV: 'local',
      PAYMENTS_ENABLED: 'true',
      CHECKOUT_ORIGIN: 'http://localhost:5173',
      CHECKOUT_SECRET: 'x'.repeat(32),
      SOLANA_RPC_URL: 'https://rpc.example.org',
      JUPITER_API_KEY: 'fixture',
    },
  );
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain('Fixture');
});

it('does not deliver or consume attempts with a disabled merchant or missing encryption key', async () => {
  const first = await provisionMerchant(
    query,
    options(),
    {
      name: 'Fixture',
      recipient,
      webhook_url: 'https://merchant.example.org/hook',
      webhook_secret: signingSecret,
    },
    secrets,
  );
  await db
    .prepare(
      "INSERT INTO payments (id, merchant_id, merchant_reference, idempotency_key, request_hash, usd_cents, lamports, usd_price, price_block_id, recipient, created_at, expires_at) VALUES ('payment', 'fixture', 'ref', 'key', 'hash', 1, '100', '100', 1, ?, 0, 1)",
    )
    .bind(recipient)
    .run();
  await db
    .prepare(
      "INSERT INTO events (id, payment_id, merchant_id, payload, next_attempt_at) VALUES ('event', 'payment', 'fixture', '{}', 0)",
    )
    .run();
  const settings = config({
    DB: db,
    APP_ENV: 'local',
    CHECKOUT_ORIGIN: 'http://localhost:5173',
    SOLANA_RPC_URL: 'https://rpc.example.org',
    WEBHOOK_HOSTS: 'merchant.example.org',
  });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    await deliverWebhooks(db, settings);
    await provisionMerchant(
      query,
      options('disable', first.revision),
      {},
      secrets,
    );
    await deliverWebhooks(db, {
      ...settings,
      merchantKeys: merchantKeyring(fixtureKeys),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (await db
        .prepare('SELECT attempts FROM events')
        .first<{ attempts: number }>())!.attempts,
    ).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('defers a full blocked batch so valid events for another merchant can progress', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const runId = crypto.randomUUID();
  for (const id of ['blocked', 'valid']) {
    await provisionMerchant(
      query,
      options('add', 0, id),
      {
        name: 'Fixture',
        recipient,
        webhook_url: 'https://merchant.example.org/hook',
        webhook_secret: signingSecret,
      },
      secrets,
    );
  }
  await db
    .prepare(
      "UPDATE merchants SET webhook_secret_encrypted = ?, revision = revision + 1 WHERE id = 'blocked'",
    )
    .bind(
      await encryptWebhookSecret(
        merchantKeyring(fixtureKeys),
        'dev',
        'blocked',
        signingSecret,
      ),
    )
    .run();
  for (let index = 0; index < 11; index++) {
    const id = `payment-${index}`;
    const merchant = index < 10 ? 'blocked' : 'valid';
    await db
      .prepare(
        'INSERT INTO payments (id, merchant_id, merchant_reference, idempotency_key, request_hash, usd_cents, lamports, usd_price, price_block_id, recipient, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, ?, 0, 1)',
      )
      .bind(id, merchant, id, id, id, '100', '100', recipient)
      .run();
    await db
      .prepare(
        'INSERT INTO events (id, payment_id, merchant_id, payload, next_attempt_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(id, id, merchant, '{}', index)
      .run();
  }
  const settings = config({
    DB: db,
    APP_ENV: 'local',
    CHECKOUT_ORIGIN: 'http://localhost:5173',
    SOLANA_RPC_URL: 'https://rpc.example.org',
    WEBHOOK_HOSTS: 'merchant.example.org',
    MERCHANT_ENCRYPTION_KEYS: fixtureKeys,
  });
  const fetch = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    await deliverWebhooks(db, settings, runId);
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(10);
    expect(
      log.mock.calls.every(
        ([entry]) =>
          JSON.stringify(entry) ===
          JSON.stringify({
            event: 'scheduled.failure',
            runId,
            operation: 'webhook_delivery',
            code: 'WEBHOOK_CONFIGURATION_BLOCKED',
          }),
      ),
    ).toBe(true);
    const blocked = await db
      .prepare(
        "SELECT attempts, next_attempt_at, last_error FROM events WHERE merchant_id = 'blocked'",
      )
      .all<{ attempts: number; next_attempt_at: number; last_error: string }>();
    expect(blocked.results).toHaveLength(10);
    for (const event of blocked.results) {
      expect(event.attempts).toBe(0);
      expect(event.next_attempt_at).toBeGreaterThan(Date.now());
      expect(event.last_error).toBe('WEBHOOK_CONFIGURATION_BLOCKED');
    }
    await deliverWebhooks(db, settings);
    expect(fetch).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledTimes(10);
    expect(
      (await db
        .prepare("SELECT delivered_at FROM events WHERE merchant_id = 'valid'")
        .first<{ delivered_at: number | null }>())!.delivered_at,
    ).toBeTypeOf('number');
  } finally {
    log.mockRestore();
    vi.unstubAllGlobals();
  }
});
