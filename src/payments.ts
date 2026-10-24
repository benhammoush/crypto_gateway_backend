/**
 * Payment creation, idempotency, durable verification and atomic settlement.
 * @packageDocumentation
 */

import { formatSol, getQuote, lamportsForUsd } from "./price";
import { hmac, sha256 } from "./security";
import {
  assertDevnet,
  ParsedTransaction,
  rpc,
  validateTransfer,
} from "./solana";
import { Config, Merchant, Payment, PublicError } from "./types";

const EXPIRY_MS = 15 * 60_000;
const REVIEW_WINDOW_MS = 24 * 60 * 60_000;

/** Load a persisted payment or raise the public not-found error. */
export async function getPayment(db: D1Database, id: string): Promise<Payment> {
  const payment = await db
    .prepare("SELECT * FROM payments WHERE id = ?")
    .bind(id)
    .first<Payment>();
  if (!payment)
    throw new PublicError("NOT_FOUND", "Payment was not found.", 404);
  return payment;
}

/** A deterministic capability allows safe idempotent retries without storing plaintext tokens. */
export function checkoutToken(
  config: Config,
  payment: Payment,
): Promise<string> {
  return hmac(
    config.checkoutSecret,
    `checkout:v1:${payment.merchant_id}:${payment.id}`,
  );
}

/** Build public payment state without exposing merchant secrets or the keyed backend RPC URL. */
export async function paymentView(
  db: D1Database,
  config: Config,
  payment: Payment,
  includeCheckout = false,
) {
  const attempts = await db
    .prepare(
      "SELECT signature, state, reason FROM attempts WHERE payment_id = ? ORDER BY created_at",
    )
    .bind(payment.id)
    .all<{ signature: string; state: string; reason: string | null }>();
  const status = payment.signature
    ? "settled"
    : attempts.results.some((attempt) => attempt.state === "pending")
      ? "verifying"
      : Date.now() > payment.expires_at
        ? "expired"
        : "pending";
  return {
    id: payment.id,
    merchantReference: payment.merchant_reference,
    usdCents: payment.usd_cents,
    lamports: payment.lamports,
    displaySol: formatSol(payment.lamports),
    network: "solana-devnet",
    asset: "SOL",
    recipient: payment.recipient,
    // Backend RPC may contain provider credentials. Never return it to the browser.
    memo: `crypto_gateway:${payment.id}`,
    rpcUrl: "https://api.devnet.solana.com",
    quote: { usdPrice: payment.usd_price, blockId: payment.price_block_id },
    createdAt: payment.created_at,
    expiresAt: payment.expires_at,
    status,
    signature: payment.signature,
    settledAt: payment.settled_at,
    attempts: attempts.results,
    ...(includeCheckout
      ? {
          checkoutUrl: `${config.checkoutOrigin}/checkout/${payment.id}#${await checkoutToken(config, payment)}`,
        }
      : {}),
  };
}

/** Create or recover an idempotent payment; reject reuse of the key with different inputs. */
export async function createPayment(
  db: D1Database,
  config: Config,
  merchant: Merchant,
  input: Record<string, unknown>,
  key: string,
) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
    throw new PublicError(
      "INVALID_IDEMPOTENCY_KEY",
      "Supply an Idempotency-Key of 8 to 128 characters.",
    );
  if (
    Object.keys(input).some(
      (name) => !["usdCents", "merchantReference"].includes(name),
    ) ||
    typeof input.usdCents !== "number" ||
    !Number.isSafeInteger(input.usdCents) ||
    input.usdCents < 1 ||
    input.usdCents > 1_000_000 ||
    typeof input.merchantReference !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.merchantReference)
  ) {
    throw new PublicError(
      "INVALID_REQUEST",
      "Supply usdCents (1–1000000) and an opaque merchantReference (1–128 characters).",
    );
  }
  const hash = await sha256(
    JSON.stringify([input.usdCents, input.merchantReference]),
  );
  let existing = await db
    .prepare(
      "SELECT * FROM payments WHERE merchant_id = ? AND idempotency_key = ?",
    )
    .bind(merchant.id, key)
    .first<Payment>();
  if (!existing) {
    await assertDevnet(config.rpc);
    const quote = await getQuote(config.priceKey);
    const lamports = lamportsForUsd(input.usdCents, quote.usdPrice);
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO payments
      (id, merchant_id, merchant_reference, idempotency_key, request_hash, usd_cents, lamports, usd_price, price_block_id, recipient, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(merchant_id, idempotency_key) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        merchant.id,
        input.merchantReference,
        key,
        hash,
        input.usdCents,
        lamports,
        quote.usdPrice,
        quote.blockId,
        merchant.recipient,
        now,
        now + EXPIRY_MS,
      )
      .run();
    existing = await db
      .prepare(
        "SELECT * FROM payments WHERE merchant_id = ? AND idempotency_key = ?",
      )
      .bind(merchant.id, key)
      .first<Payment>();
  }
  if (!existing) throw new Error("Payment insert failed.");
  if (existing.request_hash !== hash)
    throw new PublicError(
      "IDEMPOTENCY_CONFLICT",
      "This idempotency key has different payment inputs.",
      409,
    );
  return paymentView(db, config, existing, true);
}

/** Settlement and its deterministic outbox event share one atomic D1 batch. */
export async function settle(
  db: D1Database,
  payment: Payment,
  signature: string,
  payer: string,
): Promise<void> {
  try {
    await db.batch([
      db
        .prepare(
          "UPDATE payments SET signature = ?, payer = ?, settled_at = ? WHERE id = ? AND signature IS NULL",
        )
        .bind(signature, payer, Date.now(), payment.id),
      db
        .prepare(
          `INSERT INTO events (id, payment_id, merchant_id, payload, next_attempt_at)
        SELECT 'evt_' || id, id, merchant_id,
          json_object('id', 'evt_' || id, 'type', 'payment.settled', 'createdAt', settled_at,
            'data', json_object('id', id, 'merchantReference', merchant_reference, 'usdCents', usd_cents,
              'lamports', lamports, 'network', 'solana-devnet', 'status', 'settled', 'signature', signature)), ?
        FROM payments WHERE id = ? AND signature = ? ON CONFLICT(payment_id) DO NOTHING`,
        )
        .bind(Date.now(), payment.id, signature),
      db
        .prepare(
          "UPDATE attempts SET state = 'verified', reason = NULL WHERE payment_id = ? AND signature = ? AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND signature = ?)",
        )
        .bind(payment.id, signature, payment.id, signature),
    ]);
  } catch {
    throw new PublicError(
      "SETTLEMENT_CONFLICT",
      "Settlement could not be recorded. Retrieve payment status before retrying.",
      409,
    );
  }
  const current = await getPayment(db, payment.id);
  if (current.signature !== signature)
    throw new PublicError(
      "ALREADY_SETTLED",
      "This payment has already settled with another transaction.",
      409,
    );
}

/** Candidate signatures are durable so verification survives browser disconnects. */
export async function submit(
  db: D1Database,
  config: Config,
  payment: Payment,
  signature: string,
): Promise<void> {
  if (payment.signature) {
    if (payment.signature !== signature)
      throw new PublicError(
        "ALREADY_SETTLED",
        "Payment is already settled.",
        409,
      );
    return;
  }
  if (Date.now() > payment.expires_at + REVIEW_WINDOW_MS)
    throw new PublicError(
      "MANUAL_REVIEW",
      "Automatic verification has ended. Contact the merchant.",
      422,
    );
  await db
    .prepare(
      `INSERT INTO attempts (payment_id, signature, next_attempt_at, created_at)
    SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM attempts WHERE payment_id = ?) < 5
    ON CONFLICT(payment_id, signature) DO NOTHING`,
    )
    .bind(payment.id, signature, Date.now(), Date.now(), payment.id)
    .run();
  const attempt = await db
    .prepare(
      "SELECT state FROM attempts WHERE payment_id = ? AND signature = ?",
    )
    .bind(payment.id, signature)
    .first<{ state: string }>();
  if (!attempt)
    throw new PublicError(
      "ATTEMPT_LIMIT",
      "Too many transaction candidates. Contact the merchant.",
      429,
    );
  if (attempt.state === "pending")
    await verifyCandidate(db, config, payment, signature);
}

/** Verify finalized evidence; absent transactions remain pending rather than being rejected. */
async function verifyCandidate(
  db: D1Database,
  config: Config,
  payment: Payment,
  signature: string,
): Promise<void> {
  if (Date.now() > payment.expires_at + REVIEW_WINDOW_MS) {
    await db
      .prepare(
        "UPDATE attempts SET state = 'rejected', reason = 'MANUAL_REVIEW' WHERE payment_id = ? AND signature = ?",
      )
      .bind(payment.id, signature)
      .run();
    return;
  }
  await db
    .prepare(
      "UPDATE attempts SET next_attempt_at = ? WHERE payment_id = ? AND signature = ?",
    )
    .bind(Date.now() + 30_000, payment.id, signature)
    .run();
  await assertDevnet(config.rpc);
  const tx = await rpc<ParsedTransaction | null>(config.rpc, "getTransaction", [
    signature,
    {
      encoding: "jsonParsed",
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  if (!tx) return;
  try {
    const payer = validateTransfer(tx, signature, payment);
    await settle(db, payment, signature, payer);
  } catch (error) {
    if (!(error instanceof PublicError) || error.status !== 422) throw error;
    await db
      .prepare(
        "UPDATE attempts SET state = 'rejected', reason = ? WHERE payment_id = ? AND signature = ? AND state = 'pending'",
      )
      .bind(error.code, payment.id, signature)
      .run();
  }
}

/** Retry due durable candidates; transient failures leave them eligible for later verification. */
export async function retryVerification(
  db: D1Database,
  config: Config,
): Promise<void> {
  const due = await db
    .prepare(
      `SELECT a.payment_id, a.signature FROM attempts a JOIN payments p ON p.id = a.payment_id
    WHERE a.state = 'pending' AND a.next_attempt_at <= ? AND p.signature IS NULL ORDER BY a.next_attempt_at LIMIT 10`,
    )
    .bind(Date.now())
    .all<{ payment_id: string; signature: string }>();
  for (const candidate of due.results) {
    try {
      await verifyCandidate(
        db,
        config,
        await getPayment(db, candidate.payment_id),
        candidate.signature,
      );
    } catch {
      /* Retry remains durable; no provider payloads or credentials are logged. */
    }
  }
}
