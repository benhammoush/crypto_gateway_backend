# Payment boundary

The merchant decides what is owed in USD. The gateway owns the locked conversion, payment identity, recipient, verification, status and notification. The merchant owns its business objects and fulfillment. The gateway never receives private wallet keys.

## Quote

Jupiter Price API V3 wrapped-SOL market reference; native SOL is transferred on Devnet. Parse the price as decimal rational `numerator / 10^scale` and calculate:

`ceil(usdCents * 1_000_000_000 * 10^scale / (100 * numerator))`

No floating-point multiplication, browser pricing or silent repricing. Quote lifetime is 15 minutes. Fail closed on invalid/missing prices and unsafe numeric ranges. The market reference does not give Devnet SOL monetary value.

## Transaction format

Exactly two top-level instructions: native System Program transfer from the first signing payer, then SPL Memo text `crypto_gateway:<payment UUID>`. Checkout supplies the payer as the memo signer. No other instruction formats are accepted initially. Verification requires successful finalized execution, exact signature, recipient, lamports and recipient balance delta. Unsafe JSON numeric balances are rejected, not rounded.

Transaction execution time must be between request creation (second precision) and expiry. Finalization may arrive later. Candidates remain retryable for up to 24 hours after expiry; after that the customer needs manual support. This is not a claim that funds were returned or the transfer failed.

## Persistence and concurrency

- Unique `(merchant_id, idempotency_key)` plus canonical request digest.
- Unique settled transaction signature across all payments.
- Conditional settlement and deterministic outbox insertion in one atomic D1 batch.
- Durable candidate signatures; rejected attempts do not invalidate a payable request.
- At most five distinct candidates per payment to bound abuse.
- Durable payment facts: unsettled or settled. Public pending/verifying/expired states are derived from expiry and candidate state; a pre-expiry transfer may transition expired → verifying → settled when submitted later within the review window.
- Scheduler retries candidates independently of the browser. Ten candidates and ten webhook events per scheduled invocation, with request timeouts.
- Webhook delivery is at-least-once with expiring leases, twelve attempts and capped exponential backoff. A crash after receiver acknowledgment may cause redelivery. Exhausted events require operator review/replay authorization.

Frontend notifications are separate from durable state: Awaiting wallet approval → Transaction submitted → Verifying on-chain → Payment verified. Only server settlement permits the final notification.

## Threat model

Untrusted browser amount/recipient overrides are rejected. Credential classes are separate. Merchant queries are scoped; checkout tokens are HMAC-derived capabilities. Rotating CHECKOUT_SECRET invalidates all existing checkout capabilities, so coordinate rotation. API credential rotation does not alter existing quotes. Stored recipients do not change when merchant configuration changes.

Webhook destinations are trusted operator configuration, restricted to exact approved public HTTPS hostnames, no custom ports, credentials or redirects. Workers must retain `global_fetch_strictly_public`; DNS/public-network behavior needs hosted dev acceptance before activation. Do not run webhook delivery under an unrestricted alternate fetch implementation. Merchant webhook signing secrets are separate from API credentials. Changes to destination/secret affect pending deliveries and require coordinated rotation.

Worker outbound requests use `redirect: manual` and reject non-success responses; redirects are never followed. Workers does not support the Node/browser `redirect: error` value. Bundled runtime integration tests exercise pricing, verification, scheduled retries and signed webhook delivery, not just Node-level mocks.

The database contains payment references, amounts and public transaction data, not customer profiles. Do not put PII in references. Add operational retention/backup requirements before public activation; no automatic deletion policy is enabled.
