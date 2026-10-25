/**
 * Signed webhook delivery from the durable settlement outbox.
 * @packageDocumentation
 */

import { hmac } from "./security";
import { Config } from "./types";

/** Durable settlement-outbox record with delivery retry state. */
interface EventRow {
  id: string;
  merchant_id: string;
  payload: string;
  attempts: number;
}

/** The exact raw body is signed. Consumers enforce timestamp tolerance and event deduplication.
 * @param secret - Merchant-specific server-only webhook signing secret.
 * @param timestamp - Unix timestamp in seconds included in the signature header.
 * @param body - Exact serialized event bytes represented as text.
 * @returns The timestamped HMAC header value for this delivery attempt.
 */
export async function webhookSignature(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  return `t=${timestamp},v1=${await hmac(secret, `${timestamp}.${body}`)}`;
}

/** Bounded, leased, at-least-once delivery. Runtime must enforce public-only fetch.
 * @param db - Database containing durable outbox events and delivery leases.
 * @param config - Validated merchant destinations and signing secrets.
 */
export async function deliverWebhooks(
  db: D1Database,
  config: Config,
): Promise<void> {
  const enabled = config.merchants
    .filter((merchant) => merchant.webhookUrl && merchant.webhookSecret)
    .map((merchant) => merchant.id);
  if (!enabled.length) return;
  const now = Date.now();
  const rows = await db
    .prepare(
      `SELECT id, merchant_id, payload, attempts FROM events
    WHERE delivered_at IS NULL AND next_attempt_at <= ? AND lease_until < ? AND attempts < 12
      AND merchant_id IN (${enabled.map(() => "?").join(",")})
    ORDER BY next_attempt_at LIMIT 10`,
    )
    .bind(now, now, ...enabled)
    .all<EventRow>();
  for (const event of rows.results) {
    const merchant = config.merchants.find(
      (entry) => entry.id === event.merchant_id,
    );
    if (!merchant?.webhookUrl || !merchant.webhookSecret) continue;
    const lease = crypto.randomUUID();
    const claimed = await db
      .prepare(
        `UPDATE events SET lease_until = ?, lease_token = ?, attempts = attempts + 1
      WHERE id = ? AND delivered_at IS NULL AND lease_until < ? AND next_attempt_at <= ? AND attempts < 12`,
      )
      .bind(Date.now() + 30_000, lease, event.id, Date.now(), now)
      .run();
    if (!claimed.meta.changes) continue;
    let delivered = false;
    try {
      const response = await fetch(merchant.webhookUrl, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: {
          "content-type": "application/json",
          "crypto-gateway-event-id": event.id,
          "crypto-gateway-signature": await webhookSignature(
            merchant.webhookSecret,
            Math.floor(Date.now() / 1000),
            event.payload,
          ),
        },
        body: event.payload,
      });
      delivered = response.ok;
      await response.body?.cancel();
    } catch {
      /* Failures remain pending; never log endpoint secrets or response bodies. */
    }
    const delay = Math.min(3_600_000, 30_000 * 2 ** event.attempts);
    await db
      .prepare(
        `UPDATE events SET delivered_at = ?, next_attempt_at = ?, lease_until = 0,
      lease_token = NULL, last_error = ? WHERE id = ? AND lease_token = ?`,
      )
      .bind(
        delivered ? Date.now() : null,
        Date.now() + delay,
        delivered ? null : "DELIVERY_FAILED",
        event.id,
        lease,
      )
      .run();
  }
}
