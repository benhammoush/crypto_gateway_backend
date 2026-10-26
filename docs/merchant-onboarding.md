# Merchant onboarding

Merchants are independent D1 records, not entries in a shared hidden JSON secret.
Provisioning is an operator action; there is no public merchant administration API.
This procedure describes the source implementation, not current hosted acceptance.

## Record and privacy

Required: stable `id`, display `name`, `recipient`, API-key hash, status and audit
metadata. Optional: `legal_name`, `email`, international `phone` (for example
`+33123456789`), uppercase two-letter `country_code`, and webhook configuration.
Use `null` to clear optional fields. Names are not snapshotted onto payments;
existing payments retain their merchant ID and original recipient.

Contact details are for operator support, not checkout, analytics, logs or webhook
payloads. Collect only what is needed, restrict D1 access, and agree retention and
backup handling before collecting real personal data. No automatic deletion policy
is introduced. Audit rows contain a caller-supplied operator label, revision, time
and changed-field flags, not profile values or secrets. The label is not proof of
operator identity; provider access controls and provider audit evidence remain
necessary. Creation audit rows identify the creation without copying the profile.

## Operator tool

Use Node 24 and the repository's installed dependencies. Apply forward migrations to
the local database with `npm run db:local` before local provisioning. The tool never
applies migrations itself. Keep the gateway disabled until setup is verified.

`npm run merchant --` accepts these explicit arguments:

| Argument        | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `--environment` | `local`, `dev` or `production`; no default.                        |
| `--operation`   | `add`, `update`, `disable`, `enable`, `rotate-key` or `reencrypt`. |
| `--id`          | Stable merchant ID: 1–64 letters, digits, underscores or hyphens.  |
| `--operator`    | Nonsecret operator label for the audit record.                     |
| `--revision`    | Expected current revision; use `0` only for creation.              |
| `--confirm`     | Exact `environment:id:operation:revision`.                         |

Private input is a JSON object on stdin, limited to 16 KiB. For `add`, supply `name`
and `recipient`; optional fields can be included. For `update`, supply only changed
profile fields. Other operations require `{}`. Unknown fields are rejected. Status,
key hashes, audit metadata and revisions cannot be supplied through profile input.

Example **synthetic** add input (not real onboarding data):

```json
{
  "name": "Example merchant",
  "recipient": "So11111111111111111111111111111111111111112",
  "email": "support@example.org"
}
```

Run the command with private stdin supplied by a trusted local input mechanism:

```text
npm run merchant -- --environment local --operation add --id example --operator owner --revision 0 --confirm local:example:add:0
```

Send the JSON and close stdin (EOF). Do not put real credentials, signing secrets
or contacts in command arguments, shell history, tracked files, chat or CI logs.
If using a private input file, protect it and remove it according to your secret
handling policy. Local Wrangler uses a temporary SQL file containing profile data,
hashes and ciphertext, never original API keys or plaintext webhook secrets; the
tool removes it on completion/failure. OS-level interruption can leave a temporary
file, and Windows access controls must protect the operator's temporary directory.

Successful `add` and `rotate-key` print the new 256-bit random API key **once** on
stdout. Use a private interactive terminal with transcript/log capture disabled;
save it securely and transfer it to the merchant through a secure channel. Other
operations return only ID, revision and status. Do not run credential-generating
operations in logged automation. Every successful operation advances the revision.
Stale revisions fail instead of overwriting someone else's changes.

Before updating, inspect the selected merchant's ID, revision, status and intended
fields through approved operator access, not a public endpoint. Do not read/export
all merchant records merely to add one. Disable/enable and recipient changes are
explicitly confirmed operations; validate the recipient independently. Changing a
recipient affects only future payments. Changing a webhook destination requires an
explicit signing secret for that destination, even when deliberately reusing the
previous secret. Set `webhook_url` to `null` to remove both webhook fields.

## Hosted operations require separate authorization

Do not run this tool against hosted targets under implementation approval alone.
For each operation, approve the exact environment, source, account, database,
merchant, operation, revision and permitted credential capability. Arrange exclusive
target maintenance: freeze competing pushes/merges/dispatches and operator writes,
let active deliveries finish, and do not cancel mutations. Standalone CLI execution
does not acquire a GitHub workflow lock.

In addition to the arguments above, hosted commands require `--account`,
`--database`, and `--confirm-target environment:account:database`. The process
environment must supply a separately approved `CLOUDFLARE_API_TOKEN`. The tool checks
database metadata against the exact ID and `crypto-gateway-dev` or
`crypto-gateway-production` name before issuing parameterized D1 queries. It does
not prove least-privilege token scope, schema acceptance or exclusive access. Local
mode rejects hosted target flags and uses only Wrangler's local `DB` binding.

Errors are sanitized and **never automatically retried**. A timeout can occur after
a write commits. Inspect the exact merchant revision and audit record before any
further mutation. If a creation or key rotation committed but its returned key was
lost, perform a separately confirmed key rotation at the observed revision; there
is no key recovery from its hash. Do not replay an uncertain command blindly.

Disabling a merchant blocks merchant API authentication and pauses webhook delivery.
It does not delete payment history, cancel already-issued checkout access, or stop
verification of previously submitted transactions. That permits already-sent funds
to settle. Re-enabling can make pending webhook events eligible again.

## Webhook encryption and rotation

`MERCHANT_ENCRYPTION_KEYS` is a server-only JSON secret:

```text
{"active":"key-id","keys":{"key-id":"<64 lowercase hexadecimal characters>"}}
```

Each value is an independently generated random 256-bit encryption key. Use distinct
keys for local, dev and production. Keep an authoritative recovery copy in approved
secret storage. **Losing a referenced key makes that ciphertext unusable.** Never
store encryption keys in D1, ordinary Worker variables, Git or audit records.

The operator tool receives the same target keyring through its process environment,
plus the target's `WEBHOOK_HOSTS` allowlist. Runtime delivery independently rechecks
that allowlist; provisioning cannot authorize a new hostname. Input fields
`webhook_url` and `webhook_secret` configure a webhook together. Signing secrets
must contain 32–512 characters and are encrypted before any database write.

Ciphertext is versioned as `v1:key-id:nonce:ciphertext-with-tag`. AES-256-GCM uses a
fresh random 96-bit nonce and a 128-bit authentication tag. Authenticated metadata
binds the purpose, format version, key ID, environment and merchant ID, preventing
cross-merchant/environment substitution. Delivery decrypts only when needed for
signing, without logging plaintext. Authentication failures and missing keys stop
delivery before fetching or consuming a retry attempt. Such events are deferred
for five minutes with `WEBHOOK_CONFIGURATION_BLOCKED`, allowing later events for
other merchants to progress; operators must monitor that classification. Absent keyrings disable
webhook delivery but do not block polling-only merchants. Readiness remains
configuration-only and does not certify that stored ciphertext is decryptable.

To rotate encryption keys, under separate operational approval:

1. Add a new key ID/material while retaining all old keys. Update the Worker and
   operator keyrings consistently; change `active` to the new ID.
2. Run `reencrypt` for each webhook-enabled merchant at its expected revision. This
   preserves the signing secret and URL while producing new authenticated ciphertext.
3. Confirm every retained ciphertext uses the new key and test affected delivery.
4. Remove old keys only after considering database backups and recovery records
   that still need them. Never replace material under an existing key ID.

This is encryption-key rotation, not webhook signing-secret rotation. Changing a
signing secret or URL changes pending deliveries and requires coordination with
the receiver. Encryption does not hide profile contacts or webhook URLs from D1
operators; those still need access controls.

## Cutover prerequisites

The forward-only `0002_merchants.sql` adds merchant/audit tables and triggers. It
does not reset payment tables, copy existing merchants, revoke keys or delete the
old secret. No importer or hosted migration is included in this task.

Before switching hosted code: approve and apply the migration, provision the intended
merchant IDs in D1, configure the separate encryption keyring where webhooks are
needed, verify schema/readback and recovery evidence, then approve the compatible
backend deployment. `add` generates a new API key; retaining a merchant ID does not
preserve its previous credential. Securely hand each existing merchant its new key
and coordinate installation in its server-side integration during an approved
maintenance window. Expect authenticated requests to fail between the backend/key
switches; this procedure does not provide zero-downtime credential continuity.
Before approving cutover completion and resuming normal traffic, require every
continuing merchant to activate its new credential and pass an authenticated
`GET /v1/payments/{id}` for a known payment belonging to that merchant. Do not create
a payment merely to test authentication. If a merchant lacks a known payment,
agree a separate bounded verification procedure before accepting its cutover.

Existing payments retain their original merchant ID; assigning that ID to a
different business would expose its historical merchant-scoped reads. Never recycle
merchant IDs. Without a D1 record matching its credential hash, a merchant cannot
authenticate. Preserve old configuration until the separately approved cutover is
accepted; do not infer permission to delete it from this implementation.

The retired first-schema tool intentionally refuses a multi-migration source tree.
Do not reuse it for this initialized-database migration. Follow the owning
[delivery contract](delivery.md) for a new reviewed operational procedure and updated
migration-set attestation. No frontend contract-source pin or provider settings
are changed automatically.
