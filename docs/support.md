# Support diagnostics

## Asking for help

Ask the merchant or customer for the displayed Request ID, approximate time and
the action that failed. Never ask for API keys, checkout URLs/tokens, wallet seed
phrases or private keys. A reference is only a lookup label, never authorization
to view a payment. Authenticate and authorize any separate payment-status inquiry.

## Looking up a failure

In the intended environment's restricted operator logs, search `requestId` for an
API failure. Records contain `event: api.failure`, a fixed `operation` and `code`.
`INTERNAL_ERROR` identifies an unexpected failure in that operation;
`CONFIGURATION_FAILED` identifies unavailable runtime configuration. Neither code
proves the root cause. Use the category to investigate the affected code and
dependency without exporting raw credentials, requests or provider payloads.

Scheduled failures use `event: scheduled.failure` and an independent `runId` shared
across the invocation. Operations distinguish configuration, verification, webhook
delivery and rate-limit cleanup. `WEBHOOK_CONFIGURATION_BLOCKED` means a destination
or signing configuration could not be used; it does not mean settlement failed.
A run can process several payments; it is not linked to an individual customer.

Expected public API errors (including ordinary 429 responses), retryable verification
provider errors and webhook transport/non-success responses are not unexpected-error
logs. Webhook delivery state remains in the durable outbox. Successful requests are
not logged by this feature, so not every returned Request ID has a custom log entry.
Wallet-only failures, transport failures and requests that never reach the Worker
may have no gateway reference. Checkout shows validated API error references when
that error is displayed; it does not invent a reference for wallet errors.

Logs cannot establish settlement or absence of a transfer. Use authenticated payment
status and finalized-chain reconciliation under the applicable authorization. Never
recommend another payment merely because a request failed or a log is missing.

## Hosted collection

Collection is an explicit, separately approved dev setting in the environment's
managed `WORKER_CONFIG_JSON`, not a local Wrangler setting or dashboard override.
The delivery guard accepts only this exact optional `observability` object in dev;
production rejects it. Omit it to retain the existing configuration.

```json
{
  "enabled": true,
  "redact_query_string": true,
  "issues": { "enabled": false },
  "logs": {
    "enabled": true,
    "head_sampling_rate": 1,
    "invocation_logs": false,
    "persist": true,
    "destinations": []
  },
  "traces": { "enabled": false, "persist": false, "destinations": [] }
}
```

Automatic invocation logs, Issues, traces and external sinks remain off. Query-string
redaction adds protection against URL tokens; it does not sanitize arbitrary console
messages or uncaught platform exceptions. Inspect the complete stored event's metadata
before accepting collection; application-field allowlisting alone is insufficient.
Do not enable collection if provider enrichment exposes credentials or checkout tokens.

Use restricted Cloudflare operator access, not a public log endpoint or merchant
dashboard. Before activation, verify the actual account roles and token scopes allow
only intended operators to read logs. Never broaden deployment credentials merely to
query logs. Confirm the account plan and retention: Cloudflare documents three days
on Free and seven days on Paid, with plan-specific limits and possible usage charges.
These are provider defaults, not a configurable retention promise. See
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

## Hosted acceptance

1. Verify the exact deployed source/version and readiness; keep production and payment
   data unchanged. Serialize configuration and delivery through the existing dev pipeline.
2. With a server-side merchant credential, send one `POST /v1/support/log-check` in dev.
   This deliberately returns HTTP 500 with `SUPPORT_LOG_CHECK` and a Request ID. It
   authenticates the merchant and consumes rate-limit counters, but never creates or
   submits a payment, changes settlement, calls providers or reads the request body.
   The check is limited to once per merchant per minute, in addition to the IP budget.
   It works with dev payments disabled and is unavailable in local and production.
   Do not expose the credential in a browser.
3. In restricted stored logs, find that Request ID and verify `event: api.failure`,
   `operation: support_log_check`, `code: SUPPORT_LOG_CHECK`. Inspect complete metadata
   with synthetic canary inputs for URL/query/header/body leakage; do not export raw
   logs. This verifies collection and lookup, not a real payment or unexpected failure.
4. Retain sanitized source/provider identity, timestamp, reference, lookup, privacy,
   access and retention evidence in the release record. Missing access, ambiguous
   metadata or unavailable search leaves acceptance incomplete; do not claim success.

Source logging and green delivery alone are not hosted acceptance. Sampling, expiry,
quota exhaustion or unavailable collection means missing logs are inconclusive.
