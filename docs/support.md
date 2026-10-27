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

## Hosted prerequisites (separate approval)

Source logging is not hosted acceptance. Review and enable the intended provider's
custom-log collection, restricted operator access, sampling and retention separately.
Cloudflare Workers Logs requires observability configuration; the managed delivery
configuration currently does not include it. Do not silently change live settings or
relax deployment guards. Disable automatic invocation logs before collection because
they can include request URLs; review platform exception/trace capture for sensitive
metadata too. This change adds no external log sink, dashboard, alerts or tracing.

Before relying on support lookup, accept collection and search of a synthetic safe
failure on the exact deployed candidate, including privacy, retention and access.
Sampling, expiry or unavailable collection means missing logs are inconclusive.
