/** Synthetic merchant data and complete migration setup; no hosted credentials or providers.
 * @packageDocumentation
 */
import { readdirSync, readFileSync } from 'node:fs';
import { sha256 } from '../src/security';
import { merchantKeyring, encryptWebhookSecret } from '../src/merchant-crypto';

export const fixtureKeys = JSON.stringify({
  active: 'fixture',
  keys: { fixture: 'ab'.repeat(32) },
});

/** Apply forward migrations, preserving complete SQLite trigger definitions.
 * @param db - Isolated test D1 database.
 */
export async function migrate(db: D1Database): Promise<void> {
  for (const file of readdirSync('migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    for (const sql of readFileSync(`migrations/${file}`, 'utf8')
      .split(/;\s*(?=CREATE|$)/)
      .filter((part) => part.trim())) {
      await db.prepare(sql).run();
    }
  }
}

/** Insert a test-only merchant without using production credentials or configuration arrays.
 * @param db - Isolated D1 database.
 * @param id - Synthetic identity.
 * @param credential - Synthetic key whose hash is retained.
 * @param recipient - Public fixture recipient.
 * @param webhookSecret - Optional synthetic signing secret.
 */
export async function seedMerchant(
  db: D1Database,
  id: string,
  credential: string,
  recipient: string,
  webhookSecret?: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO merchants (id, name, api_key_hash, recipient, webhook_url, webhook_secret_encrypted, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fixture')`,
    )
    .bind(
      id,
      'Fixture merchant',
      await sha256(credential),
      recipient,
      webhookSecret ? 'https://merchant.example.org/webhook' : null,
      webhookSecret
        ? await encryptWebhookSecret(
            merchantKeyring(fixtureKeys),
            'local',
            id,
            webhookSecret,
          )
        : null,
      Date.now(),
      Date.now(),
    )
    .run();
}
