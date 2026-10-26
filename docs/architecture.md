# Crypto Gateway architecture

## Overview

Crypto Gateway lets merchants request a USD amount and receive SOL directly in their wallet. It creates a fixed quote, verifies the transfer, and records payment status.

| Component            | Role                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Merchant server      | Creates payments and queries their status using a private API key.                                |
| Checkout             | Displays the quote, requests Phantom approval, and tracks verification.                           |
| Backend Worker       | Authenticates requests, calculates quotes, verifies transactions, and delivers optional webhooks. |
| D1 database          | Stores payments, transaction candidates, notification events, and rate limits.                    |
| Jupiter / Solana RPC | Supply the SOL/USD price and blockchain evidence.                                                 |

## Payment workflow

1. **Create:** The merchant submits an amount in USD cents and a business reference. An idempotency key prevents duplicate creation when requests are repeated.
2. **Quote:** The backend calculates the required lamports, captures the merchant’s recipient address, and locks the quote for **15 minutes**.
3. **Pay:** Checkout prepares the transfer and payment-identifying memo. The customer approves in Phantom, which submits directly to Solana.
4. **Verify:** Checkout sends the transaction signature to the backend. The backend independently checks finalized execution, recipient, exact amount, memo, and transaction timing.
5. **Settle:** The backend records settlement and creates a notification event atomically. Only then does checkout show **Payment verified**.
6. **Track:** The merchant queries payment status or receives an optional signed webhook. Scheduled processing continues verification and delivery after checkout closes.

**Wallet approval is not settlement. An uncertain submission must never trigger an automatic second transfer.**

## Merchant onboarding

One gateway instance serves multiple merchants. Each merchant has an individual D1 record:

| Group                 | Fields                                                       |
| --------------------- | ------------------------------------------------------------ |
| Identity              | Stable `id`, `name`, optional `legal_name`.                  |
| Contact               | `email`, optional `phone` and `country_code`.                |
| Payment configuration | `api_key_hash`, `recipient`, optional webhook configuration. |
| Lifecycle             | `status`, `created_at`, `updated_at`.                        |

The operator-managed `npm run merchant` tool adds or updates one merchant without replacing other records. It generates a new API key when adding a merchant or rotating credentials. The merchant keeps the original key on their server; the gateway stores only its hash.

Contact details remain operator-only, excluded from checkout responses, payment events, and logs. Collecting them requires appropriate access and retention rules.

Merchant authentication reads D1 rather than `MERCHANTS_JSON`. Webhook signing secrets use authenticated AES-256-GCM encryption, bound to the merchant and environment. Encryption keys live in the separate `MERCHANT_ENCRYPTION_KEYS` runtime secret, not D1. The `merchant_audit` table records operator labels, revisions, changed-field names and timestamps, never previous values or secrets.

See [merchant onboarding](merchant-onboarding.md) for provisioning, disabling, key rotation and cutover requirements. This source implementation does not imply that hosted environments have been migrated or deployed. No existing-merchant importer is provided.

## Payment data

The database stores exact values; applications format them for display.

| Stored fields                             | Meaning                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `id`, `merchant_id`, `merchant_reference` | Payment identity, owner, and merchant’s business reference.              |
| `idempotency_key`, `request_hash`         | Detect duplicate creation requests and conflicting reuse.                |
| `usd_cents`                               | Requested USD total: `1000` means **$10.00**.                            |
| `usd_price`, `price_block_id`             | Locked **USD price per SOL** and the pricing provider’s block reference. |
| `lamports`                                | Exact SOL amount due, stored as integer text.                            |
| `recipient`                               | Merchant wallet captured when the payment was created.                   |
| `created_at`, `expires_at`                | Creation and quote-expiry times.                                         |
| `signature`, `payer`, `settled_at`        | Verified settlement evidence; empty until settlement.                    |

**1 SOL = 1,000,000,000 lamports.** For example, $10 at $100 per SOL requires 0.1 SOL, or 100,000,000 lamports.

Conversion uses integer arithmetic and rounds upward to a whole lamport. Settlement requires an exact matching transfer, so `lamports` also describes the verified amount once paid. Network fees are separate.

Supporting tables:

- **`merchants`:** private merchant profiles, API-key hashes and encrypted webhook configuration.
- **`merchant_audit`:** value-free records of merchant creation and updates.
- **`attempts`:** submitted signatures, verification results, and retry timing.
- **`events`:** settlement notifications and delivery tracking.
- **`rate_limits`:** temporary request counters.

Database and API payment timestamps use **Unix milliseconds**, which consumers can format as UTC dates. Solana block times and webhook signature timestamps use seconds.

## Payment states and recovery

Payment status is derived rather than stored in a separate column:

| Status      | Meaning                                                          |
| ----------- | ---------------------------------------------------------------- |
| `pending`   | Quote remains payable, with no pending verification candidate.   |
| `verifying` | A candidate awaits verification, potentially after quote expiry. |
| `settled`   | A matching finalized transfer has been recorded.                 |
| `expired`   | Quote expired without settlement or a pending candidate.         |

Transactions must execute within the original payment window. Verification may finish later, with automatic review available for up to **24 hours after expiry**.

Each payment accepts up to five distinct candidate signatures. Expiry, rejection, or a network error does not prove that no funds moved.

Optional webhooks retry up to **12 times** and may arrive more than once. Merchants verify signatures and deduplicate events. Notification failure does not undo settlement.

## Security and references

Merchant credentials and keyed provider URLs stay server-side. Checkout receives payment-scoped access. Merchant queries are ownership-restricted, and webhooks require approved public HTTPS destinations.

Detailed contracts and operational requirements:

- [API contract](../openapi.json)
- [Database schema](../migrations/0001_payments.sql)
- [Merchant schema](../migrations/0002_merchants.sql)
- [Transaction validation](../src/solana.ts)
- [Security limitations](SECURITY.md)
- [Delivery and recovery](delivery.md)
