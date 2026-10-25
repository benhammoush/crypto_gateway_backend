# Delivery contract

## Versioned CI/CD entry points

The parent-scoped Miniflare override keeps Undici on patched 7.30.1 while retaining
the reviewed Worker toolchain. Remove it when Miniflare's dependency declaration
naturally resolves to a patched compatible release, not by forcing a major upgrade.

Automation 5.0 separates PR verification, dev delivery and production delivery
with distinct job names, retaining flag-free delivery and weekly vulnerability
audits. The published immutable shared revision is pinned in
`.github/ci-cd.json`; source adoption does not change live settings.

The standalone PR `Verify` result preserves the existing required-check context;
the older check-name migration below is historical. No protection change is
needed for this workflow split. Workflow comments are limited to two header lines;
this runbook and the shared contract own the detail.

The `.github/workflows/weekly-vuln-audit.yml` caller uses the same published shared
SHA as release workflows and runs weekly or manually after adoption on main.
It checks vulnerabilities without updating dependencies or deploying. See the
[shared audit contract](https://github.com/benhammoush/ci-cd-workflows/blob/d1143395dc6a078ef284978c1daf039ed06ff7d1/docs/contract.md#weekly-vulnerability-audits).

The [shared contract](https://github.com/benhammoush/ci-cd-workflows/blob/main/docs/contract.md)
v5.0.0 is pinned in `.github/ci-cd.json`. The Worker profile does not install
browsers. `verify-pr.yml` checks PR creation, updates and reopening without
deployment jobs or secrets. `verify-and-deploy-dev.yml` verifies main pushes and
delivers only successful exact main commits to dev without a deployment-enable
switch. Separate manual `verify-and-deploy-prod.yml` selects
a full merged `sha`, requires retained successful dev evidence, verifies the
candidate and waits for native approval. Dev-workflow dispatch is the exact-SHA dev recovery
path. These replace older combined target-selector invocations, not isolation,
schema readback or payment/recovery acceptance requirements.

All three entry points, the weekly audit and `.github/ci-cd.json` pin published
shared revision `d1143395dc6a078ef284978c1daf039ed06ff7d1` (automation 5.0).
Publication does not authorize a merge, deployment or production approval.

All Ubuntu jobs use `ubuntu-24.04`. Deployment consumes the checked dry-run bundle
with `--no-bundle`, retaining the managed configuration and migration-digest guards.
Provider version tag/message bind active immutable identity to source/run/artifact,
followed by existing health/readiness checks. Records retain the previous version;
failed/uncertain records are not promotable and mutations are not retried. Existing
first-use bootstrap, migration and legacy inspection workflow entry points are retired; their tested CLI tools remain available only under a separately approved operational scope. Disabled
targets stay disabled; no payment, migration, credential change or provider
deployment occurs as part of this source migration.

## Targets

Local → dev → production; no staging. Production remains Devnet-only. Successful main verification automatically starts dev delivery; production requires manual dispatch and native approval, not a boolean enable flag. This does not establish provisioning or hosted acceptance. Provisioning, remote settings and merges require explicit authorization.

Each hosted target needs independent Worker, D1, merchant credentials, checkout secret, recipient wallets, webhook secrets, allowed checkout origin and scoped deployment credential. Keep runtime secrets in provider-managed storage. No implicit production fallback. Configure explicit managed target files outside source; never reuse the local binding for hosted work.

## Activation prerequisites

1. Configure protected main with strict required `Verify` (GitHub Actions) and `CodeRabbit` checks bound to their respective apps, replacing prior aliases through the coordinated migration. Retain administrator enforcement, no force push/deletion, resolved conversations, at least one approving review, stale-review dismissal and independent last-push approval. CodeRabbit must finish reviewing the current head and submit an actual approving review; a successful status alone is insufficient. Verify its integration and approval behavior before relying on the gate.
2. Configure dev/production native environments restricted to main. Production requires enforceable explicit approval with admin bypass disabled. If unsupported, keep production disabled pending an approved alternative.
3. Verify provider isolation, scoped credentials and origin ownership. Disable Vercel Git auto-deploy; CI must own deployment. No hosted PR previews or cross-repository dispatch tokens.
4. Complete dev configuration before merging: delivery ignores `DEPLOY_ENABLED`, including absent/false values. Hold production by not dispatching it until readiness and separate execution authorization. The owning CI checks the exact selected merged source, then uses the native target environment. Main pushes select dev; manual dev redeployment/production dispatch run from main with an exact `sha`. Serialize per target without cancelling active operations. Production requires a new dispatch and native approval; no dev-verification credential or custom release coordinator is used.
5. Review runtime dependency advisories, rate limiting, webhook destination behavior, retention and backup controls. Provision monitoring/alerts separately.
6. Probe RPC genesis and bounded dependencies; apply reviewed forward-compatible migrations before API code, then deploy the compatible frontend. Readiness remains configuration-only.
7. Complete manual localhost acceptance and controlled live dev payment/failure/recovery acceptance. Fixtures and dry-run builds are insufficient.

## Assigned task to manual merge

The owner assigns a bounded task and authorizes its endpoint; no backlog pickup is automatic. The assistant owns implementation, affected checks, authorized PR publication and valid CI/review repairs, including resuming a paused CodeRabbit review. `.coderabbit.yaml` enables real approval after review and prevents author-triggered approval/resolve overrides. The owner decides when to merge after current-head checks and approval pass. No automatic merger, merge PAT or separate orchestration service is required.

An authorized human merge triggers the main-push dev pipeline and hosted post-deployment verification after successful verification, without a deployment-enable flag. Check the exact source/provider identity and affected dev behavior before calling it verified; green PR CI is not deployment or payment acceptance. Retained CLI access/provisioning tools require a separate approved operational scope, not dispatch of a retired workflow. Production promotion remains a manual dispatch of the exact accepted dev source pair with native approval and recovery evidence; no new credentials are granted by this process.

The owner must compare the selected production SHA and compatible frontend revision with the recorded dev acceptance and recovery evidence before granting native production approval. The workflow checks source format, main ancestry and target configuration; it does not query dev acceptance or validate a machine-readable acceptance attestation. This is deliberately an owner-reviewed promotion prerequisite, not a claim of automatic acceptance enforcement or a request for another promotion service.

## Retired dev maintenance workflows and retained CLI tools

The `verify-dev.yml`, `inspect-dev-schema.yml`, `migrate-dev.yml`,
`bootstrap-dev.yml` and `diagnose-dev-delivery.yml` entry points are retired. The following legacy tool contracts
are retained for their tested CLI implementations, not as instructions to dispatch
those workflows. Removal does not revoke credentials, alter provider resources or
authorize CLI execution. The retained `scripts/diagnose-dev-delivery.mjs` CLI provides
bounded metadata/packaging checks; it does not inspect schema definitions or
migration records. Schema inspection remains available through the separately
authorized `scripts/inspect-dev-schema.mjs` CLI. Any future migration or bootstrap
needs a fresh approved scope, not reuse of first-dev automation on initialized data.

Dev maintenance no longer reads `DEPLOY_ENABLED`: it cannot pause automatic
delivery. Any newly approved CLI maintenance procedure must first freeze main
pushes/merges, manual CI dispatches and workflow reruns, then let queued/active
deliveries finish. Never cancel an active mutation. The retired workflows' GitHub
locks and dispatch guards do not protect standalone CLI execution; a new approved
procedure must provide equivalent serialization and source/confirmation guards.
A live initialized target still fails first-use bootstrap/migration preflight.
Production dispatch and approval remain separate.

The retired **Verify dev access (read-only)** workflow previously ran from main.
The retained `scripts/verify-dev.mjs` CLI still needs separate execution approval.
It uses only the dev environment, with deployment tracking disabled, and requires
the payment flag to remain unset or false. It makes bounded authenticated
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

### Read-only dev delivery diagnosis

Normal delivery also retains a `failure` classification in the existing
`delivery-record.json` when Wrangler's subprocess fails. It records a fixed stage,
exit/process classification, allowlisted Cloudflare codes and known-error booleans;
unknown codes and all raw output, command arguments, paths and credentials are
omitted. Unrecognized errors remain unclassified. The existing checkpoint status
and prior identities are unchanged: this evidence never proves that mutation did
not occur. Provider reconciliation is still required before recovery. No automatic
retry or permission change is introduced.

Temporary encrypted error capture has been removed. Preserve historical encrypted
evidence and its non-exportable recipient private key in the operator's Windows
user key store until investigation and retention requirements are resolved. Keep
any decrypted output in memory on the recipient machine, never in files, Git,
logs or chat; expose only verified non-secret findings. Removing capture does not
authorize key deletion, credential revocation or another delivery attempt.

After a failed delivery, reconcile the retained checkpoint with provider state
before considering another attempt. Under separate execution approval, the retained
`scripts/diagnose-dev-delivery.mjs` CLI can inspect the
existing dev credential's metadata access and locally dry-run the Worker package.
It does not require disabling an already enabled dev environment, and does not
change the stricter bootstrap/access-verification guards. The CLI does not acquire
a GitHub workflow lock; arrange a stable target before an authorized inspection.

The diagnostic uses only fixed dev metadata GETs and a credential-free Wrangler
dry run. Its summary contains HTTP classifications, numeric provider error codes,
configuration-match booleans and the packaging result, never raw response bodies,
token identities/policies, secret values or subprocess output. Optional token
self-policy inspection may be denied; do not broaden credential permissions just
to make it visible. Listed write permissions are not proof of effective deployment
access. A successful dry run does not validate provider writes or live readiness.

No upload, deployment, schema SQL, payment request or secret change occurs. The
diagnostic neither retries a failed delivery nor authorizes a later recovery. A
fresh deployment still requires the applicable separate authorization and gates.

### Historical contract: read-only dev schema inspection

The retired **Inspect dev schema (read-only)** workflow was manual,
main-only and dev-only, with deployment tracking disabled and the payment flag
required unset/false. This section records its historical safety contract, not an
available dispatch procedure. The retained `scripts/inspect-dev-schema.mjs` CLI
requires separate execution approval. It does not depend on a Worker existing. After matching the
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
separate execution approval remain mandatory before any live CLI operation or mutation.

### Historical contract: first dev migration

The retired **Apply first dev schema (manual)** workflow was a mutation workflow,
not an inspection. It applied only the reviewed `0001_payments.sql` to the configured
dev D1 schema and Wrangler migration records, without a production target, Worker
deployment or payment activation. The remaining details record that historical
safety contract; they are not migration dispatch steps. The retained
`scripts/migrate-dev.mjs` CLI is not an approved operational replacement. Any use
needs a fresh owner-reviewed procedure covering exact source, quality checks,
explicit confirmation, serialization and credential access before execution.

Required dev inputs include distinct `D1_DATABASE_ID`/`OTHER_D1_DATABASE_ID` values,
the intended account, `PAYMENTS_ENABLED` explicitly false and the
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
Worker bootstrap/deployment remain separate checkpoints. The retired workflow is
unavailable; future migrations need a new reviewed scope and implementation.

### Historical contract: first dev Worker code bootstrap

The retired **Bootstrap first dev Worker (manual)** workflow provided a first-code
exception to the normal delivery job's successful legacy deployment-history
listing prerequisite. It never treated a legacy 404/403 or other failed read as
empty history. Normal delivery and production gates are unchanged. This section
preserves its historical safety contract, not a bootstrap dispatch procedure.
The retained `scripts/bootstrap-dev.mjs` CLI needs a fresh separately approved
operational scope and is not authorized by workflow retirement.

Any replacement procedure must establish the exact reviewed current-main source,
independently verified existing empty Worker identity, passing quality checks,
explicit first-code confirmation and exclusive target access. GitHub and hosted
runtime `PAYMENTS_ENABLED` must remain explicitly false. These prerequisites do not
authorize ordinary delivery activation, production or reuse on an initialized target.

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
version and deployment IDs are retained in the job summary before post-deployment verification.
Configuration verification requires `/health` HTTP 200 with exact service/package version;
disabled `/ready` must be HTTP 503 with exactly `ready:false`, `environment:dev`,
`network:solana-devnet`. A generic 503/NOT_CONFIGURED response is failure, not disabled
readiness. Normal delivery now also checks the status/body corresponding to its
configured payment flag; it never enables payments to make verification pass.

Any failed/timed-out deployment or incomplete readback remains uncertain even if
later checks pass. Inspect before a separately authorized recovery decision; never
rerun, retry deployment, reset D1, fabricate history or automatically roll back.
Zero-version checks reject a later dispatch once the first version exists. A first
successful bootstrap is not hosted-payment acceptance or an accepted rollback
baseline. Owner-entered provider runtime secrets (which can create deployments),
future delivery enablement and hosted acceptance remain separate approved steps.

## Compatible source selection

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
version or successful post-deployment verification is not an accepted recovery baseline.

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
automatic proof from a SHA or provider version list. Production manual dispatch,
native approval and all isolation/schema guards remain mandatory.
This policy does not authorize publication, activation, provisioning, migrations,
deployment, payment execution or data mutation. Production remains Devnet-only.

### Ongoing monitoring and recovery

Before public activation, configure alerts for API errors, pending verification age, exhausted webhook events and delivery backlog. Health/readiness alone do not certify payments. Logs may include safe request IDs/error classifications, never credentials, checkout tokens or provider payloads.

Record recoverable provider artifacts before release. Rehearse restoring the prior compatible API/frontend pair without reversing payment data; verify compatibility with current migrations. Rehearse database recovery only on an isolated non-production copy. No automatic down-migrations, database resets or payment deletion.

Exhausted webhook delivery is visible in events (`delivered_at IS NULL AND attempts >= 12`). Review the destination and consumer deduplication before a separately approved replay of exact event IDs. Never recreate settlement or rewrite the immutable payload to replay notifications.

## Shopify retirement

Preserve all unrelated/uncommitted work. Inventory reusable code and existing resource/credential consumers. Only after standalone acceptance, separately authorize disabling obsolete triggers, retiring resources, revoking unused credentials and deleting old repositories. No such actions are included in local implementation.
