/**
 * Signed webhook delivery from the durable settlement outbox.
 * @packageDocumentation
 */

import { hmac } from './security';
import { Config } from './types';
import { decryptWebhookSecret } from './merchant-crypto';
import { validateWebhookUrl } from './merchants';
import { logFailure } from './logging';

/** Durable settlement-outbox record with delivery retry state. */
interface EventRow {
  id: string;
  merchant_id: string;
  payload: string;
  attempts: number;
  webhook_url: string;
  webhook_secret_encrypted: string;
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
 * @param runId - Opaque scheduled invocation reference, never an event identifier.
 */
export async function deliverWebhooks(
  db: D1Database,
  config: Config,
  runId: string = crypto.randomUUID(),
): Promise<void> {
  if (!config.merchantKeys) return;
  const now = Date.now();
  const rows = await db
    .prepare(
      `SELECT e.id, e.merchant_id, e.payload, e.attempts, m.webhook_url, m.webhook_secret_encrypted FROM events e
    JOIN merchants m ON m.id = e.merchant_id
    WHERE e.delivered_at IS NULL AND e.next_attempt_at <= ? AND e.lease_until < ? AND e.attempts < 12
      AND m.status = 'active' AND m.webhook_url IS NOT NULL AND m.webhook_secret_encrypted IS NOT NULL
    ORDER BY e.next_attempt_at LIMIT 10`,
    )
    .bind(now, now)
    .all<EventRow>();
  for (const event of rows.results) {
    let secret: string;
    try {
      validateWebhookUrl(event.webhook_url, config.webhookHosts);
      secret = await decryptWebhookSecret(
        config.merchantKeys,
        config.environment,
        event.merchant_id,
        event.webhook_secret_encrypted,
      );
    } catch {
      logFailure(
        'scheduled',
        runId,
        'webhook_delivery',
        'WEBHOOK_CONFIGURATION_BLOCKED',
      );
      // Defer blocked events so a full batch cannot starve other merchants; do not consume delivery attempts.
      await db
        .prepare(
          `UPDATE events SET next_attempt_at = ?, last_error = 'WEBHOOK_CONFIGURATION_BLOCKED'
        WHERE id = ? AND delivered_at IS NULL AND lease_until < ? AND next_attempt_at <= ?`,
        )
        .bind(Date.now() + 300_000, event.id, now, now)
        .run();
      continue;
    }
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
    let sending = false;
    try {
      const signature = await webhookSignature(
        secret,
        Math.floor(Date.now() / 1000),
        event.payload,
      );
      sending = true;
      const response = await fetch(event.webhook_url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
        headers: {
          'content-type': 'application/json',
          'crypto-gateway-event-id': event.id,
          'crypto-gateway-signature': signature,
        },
        body: event.payload,
      });
      delivered = response.ok;
      await response.body?.cancel();
    } catch {
      if (!sending) logFailure('scheduled', runId, 'webhook_delivery');
      /* Transport failures remain pending without logging endpoint secrets or response bodies. */
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
        delivered ? null : 'DELIVERY_FAILED',
        event.id,
        lease,
      )
      .run();
  }
}
