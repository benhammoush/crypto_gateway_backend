/**
 * Supported compute-budget instruction validation regressions.
 * @packageDocumentation
 */

import { expect, it } from 'vitest';
import {
  MEMO_PROGRAM,
  ParsedTransaction,
  validateTransfer,
} from '../../src/solana';
import type { Payment } from '../../src/types';

const compute = 'ComputeBudget111111111111111111111111111111';
const limit = { programId: compute, accounts: [], data: 'Fj2Eoy' };
const price = { programId: compute, accounts: [], data: '3qi1MbrtkR83' };
const signature = '1'.repeat(64);
const payment: Payment = {
  id: 'fixture',
  merchant_id: 'merchant',
  merchant_reference: 'ref',
  idempotency_key: 'key',
  request_hash: 'hash',
  usd_cents: 100,
  lamports: '9460077',
  usd_price: '100',
  price_block_id: 1,
  recipient: 'recipient',
  created_at: 1000,
  expires_at: 10000,
  signature: null,
  payer: null,
  settled_at: null,
};
/** Build finalized payment evidence before inserting the instruction under test.
 * @returns Controlled finalized transfer and memo evidence.
 */
function transaction(): ParsedTransaction {
  return {
    blockTime: 2,
    meta: { err: null, preBalances: [10000000, 0], postBalances: [1, 9460077] },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: 'payer', signer: true },
          { pubkey: 'recipient', signer: false },
        ],
        instructions: [
          {
            programId: '11111111111111111111111111111111',
            parsed: {
              type: 'transfer',
              info: {
                source: 'payer',
                destination: 'recipient',
                lamports: 9460077,
              },
            },
          },
          { programId: MEMO_PROGRAM, parsed: 'crypto_gateway:fixture' },
        ],
      },
    },
  };
}

// Independent fixture encoding covers unsigned wire boundaries without Number rounding.
/** Encode controlled instruction bytes as base58 for parsed-transaction fixtures.
 * @param bytes - Controlled instruction bytes, including intentionally invalid fixtures.
 * @returns Their base58 representation for validation tests.
 */
function encode(bytes: number[]): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = bytes.reduce((result, byte) => result * 256n + BigInt(byte), 0n);
  let encoded = '';
  while (value) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return encoded;
}

it.each(
  [[], [limit], [price], [limit, price], [price, limit]].map((prefix) => [
    prefix,
  ]),
)('accepts the bounded wallet prefix %j', (prefix) => {
  const tx = transaction();
  tx.transaction.message.instructions.unshift(...prefix);
  expect(validateTransfer(tx, signature, payment)).toBe('payer');
});

it.each([
  [2, 0, 0, 0, 0],
  [2, 255, 255, 255, 255],
  [3, 0, 0, 0, 0, 0, 0, 0, 0],
  [3, 255, 255, 255, 255, 255, 255, 255, 255],
])('accepts full protocol unsigned range %j', (...bytes) => {
  const tx = transaction();
  tx.transaction.message.instructions.unshift({
    programId: compute,
    accounts: [],
    data: encode(bytes),
  });
  expect(validateTransfer(tx, signature, payment)).toBe('payer');
});

it.each(
  [
    [limit, limit],
    [price, price],
    [limit, price, limit],
    [{ ...limit, programId: 'unknown' }],
    [{ ...limit, accounts: ['payer'] }],
    [{ ...limit, accounts: undefined }],
    [{ ...limit, parsed: 'not-raw' }],
    [{ ...limit, data: 'invalid_' }],
    [{ ...limit, data: '1'.repeat(14) }],
    ...[
      [1, 0, 0, 1, 0],
      [4, 1, 0, 0, 0],
      [2, 0, 0, 0],
      [3, 0, 0, 0, 0],
      [2, 0, 0, 0, 0, 0],
      [3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ].map((bytes) => [{ ...limit, data: encode(bytes) }]),
  ].map((prefix) => [prefix]),
)(
  'rejects duplicates, other programs/variants and malformed prefixes %j',
  (prefix) => {
    const tx = transaction();
    tx.transaction.message.instructions.unshift(...prefix);
    expect(() => validateTransfer(tx, signature, payment)).toThrow(
      'does not match',
    );
  },
);

it('rejects budget instructions interleaved with or after payment instructions', () => {
  for (const index of [1, 2]) {
    const tx = transaction();
    tx.transaction.message.instructions.splice(index, 0, limit);
    expect(() => validateTransfer(tx, signature, payment)).toThrow(
      'does not match',
    );
  }
});

it('retains all attribution, amount, time and execution checks with budget settings', () => {
  const valid = transaction();
  valid.transaction.message.instructions.unshift(price, limit);
  const invalid = [
    { ...valid, blockTime: 0 },
    { ...valid, blockTime: 11 },
    { ...valid, meta: { ...valid.meta!, err: { failure: true } } },
    { ...valid, meta: { ...valid.meta!, postBalances: [1, 9460078] } },
  ];
  for (const tx of invalid)
    expect(() => validateTransfer(tx, signature, payment)).toThrow(
      'does not match',
    );
  for (const changed of [
    { recipient: 'other' },
    { lamports: '9460078' },
    { id: 'other' },
  ])
    expect(() =>
      validateTransfer(valid, signature, { ...payment, ...changed }),
    ).toThrow('does not match');
  expect(() => validateTransfer(valid, 'other', payment)).toThrow(
    'does not match',
  );
  const extra = transaction();
  extra.transaction.message.instructions.unshift(
    price,
    limit,
    extra.transaction.message.instructions[0],
  );
  expect(() => validateTransfer(extra, signature, payment)).toThrow(
    'does not match',
  );
});
