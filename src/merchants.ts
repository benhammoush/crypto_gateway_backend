/** D1 merchant authentication and shared operator validation; profile data stays private.
 * @packageDocumentation
 */

import { base58Length, sha256 } from './security.ts';
import type { Config, Merchant } from './types.ts';

/** Operator-visible persisted profile; never serialize this object into a payment response. */
export interface MerchantRecord {
  id: string;
  name: string;
  legal_name: string | null;
  email: string | null;
  phone: string | null;
  country_code: string | null;
  api_key_hash: string;
  recipient: string;
  webhook_url: string | null;
  webhook_secret_encrypted: string | null;
  status: 'active' | 'disabled';
  revision: number;
  created_at: number;
  updated_at: number;
  updated_by: string;
}

/** Validate a webhook destination against the target's trusted public-host allowlist.
 * @param value - Destination configured by an operator.
 * @param hosts - Exact hostnames allowed by runtime configuration.
 */
export function validateWebhookUrl(value: string, hosts: string[]): void {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      (url.port && url.port !== '443') ||
      url.username ||
      url.password ||
      url.hash ||
      !hosts.includes(url.hostname) ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname) ||
      /^[\d.]+$/.test(url.hostname)
    )
      throw new Error();
  } catch {
    throw new Error('Webhook destination is not approved.');
  }
}

/** Validate the complete profile before any write; contacts are optional and bounded.
 * @param record - Proposed merchant record.
 * @param hosts - Target webhook allowlist.
 */
export function validateMerchant(
  record: MerchantRecord,
  hosts: string[],
): void {
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(record.id) ||
    !record.name ||
    record.name.length > 160 ||
    record.name.trim() !== record.name ||
    !/^[a-f0-9]{64}$/.test(record.api_key_hash) ||
    typeof record.recipient !== 'string' ||
    base58Length(record.recipient) !== 32 ||
    record.recipient === '11111111111111111111111111111111' ||
    !['active', 'disabled'].includes(record.status) ||
    !/^[A-Za-z0-9_.@-]{1,100}$/.test(record.updated_by)
  )
    throw new Error('Invalid merchant configuration.');
  for (const value of [
    record.name,
    record.legal_name,
    record.email,
    record.phone,
    record.country_code,
  ]) {
    if (
      value !== null &&
      (typeof value !== 'string' ||
        value.length > 254 ||
        !value.trim() ||
        Array.from(value).some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ))
    )
      throw new Error('Invalid merchant profile.');
  }
  if (
    (record.email !== null &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email)) ||
    (record.phone !== null && !/^\+[1-9][0-9]{7,14}$/.test(record.phone)) ||
    (record.country_code !== null && !/^[A-Z]{2}$/.test(record.country_code))
  )
    throw new Error('Invalid merchant contact.');
  if (Boolean(record.webhook_url) !== Boolean(record.webhook_secret_encrypted))
    throw new Error('Webhook URL and encrypted secret must be paired.');
  if (record.webhook_url) validateWebhookUrl(record.webhook_url, hosts);
}

/** Resolve only the payment-facing fields for an active merchant from its credential digest.
 * @param db - Target D1 binding.
 * @param credential - Untrusted bearer credential, never persisted in plaintext.
 * @returns Minimal authenticated merchant, or null when invalid or disabled.
 */
export async function authenticateMerchant(
  db: D1Database,
  credential: string,
): Promise<Merchant | null> {
  const row = await db
    .prepare(
      "SELECT id, recipient FROM merchants WHERE api_key_hash = ? AND status = 'active'",
    )
    .bind(await sha256(credential))
    .first<{ id: string; recipient: string }>();
  return row ? { id: row.id, recipient: row.recipient } : null;
}

/** Split the trusted runtime destination list for validation at provisioning and delivery.
 * @param value - Comma-separated runtime hostnames.
 * @returns Trimmed nonempty hostnames.
 */
export function webhookHosts(
  value: string | undefined,
): Config['webhookHosts'] {
  return (value ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}
