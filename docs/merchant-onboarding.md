# Managing merchants

Each merchant has its own D1 record. An operator manages these records with
`npm run merchant`; there is no public merchant-administration API. This guide
describes the tool, not the current acceptance status of a hosted environment.

## Merchant records and privacy

Required fields are the stable `id`, display `name`, `recipient`, API-key hash,
status and audit metadata. Optional fields are `legal_name`, `email`, international
`phone` (such as `+33123456789`), uppercase two-letter `country_code` and webhook
settings. Use `null` to clear an optional field.

Payments keep their original merchant ID and recipient. Profile names are not
copied onto payments. Never reuse a merchant ID for a different business: it would
expose historical payment reads.

Contact details are private support data. Collect only what is needed, restrict
access and agree retention/backup handling before collecting real personal data.
They must not appear in checkout, analytics, logs or webhook payloads. There is no
automatic deletion policy.

Audit records contain the operator label, revision, time and changed-field flags,
not values or secrets. Creation records identify creation without copying the
profile. The label is supplied by the caller; it does not prove identity. Provider
access controls and audit evidence are still needed.

## Local setup and command inputs

Use Node 24 and the installed repository dependencies. Run `npm run db:local`
before local provisioning. The merchant tool does not apply migrations. Keep the
gateway disabled until setup is verified.

Every `npm run merchant --` command requires:

| Argument        | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `--environment` | `local`, `dev` or `production`; no default.                        |
| `--operation`   | `add`, `update`, `disable`, `enable`, `rotate-key` or `reencrypt`. |
| `--id`          | Stable merchant ID: 1–64 letters, digits, underscores or hyphens.  |
| `--operator`    | Nonsecret operator label for the audit record.                     |
| `--revision`    | Expected current revision; use `0` only for creation.              |
| `--confirm`     | Exact `environment:id:operation:revision`.                         |

Send private JSON through stdin, then close stdin. The limit is 16 KiB. `add`
requires `name` and `recipient`; `update` accepts only changed profile fields.
Other operations require `{}`. Unknown fields and caller-supplied status, hashes,
revisions or audit metadata are rejected.

Synthetic input example:

```json
{
  "name": "Example merchant",
  "recipient": "So11111111111111111111111111111111111111112",
  "email": "support@example.org"
}
```

Example local command, with private stdin supplied by a trusted input mechanism:

```text
npm run merchant -- --environment local --operation add --id example --operator owner --revision 0 --confirm local:example:add:0
```

Do not put real contacts or secrets in command arguments, shell history, tracked
files, chat or CI logs. Protect private input files and remove them under your
secret-handling policy.

Local Wrangler uses a temporary SQL file containing profile data, hashes and
ciphertext, not original API keys or plaintext webhook secrets. The tool removes
it on normal completion/failure, but interruption can leave it behind. Protect
the temporary directory with OS access controls.

## API keys and updates

`add` and `rotate-key` generate a random 256-bit API key and print it **once**.
Run them in a private interactive terminal with transcript/log capture disabled.
Save the key securely and transfer it through a secure channel. Do not run
key-generating operations in logged automation.

Other operations return only the ID, revision and status. Every successful
operation increases the revision; stale revisions fail instead of overwriting
someone else's changes. Inspect only the intended merchant's ID, revision,
status and fields before an update, not every merchant record.

Disable/enable and recipient changes need explicit confirmation. Validate
recipient changes independently; they affect future payments only. A webhook
destination change requires an explicit signing secret, even when reusing the
previous secret. Setting `webhook_url` to `null` removes both webhook fields.

Disabling a merchant blocks merchant API authentication and pauses webhook
delivery. It does not delete history, cancel existing checkout access or stop
verification of already-submitted transfers. Already-sent funds can still settle.
Re-enabling can resume pending webhooks.

## Hosted operations

Implementation approval is not permission to modify hosted merchants. Before each
operation, approve the exact environment, source, account, database, merchant,
operation, revision and credential capability.

Pause competing merges, pushes, dispatches and operator writes; let active
deliveries finish. Do not cancel mutations. The standalone tool does not acquire
a GitHub workflow lock.

Hosted commands also require `--account`, `--database` and
`--confirm-target environment:account:database`, plus a separately approved
`CLOUDFLARE_API_TOKEN` in the process environment. The tool verifies the database
ID and `crypto-gateway-dev` or `crypto-gateway-production` name before parameterized
queries. That does not prove token scope, schema acceptance or exclusive access.
Local mode rejects hosted flags and uses only the local `DB` binding.

Errors are sanitized and **never automatically retried**. A timeout can happen
after a write commits. Inspect the merchant revision and audit record before
another mutation. If a new key was lost after a successful add/rotation, it cannot
be recovered from its hash; a separately confirmed rotation at the observed
revision is needed. Never blindly repeat the original command.

## Webhook encryption and rotation

`MERCHANT_ENCRYPTION_KEYS` is a server-only JSON secret:

```text
{"active":"key-id","keys":{"key-id":"<64 lowercase hexadecimal characters>"}}
```

Use independent random 256-bit keys for local, dev and production. Keep an
authoritative recovery copy in approved secret storage. **Losing a referenced key
makes its ciphertext unusable.** Never store these keys in D1, normal Worker
variables, Git or audit records.

Supply the target keyring to the operator process and configure the same keyring
as a Worker secret. Both must respect `WEBHOOK_HOSTS`; provisioning cannot
authorize a new hostname. `webhook_url` and `webhook_secret` are configured
together. Signing secrets must be 32–512 characters and are encrypted before
database writes.

Ciphertext uses `v1:key-id:nonce:ciphertext-with-tag`. AES-256-GCM uses a fresh
96-bit nonce and 128-bit authentication tag. Authenticated metadata binds purpose,
format version, key ID, environment and merchant ID, preventing cross-merchant or
cross-environment substitution. Decryption happens only when signing, without
logging plaintext.

Missing keys or authentication failures stop delivery before a fetch or retry
attempt is consumed. Blocked events are delayed five minutes with
`WEBHOOK_CONFIGURATION_BLOCKED` so other merchants can proceed; operators must
monitor this category. Without a keyring, webhook delivery is disabled but
polling-only merchants can still work. Readiness does not prove stored secrets
can be decrypted.

To rotate encryption keys under separate operational approval:

1. Add a new key ID/material while retaining all old keys. Update the Worker and
   operator keyrings consistently; change `active` to the new ID.
2. Run `reencrypt` for each webhook-enabled merchant at its expected revision. This
   preserves the signing secret and URL while producing new authenticated ciphertext.
3. Confirm every retained ciphertext uses the new key and test affected delivery.
4. Remove old keys only after considering database backups and recovery records
   that still need them. Never replace material under an existing key ID.

Encryption-key rotation is different from signing-secret rotation. Changing the
signing secret or URL affects pending deliveries and must be coordinated with
the receiver. D1 operators can still read profile contacts and webhook URLs;
restrict their access.

## Moving existing merchants to D1

The forward-only `0002_merchants.sql` adds merchant/audit tables and triggers. It
does not reset payments, import merchants, revoke keys or delete old secrets.

Before switching hosted code, separately approve/apply the migration, provision
the intended merchant IDs, configure webhook encryption where needed, verify
schema/recovery evidence and approve the compatible backend deployment. `add`
generates a new key even for an existing merchant ID. Coordinate secure handoff
and installation on the merchant's server during an approved maintenance window.
This procedure does not guarantee uninterrupted authentication between the
backend/key switches.

Before resuming traffic, each continuing merchant must activate its key and
successfully read a known, owned payment with `GET /v1/payments/{id}`. Do not create
a payment just to test authentication. If none exists, agree a separate bounded check.

Without a D1 record matching its credential hash, a merchant cannot authenticate.
Preserve old configuration until cutover is accepted; acceptance does not itself
authorize deletion. The retired first-schema tool refuses a multi-migration
source tree. Do not reuse it on an initialized database or remove migrations to
bypass its guard. Hosted migration needs a separately reviewed procedure and an
updated migration-set attestation. Frontend contract pins and provider settings
are not changed automatically.
