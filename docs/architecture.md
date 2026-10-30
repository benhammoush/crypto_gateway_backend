# How the gateway works

Crypto Gateway lets a merchant request an amount in USD and receive SOL directly
in its wallet. The gateway quotes the SOL amount, checks the transfer and records
the result. It does not hold customer funds.

## Main parts

- **Merchant server:** creates payments and reads their status using its private API key.
- **Checkout:** displays the quote, opens Phantom and tracks verification.
- **Cloudflare Worker:** authenticates requests, calculates quotes, verifies transfers
  and sends optional webhooks.
- **D1:** stores merchants, payments, verification attempts, webhook events and rate limits.
- **Jupiter and Solana RPC:** provide the SOL price and blockchain evidence.

## Payment flow

1. The merchant sends integer USD cents, a business reference and an idempotency key.
   The key prevents duplicate creation; conflicting reuse is rejected.
2. The backend calculates the lamports due and captures the recipient address.
   The quote lasts **15 minutes**.
3. Checkout prepares the transfer and identifying memo. The customer approves in
   Phantom, which submits to Solana.
4. Checkout sends the signature to the backend. The backend checks finalized
   execution, recipient, exact amount, memo and transaction timing.
5. Settlement and its notification event are saved together. Only then may checkout
   display **Payment verified**.
6. The merchant polls payment status or receives an optional signed webhook.
   Background jobs continue verification and delivery after checkout closes.

**Wallet approval is not settlement. An uncertain submission must never cause an
automatic second transfer.**

## Amounts and times

Before creation, checkout may display the public `/v1/price` SOL/USD reference.
It uses the same validated provider reader as payment creation, but does not create
or change payments. Its `fetchedAt` is gateway retrieval time, not a guarantee of
the provider's market-update time. The endpoint is no-store, payments-enabled only,
and bounded to six requests per IP and sixty globally per minute. Creation always
fetches its own quote; reference reads cannot change an existing locked quote.

- USD amounts use integer cents: `1000` means $10.00.
- SOL amounts use integer lamports, stored as text:
  **1 SOL = 1,000,000,000 lamports**.
- Conversion uses integer arithmetic and rounds upward to the next whole lamport.
  Network fees are separate. Settlement requires the exact quoted transfer amount.
- Database and API timestamps use Unix milliseconds. Solana block times and webhook
  signature timestamps use seconds.

For example, $10 at $100 per SOL requires 0.1 SOL: 100,000,000 lamports.

## Stored data

Each payment keeps its ID, merchant ID, business reference, idempotency key, request
hash, USD cents, quoted SOL price and pricing block, lamports, original recipient,
creation/expiry times and verified settlement evidence. Signature, payer and settlement
time remain empty until settlement.

Supporting tables:

- `merchants`: private profiles, API-key hashes and encrypted webhook configuration.
- `merchant_audit`: revisions, operator labels, timestamps and changed-field names,
  not values.
- `attempts`: submitted signatures, verification results and retry timing.
- `events`: settlement notifications and delivery tracking.
- `rate_limits`: temporary request counters.

## Merchant accounts

One instance can serve several merchants. Each has a stable ID, name, recipient,
API-key hash and lifecycle metadata. Legal name, contact details and webhook
settings are optional.

The operator tool manages one merchant at a time. New API keys are shown once; only
their hashes are stored in D1. Contact details stay out of checkout responses, logs
and webhook payloads.

Authentication reads D1, not `MERCHANTS_JSON`. Webhook signing secrets use
AES-256-GCM encryption bound to the merchant and environment. Encryption keys stay
outside D1 in `MERCHANT_ENCRYPTION_KEYS`. No existing-merchant importer is provided.

See [merchant onboarding](merchant-onboarding.md) for setup, disabling, rotation and
migration requirements. Documentation of these features is not proof that a hosted
environment has been migrated or accepted.

## Payment states

Status is derived from the payment and its attempts:

- `pending`: the quote is payable and no candidate awaits verification.
- `verifying`: a candidate awaits verification, possibly after quote expiry.
- `settled`: a matching finalized transfer was recorded.
- `expired`: the quote expired without settlement or a pending candidate.

A transaction must execute within the original quote window. Verification may finish
later; automatic review is available for up to **24 hours after expiry**. Each payment
accepts at most **five distinct candidate signatures**.

Expiry, rejection or a network error does not prove that no funds moved.

## Webhooks

Webhooks are optional. Delivery makes at most **12 attempts total**, including the
initial attempt, and can produce
duplicates. Receivers must verify signatures and deduplicate events. A notification
failure does not undo settlement.

## Contracts and safety

Merchant credentials and keyed provider URLs stay server-side. Checkout uses
payment-scoped access; merchant reads require ownership. Webhooks require approved
public HTTPS destinations.

- [API contract](../openapi.json)
- [Transaction validation](../src/solana.ts)
- [Payment schema](../migrations/0001_payments.sql)
- [Merchant schema](../migrations/0002_merchants.sql)
- [Security rules](SECURITY.md)
- [Gateway error logs](support.md)
