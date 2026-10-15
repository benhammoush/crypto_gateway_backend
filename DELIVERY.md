# Delivery contract

## Targets

Local → dev → production; no staging. Production remains Devnet-only. This repository currently supplies local configuration and quality CI, **not a hosted deployment workflow**. Provisioning, remote settings, merges and deployment require explicit authorization.

Each hosted target needs independent Worker, D1, merchant credentials, checkout secret, recipient wallets, webhook secrets, allowed checkout origin and scoped deployment credential. Keep runtime secrets in provider-managed storage. No implicit production fallback. Configure explicit managed target files outside source; never reuse the local binding for hosted work.

## Activation prerequisites

1. Configure protected main and strict required quality checks, administrator enforcement, no force push/deletion; maintainer diff review for solo maintenance.
2. Configure dev/production native environments restricted to main. Production requires enforceable explicit approval with admin bypass disabled. If unsupported, keep production disabled pending an approved alternative.
3. Verify provider isolation, scoped credentials and origin ownership. Disable Vercel Git auto-deploy; CI must own deployment. No hosted PR previews or cross-repository dispatch tokens.
4. Add reviewed, manually gated deployment jobs in each owning repository. Serialize per target without cancelling active migration/deployment.
5. Review runtime dependency advisories, rate limiting, webhook destination behavior, retention and backup controls. Provision monitoring/alerts separately.
6. Probe RPC genesis and bounded dependencies; apply reviewed forward-compatible migrations before API code, then deploy the compatible frontend. Readiness remains configuration-only.
7. Complete manual localhost acceptance and controlled live dev payment/failure/recovery acceptance. Fixtures and dry-run builds are insufficient.

## Compatible source selection

Each repository owns its CI/releases. Do not infer the counterpart from latest main. The frontend records an explicitly selected backend schema revision and hash. For promotion, manually record exact accepted backend/frontend SHAs, versions, provider deployment identities, migrations, configuration identity, CI evidence and previous compatible recovery identities. A local schema revision is not production evidence.

Deploy backward-compatible backend changes first. Accept the exact deployed dev pair, then promote those same source revisions through manual production gates. Shared-dev drift invalidates affected acceptance. Environment-specific builds preserve source/lockfile identity, not necessarily byte identity. Inspect both providers after partial failures.

## Monitoring and recovery

Before public activation, configure alerts for API errors, pending verification age, exhausted webhook events and delivery backlog. Health/readiness alone do not certify payments. Logs may include safe request IDs/error classifications, never credentials, checkout tokens or provider payloads.

Record recoverable provider artifacts before release. Rehearse restoring the prior compatible API/frontend pair without reversing payment data; verify compatibility with current migrations. Rehearse database recovery only on an isolated non-production copy. No automatic down-migrations, database resets or payment deletion.

Exhausted webhook delivery is visible in events (`delivered_at IS NULL AND attempts >= 12`). Review the destination and consumer deduplication before a separately approved replay of exact event IDs. Never recreate settlement or rewrite the immutable payload to replay notifications.

## Shopify retirement

Preserve all unrelated/uncommitted work. Inventory reusable code and existing resource/credential consumers. Only after standalone acceptance, separately authorize disabling obsolete triggers, retiring resources, revoking unused credentials and deleting old repositories. No such actions are included in local implementation.
