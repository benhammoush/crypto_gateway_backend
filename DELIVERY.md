# Delivery contract

## Targets

Local → dev → production; no staging. Production remains Devnet-only. The existing CI now includes disabled-by-default hosted delivery jobs, not provisioning or hosted acceptance. Provisioning, remote settings, merges and deployment require explicit authorization.

Each hosted target needs independent Worker, D1, merchant credentials, checkout secret, recipient wallets, webhook secrets, allowed checkout origin and scoped deployment credential. Keep runtime secrets in provider-managed storage. No implicit production fallback. Configure explicit managed target files outside source; never reuse the local binding for hosted work.

## Activation prerequisites

1. Configure protected main with strict required `quality` (GitHub Actions) and `CodeRabbit` checks bound to their respective apps, administrator enforcement, no force push/deletion, resolved conversations, at least one approving review, stale-review dismissal and independent last-push approval. CodeRabbit must finish reviewing the current head and submit an actual approving review; a successful status alone is insufficient. Verify its integration and approval behavior before relying on the gate.
2. Configure dev/production native environments restricted to main. Production requires enforceable explicit approval with admin bypass disabled. If unsupported, keep production disabled pending an approved alternative.
3. Verify provider isolation, scoped credentials and origin ownership. Disable Vercel Git auto-deploy; CI must own deployment. No hosted PR previews or cross-repository dispatch tokens.
4. Keep each environment's `DEPLOY_ENABLED` unset/false until readiness and separate enablement authorization. The owning CI checks the exact selected merged source, then uses the native target environment. Main pushes select dev; manual dev redeployment/production dispatch run from main with an exact `sha`. Serialize per target without cancelling active operations. Production requires a new dispatch and native approval; no dev-verification credential or custom release coordinator is used.
5. Review runtime dependency advisories, rate limiting, webhook destination behavior, retention and backup controls. Provision monitoring/alerts separately.
6. Probe RPC genesis and bounded dependencies; apply reviewed forward-compatible migrations before API code, then deploy the compatible frontend. Readiness remains configuration-only.
7. Complete manual localhost acceptance and controlled live dev payment/failure/recovery acceptance. Fixtures and dry-run builds are insufficient.

## Assigned task to manual merge

The owner assigns a bounded task and authorizes its endpoint; no backlog pickup is automatic. The assistant owns implementation, affected checks, authorized PR publication and valid CI/review repairs, including resuming a paused CodeRabbit review. `.coderabbit.yaml` enables real approval after review and prevents author-triggered approval/resolve overrides. The owner decides when to merge after current-head checks and approval pass. No automatic merger, merge PAT or separate orchestration service is required.

An authorized human merge triggers the existing main-push dev pipeline and hosted smoke when enabled. Check the exact source/provider identity and affected dev behavior before calling it verified; green PR CI is not deployment or payment acceptance. Deployment enablement, private-dev access and first-dev provisioning retain their separate prerequisites below. Production promotion remains a manual dispatch of the exact accepted dev source pair with native approval and recovery evidence; no new permissions or deployment flags are granted by this process.

The owner must compare the selected production SHA and compatible frontend revision with the recorded dev acceptance and recovery evidence before granting native production approval. The workflow checks source format, main ancestry and target configuration; it does not query dev acceptance or validate a machine-readable acceptance attestation. This is deliberately an owner-reviewed promotion prerequisite, not a claim of automatic acceptance enforcement or a request for another promotion service.

## Read-only dev access verification

### Private dev data-plane smoke

The private-dev pilot uses Cloudflare Access **Service Auth** on only
`crypto-gateway-dev.benhxm.workers.dev`, with independent runtime-proxy and CI
service identities. Applying protection, creating tokens and deployment are separate
owner approvals; this code does not configure Access or change payment flags.
The frontend proxy retains merchant/checkout Authorization and uses independent
`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers. Never substitute service auth
for payment authorization, expose machine credentials in browsers or add public
health/webhook exceptions to bypass failed checks. Keep Worker previews disabled
and inspect other entry points before claiming privacy. No production/other-project
Access settings change is part of this pilot.

The GitHub **dev environment** needs `GATEWAY_ACCESS_CI_CLIENT_ID` and
`GATEWAY_ACCESS_CI_CLIENT_SECRET` for the smoke helper. `smokeConfig` requires both
and the exact dev origin before normal delivery mutation; the first-bootstrap tool
also checks this dependency before mutation because it shares the helper. That does
not authorize rerunning bootstrap against an existing Worker. Existing first-deploy
guards and ordinary `DEPLOY_ENABLED` controls are unchanged. Production receives no
dev token and rejects accidental dev credentials. The CI identity is separate, not
inherently read-only: Access application/path scope must be reviewed independently.

Smoke performs only bounded GET `/health` and `/ready`, without redirects/retry,
preserving disabled readiness `503/ready:false` and expected Devnet identity. It
does not create/read payment rows or activate anything. Keep payments/demo off
through the privacy cutover; the failed Devnet test stays stopped and payment-row
existence is unresolved. The proxy aggregates backend IP limits by Vercel egress;
do not trust arbitrary browser-forwarded IPs to restore per-client identity. Existing
checkout/merchant/global limits and frontend WAF controls remain in force.

Stage compatible reviewed proxy/CI changes and credentials before an explicitly
approved dev cutover. Verify anonymous direct API rejection and authenticated
frontend/CI access. A failed cutover stays private and disabled pending diagnosis;
never reopen access, reset data or retry a payment automatically. Source/fixtures
are not live private-hosting or payment acceptance. See the frontend DELIVERY.md
for the cross-provider rollout/rollback boundaries and secret placement.

### Existing provider metadata verification

After its reviewed source is merged, the separate **Verify dev access (read-only)**
workflow may be manually dispatched from main under separate execution approval.
It uses only the dev environment, with deployment tracking disabled, and requires
deployment/payment flags to remain unset or false. It makes bounded authenticated
GET requests for the configured D1 database metadata and the named dev Worker's
deployment listing. It never deploys, applies migrations, runs SQL, reads payment
rows, fetches runtime secret values or changes provider configuration. No extra
credential or dependency installation is required in the credential-bearing step.

The existing dev account/database identities and `CLOUDFLARE_API_TOKEN` must permit
those reads. Missing or inaccessible Workers, HTTP failures, mismatched database
identities and malformed responses fail closed; they are not empty-history proof
and never trigger provisioning or retries. A successful result certifies only the
selected reads, not least-privilege token scope, schema state, origin ownership,
runtime configuration, deployment capability, payments or recovery eligibility.
Retain the exact workflow source SHA and sanitized result before deciding the next
separately authorized setup step. Never enable delivery merely to run this check.

### Separate read-only dev schema inspection

The separately reviewed **Inspect dev schema (read-only)** workflow is manual,
main-only and dev-only, with deployment tracking disabled and activation flags
required unset/false. It does not depend on a Worker existing. After matching the
configured dev D1 metadata, it uses the D1 query API with only two fixed SELECTs:
the SQLite schema catalog and, only when it is a table, migration names from
`d1_migrations`. It accepts no SQL inputs and never queries payment/application rows.
The query endpoint uses HTTP POST but supports `D1 Read`; no additional write
permission is requested for this check. Responses are bounded, not retried, and
must report zero writes with `changed_db=false`; missing/contradictory metrics stop
inspection rather than certifying a read-only outcome.

Expected table/index definitions are derived from the selected migration files in
disposable local memory only. Nothing is migrated remotely. Unexpected, partial or
rewritten application definitions, views posing as migration tracking, unknown
migration names and inaccessible provider state require review, not automatic
repair. Output contains fixed classifications/counts and recognized migration names,
never raw SQL, provider payloads, credentials or application rows. A successful
inventory can still report absent schema or incomplete records; it does not set
`D1_SCHEMA_DIGEST`, authorize migrations or certify readiness. Operator review and
separate execution approval remain mandatory before any live dispatch or mutation.

### First dev migration — separate mutation approval

The **Apply first dev schema (manual)** workflow is not an inspection workflow.
It may mutate only the configured dev D1 schema and Wrangler migration records by
applying the reviewed `0001_payments.sql`. Owner review/merge and separate execution
approval are required. It has no production target, Worker deployment or payment
activation. The workflow runs from main, requires its exact reviewed current-main
SHA and explicit first-dev confirmation, rejects job reruns, shares the dev
concurrency group, and repeats source quality checks before accessing credentials.

Required dev inputs include distinct `D1_DATABASE_ID`/`OTHER_D1_DATABASE_ID` values,
the intended account, both deployment/payment flags explicitly false and the
separate `CLOUDFLARE_D1_MIGRATION_TOKEN` environment secret. Do not replace or broaden
the existing read-only inspection token. The migration credential must permit D1
metadata/SELECT reads and schema writes on the intended account; no Workers write
permission is needed. Cloudflare resource scoping may be account-wide rather than
database-only: the owner must review that capability/blast radius, including other
databases in the same account, before granting access. It is not automatically a
dev-only credential merely because it is stored in a dev GitHub environment.

The runner accepts only the reviewed first-migration filename and fixed migration
digest. A fresh read-only inspection must still show the exact dev identity,
absent application schema and no migration tracking table or records. Initialized,
partial or drifted states stop without automatic repair. Wrangler 4.149.0 is invoked
once using the installed local CLI, a generated migration-only configuration and
an absolute selected-source migrations directory. The config has no Worker
entrypoint, runtime vars or secret values and must never be used for deployment.
The CLI owns its normal migration bookkeeping; no fake migration record is inserted.

After the single command, one read-only inspection checks source-derived definitions
and the expected migration record. A failed/timed-out command remains uncertain even
if subsequent definitions match; any unavailable or inconsistent readback stops the
job. The command may have created the tracking table or applied some/all work before
failure. Do not rerun, reset, down-migrate or repair automatically: diagnose and obtain
a fresh reviewed recovery scope first. Raw Wrangler/provider output is not printed.
The sanitized summary does not set `D1_SCHEMA_DIGEST`; operator attestation and later
Worker bootstrap/deployment remain separate checkpoints. This workflow must not be
used for future migrations without a new reviewed scope and implementation.

## Compatible source selection

### First dev Worker code bootstrap (separate manual approval)

The **Bootstrap first dev Worker (manual)** workflow is the only first-code
exception to the normal delivery job's successful legacy deployment-history
listing prerequisite. It never treats a legacy 404/403 or other failed read as
empty history. Normal delivery, read-only verification and production gates are
unchanged. Source review/merge and a separate explicit execution approval are
required; adding this workflow does not authorize dispatch or deployment.

It accepts only a fresh attempt-1 manual dispatch from main with the exact reviewed
current-main `sha`, the independently verified existing empty Worker's immutable
`worker_id`, and `confirm_first_dev_deployment:true`. Quality/advisory checks must
pass first, current main is rechecked after the shared backend-dev concurrency
gate, and both GitHub `DEPLOY_ENABLED` and `PAYMENTS_ENABLED` must remain explicitly
false. Hosted runtime `PAYMENTS_ENABLED` must also be false. The dedicated
confirmation authorizes only this first dev code deployment, not ordinary delivery
activation. Production and non-main/automatic/rerun execution are rejected.

Keep the inspection `CLOUDFLARE_API_TOKEN` unchanged. The separately approved dev
environment secret `CLOUDFLARE_WORKER_BOOTSTRAP_TOKEN` needs Workers Scripts Write
and the reads required by the new Workers metadata/version and legacy deployment
endpoints. Its account-level capability can affect other Workers; owner review of
the grant/blast radius remains mandatory. The inspection token alone reads D1's
metadata and fixed schema/migration SELECTs. No runtime secret is passed to the
bootstrap workflow, and no provider tokens or raw responses are logged.

Before mutation, fresh D1 inspection must match the source definitions, migration
records and configured attestation. Successful new Workers API metadata must match
the supplied immutable ID, `crypto-gateway-dev`, and exact `API_ORIGIN`, with public
and preview subdomains disabled and no listed resource references. A successful,
bounded new-API versions inventory must explicitly contain zero versions and
`total_count:0`. Missing/inaccessible/malformed metadata, any existing version or
schema drift stops before mutation. This does not certify an accepted recovery
predecessor or repair a resource with history.

The pinned local Wrangler runs once with a managed source-root configuration and
explicit account ID, never local `wrangler.toml`. The bootstrap fixes preview URLs
off; the reviewed hosted template enables the public workers.dev route and minutely
Cron. The source's scheduled handler returns before database/payment/webhook work
while payments are disabled. This creates real API code exposure and a deployment;
it is not merely resource provisioning. No schema migration, frontend deployment,
secret upload or payment operation is requested.

Readback must identify exactly one first version and its single 100% deployment,
matching Worker identity/subdomain state and fresh schema metadata. Source, Worker,
version and deployment IDs are retained in the job summary before smoke checks.
Configuration smoke requires `/health` HTTP 200 with exact service/package version;
disabled `/ready` must be HTTP 503 with exactly `ready:false`, `environment:dev`,
`network:solana-devnet`. A generic 503/NOT_CONFIGURED response is failure, not disabled
readiness. Normal delivery now also checks the status/body corresponding to its
configured payment flag; it never enables payments to make smoke pass.

Any failed/timed-out deployment or incomplete readback remains uncertain even if
later checks pass. Inspect before a separately authorized recovery decision; never
rerun, retry deployment, reset D1, fabricate history or automatically roll back.
Zero-version checks reject a later dispatch once the first version exists. A first
successful bootstrap is not hosted-payment acceptance or an accepted rollback
baseline. Owner-entered provider runtime secrets (which can create deployments),
future delivery enablement and hosted acceptance remain separate approved steps.

### Shared manual-production setup

Each GitHub environment has `CLOUDFLARE_ACCOUNT_ID`, `API_ORIGIN`, `D1_DATABASE_ID`,
`OTHER_D1_DATABASE_ID`, `D1_SCHEMA_DIGEST` and `WORKER_CONFIG_JSON` variables, plus
its own scoped `CLOUDFLARE_API_TOKEN` secret. Use password-manager labels such as
`crypto-gateway-production-cloudflare-deploy`; labels are not GitHub secret names.
Do not put runtime secrets or keyed RPC URLs in configuration variables or evidence.
No extra GitHub PAT is required. Native production approval permits self-review and
disables administrator bypass; verify protections using the owner's local login.

`WORKER_CONFIG_JSON` is the operator-managed hosted configuration outside source,
materialized only in the CI workspace as `wrangler.delivery.json`. It must specify
`name: crypto-gateway-dev` or `crypto-gateway-production`, `main: src/index.ts`,
`compatibility_date: 2026-10-04`, `compatibility_flags: [global_fetch_strictly_public]`,
`workers_dev: true`, the target's isolated `DB` D1 binding (`database_name` equal to
the Worker name, actual `database_id`, `migrations_dir: migrations`), and
`triggers: {crons: ["* * * * *"]}`. Its only plain vars are the matching `APP_ENV`,
explicit `PAYMENTS_ENABLED`, HTTPS `CHECKOUT_ORIGIN`, public
`WEBHOOK_HOSTS` and optionally the public
`SOLANA_RPC_URL: https://api.devnet.solana.com`. Omit that plain RPC variable when
the provider-managed `SOLANA_RPC_URL` secret supplies the keyed Devnet endpoint;
never declare the same binding as both plain configuration and a secret. Configure
keyed RPC/provider/merchant/checkout/webhook secrets through the provider, not this file.
The guard rejects local/shared bindings, unknown fields and mismatched schema
readback. It never deploys the local `wrangler.toml`.

Apply reviewed forward-compatible migrations separately to the exact target D1
before code deployment. After readback, record the selected migration-set digest
from `migrationDigest()` in `scripts/check-delivery.mjs` as `D1_SCHEMA_DIGEST`.
This is an operator attestation, not a live database inspection or migration service.
The workflow never applies remote migrations, resets data or reverses payments.
The backend guard/config file must not be run locally with live credentials merely
to test it; its pure regression fixtures do not access providers.

Before native production approval, manually recheck both accepted source SHAs,
versions, provider/configuration identities, schema state and acceptance/recovery
evidence. Any intervening deployment/configuration change invalidates affected
acceptance. A SHA input or green CI alone is not acceptance. Production holds no
dev-verification credential and does not query dev. Initial Worker creation and
first-deployment recovery acceptance remain operator checkpoints. Retain eligible
previous versions when available; for first production use the approved
no-predecessor policy below, never invent a predecessor. Provider version listing
must succeed before mutation; missing resources or failed inspection are not
proof of empty history and require separately authorized setup/diagnosis.
Deployment jobs retain provider version lists before/after mutation; export exact
compatible identities to release records. Failure may mean partial mutation; inspect
both providers before a new dispatch, never automatically retry or roll back.

Each repository owns its CI/releases. Do not infer the counterpart from latest main. The frontend records an explicitly selected backend schema revision and hash. For promotion, manually record exact accepted backend/frontend SHAs, versions, provider deployment identities, migrations, configuration identity, CI evidence and previous compatible recovery identities. A local schema revision is not production evidence.

Deploy backward-compatible backend changes first. Accept the exact deployed dev pair, then promote those same source revisions through manual production gates. Shared-dev drift invalidates affected acceptance. Environment-specific builds preserve source/lockfile identity, not necessarily byte identity. Inspect both providers after partial failures.

## Monitoring and recovery

### Approved first-production policy

Before first production, validate the exact compatible dev backend/frontend pair
with controlled payment/failure acceptance and rehearse dev application rollback.
Restore and revalidate that candidate pair afterward. Rehearse database recovery
only on an isolated non-production copy. Explicitly accept and record that first
production has no previous accepted production pair to restore; an initial Worker
version or a successful smoke check is not an accepted recovery baseline.

If first production fails or its outcome is uncertain, stop and inspect both
providers, D1/schema state and payment/webhook/Cron effects. Recover only through
fresh, separately authorized exact-SHA dispatches from main with native production
approval for each affected repository, using an exact dev-accepted compatible pair,
backend first when both change. Repeat affected acceptance if source,
configuration or schema compatibility changes. Never blindly retry, rerun
production jobs, bypass approval, down-migrate/reset D1 or reverse/delete payment
data. Webhook replay and data repair remain separate approvals.

Retain the first accepted immutable frontend deployment and compatible Worker
version, both source SHAs/versions, configuration/schema identities and acceptance
evidence as the rollback candidate for later releases; reverify compatibility with
current migrations before use. No predecessor is fabricated or required for this
first-production exception. These are operator-reviewed prerequisites, not
automatic proof from a SHA or provider version list. Per-environment
`DEPLOY_ENABLED`, native approval and all isolation/schema guards remain mandatory.
This policy does not authorize publication, activation, provisioning, migrations,
deployment, payment execution or data mutation. Production remains Devnet-only.

### Ongoing monitoring and recovery

Before public activation, configure alerts for API errors, pending verification age, exhausted webhook events and delivery backlog. Health/readiness alone do not certify payments. Logs may include safe request IDs/error classifications, never credentials, checkout tokens or provider payloads.

Record recoverable provider artifacts before release. Rehearse restoring the prior compatible API/frontend pair without reversing payment data; verify compatibility with current migrations. Rehearse database recovery only on an isolated non-production copy. No automatic down-migrations, database resets or payment deletion.

Exhausted webhook delivery is visible in events (`delivered_at IS NULL AND attempts >= 12`). Review the destination and consumer deduplication before a separately approved replay of exact event IDs. Never recreate settlement or rewrite the immutable payload to replay notifications.

## Shopify retirement

Preserve all unrelated/uncommitted work. Inventory reusable code and existing resource/credential consumers. Only after standalone acceptance, separately authorize disabling obsolete triggers, retiring resources, revoking unused credentials and deleting old repositories. No such actions are included in local implementation.
