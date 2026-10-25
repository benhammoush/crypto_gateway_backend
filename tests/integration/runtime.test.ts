/**
 * Worker/D1 runtime verification with intercepted provider and webhook requests.
 * @packageDocumentation
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { sha256 } from '../../src/security';
import { MEMO_PROGRAM, ParsedTransaction } from '../../src/solana';
import { SOL_MINT } from '../../src/price';

let mf: Miniflare;
let tx: ParsedTransaction | null = null;
const outgoing: string[] = [];
let webhookDeliveries = 0;
const credential = 'runtime_fixture_credential_1234567890';
const recipient = 'So11111111111111111111111111111111111111112';

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: 'dist/index.js',
      compatibilityDate: '2026-10-04',
      compatibilityFlags: ['global_fetch_strictly_public'],
      d1Databases: { DB: 'runtime-fixture' },
      bindings: {
        APP_ENV: 'local',
        PAYMENTS_ENABLED: 'true',
        CHECKOUT_ORIGIN: 'http://localhost:5173',
        CHECKOUT_SECRET: 'runtime_fixture_checkout_secret_1234567890',
        JUPITER_API_KEY: 'fixture',
        SOLANA_RPC_URL: 'https://rpc.example.org',
        WEBHOOK_HOSTS: 'merchant.example.org',
        MERCHANTS_JSON: JSON.stringify([
          {
            id: 'fixture',
            apiKeyHash: await sha256(credential),
            recipient,
            webhookUrl: 'https://merchant.example.org/webhook',
            webhookSecret: 'runtime_fixture_webhook_secret_1234567890',
          },
        ]),
      },
      /** Supply controlled upstream responses and record webhook deliveries.
       * @param request - Outbound request intercepted from the local Worker runtime.
       * @returns A controlled pricing, RPC or webhook response without network access.
       */
      outboundService: async (request) => {
        outgoing.push(request.url);
        if (request.url === 'https://merchant.example.org/webhook') {
          webhookDeliveries++;
          expect(request.headers.get('crypto-gateway-signature')).toMatch(
            /^t=\d+,v1=[a-f0-9]{64}$/,
          );
          return new Response(null, { status: 204 });
        }
        if (request.url.startsWith('https://api.jup.ag/'))
          return Response.json({
            [SOL_MINT]: { usdPrice: '100', blockId: 123, decimals: 9 },
          });
        const body = (await request.json()) as { method: string };
        if (body.method === 'getGenesisHash')
          return Response.json({
            jsonrpc: '2.0',
            id: 1,
            result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
          });
        if (body.method === 'getLatestBlockhash')
          return Response.json({
            jsonrpc: '2.0',
            id: 1,
            result: {
              context: { slot: 123 },
              value: { blockhash: '1'.repeat(32), lastValidBlockHeight: 100 },
            },
          });
        if (body.method === 'getTransaction')
          return Response.json({ result: tx });
        throw new Error('Unexpected runtime network request.');
      },
    }),
  );
  const db = await mf.getD1Database('DB');
  for (const sql of readFileSync('migrations/0001_payments.sql', 'utf8')
    .split(';')
    .filter((sql) => sql.trim()))
    await db.prepare(sql).run();
}, 30_000);
afterAll(async () => {
  await mf?.dispose();
});

it('retries null-to-finalized transactions through the actual bundled scheduled handler', async () => {
  const created = await mf.dispatchFetch('http://localhost/v1/payments', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
      'idempotency-key': 'runtime_fixture_key',
    },
    body: JSON.stringify({ usdCents: 1000, merchantReference: 'runtime' }),
  });
  expect(
    created.status,
    `${await created.clone().text()} outgoing=${JSON.stringify(outgoing)}`,
  ).toBe(200);
  const { data } = (await created.json()) as {
    data: {
      id: string;
      lamports: string;
      checkoutUrl: string;
      createdAt: number;
    };
  };
  const token = new URL(data.checkoutUrl).hash.slice(1);
  for (const [method, params] of [
    ['getGenesisHash', []],
    ['getLatestBlockhash', [{ commitment: 'finalized' }]],
  ]) {
    const result = await mf.dispatchFetch(
      `http://localhost/v1/checkout/${data.id}/rpc`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method, params }),
      },
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ jsonrpc: '2.0', id: 9 });
  }
  const signature = '1'.repeat(64);
  const submitted = await mf.dispatchFetch(
    `http://localhost/v1/checkout/${data.id}/transactions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ signature }),
    },
  );
  expect(submitted.status).toBe(200);
  expect(
    ((await submitted.json()) as { data: { status: string } }).data.status,
  ).toBe('verifying');
  tx = {
    blockTime: Math.floor(data.createdAt / 1000),
    meta: {
      err: null,
      preBalances: [1_000_000_000, 0],
      postBalances: [1, Number(data.lamports)],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: 'fixture-payer', signer: true },
          { pubkey: recipient, signer: false },
        ],
        instructions: [
          {
            programId: 'ComputeBudget111111111111111111111111111111',
            accounts: [],
            data: '3qi1MbrtkR83',
          },
          {
            programId: 'ComputeBudget111111111111111111111111111111',
            accounts: [],
            data: 'Fj2Eoy',
          },
          {
            programId: '11111111111111111111111111111111',
            parsed: {
              type: 'transfer',
              info: {
                source: 'fixture-payer',
                destination: recipient,
                lamports: Number(data.lamports),
              },
            },
          },
          { programId: MEMO_PROGRAM, parsed: `crypto_gateway:${data.id}` },
        ],
      },
    },
  };
  const db = await mf.getD1Database('DB');
  await db.prepare('UPDATE attempts SET next_attempt_at = 0').run();
  await (await mf.getWorker()).scheduled({ cron: '* * * * *' });
  const status = await mf.dispatchFetch(
    `http://localhost/v1/checkout/${data.id}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(
    ((await status.json()) as { data: { status: string } }).data.status,
  ).toBe('settled');
  expect(
    (
      await db
        .prepare('SELECT COUNT(*) AS n FROM events')
        .first<{ n: number }>()
    )?.n,
  ).toBe(1);
  expect(webhookDeliveries).toBe(1);
  expect(
    (
      await db
        .prepare('SELECT delivered_at FROM events')
        .first<{ delivered_at: number | null }>()
    )?.delivered_at,
  ).toBeTypeOf('number');
});
