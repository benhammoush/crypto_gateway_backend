# Crypto gateway — backend

A standalone, non-custodial API for payments quoted in USD and settled in native
SOL. **Solana Devnet only; no real funds.** The gateway handles payment state and
verification, not commerce orders or fulfillment.

## Tech stack and system design

| Layer                    | Tools                              |
| ------------------------ | ---------------------------------- |
| API runtime              | TypeScript, Cloudflare Workers     |
| Persistence              | Cloudflare D1 (SQLite)             |
| Pricing and verification | Jupiter Price API, Solana JSON-RPC |
| Testing                  | Vitest, Miniflare                  |

Merchant backends create payments through the HTTP API. The gateway locks a quote,
stores payment state in D1 and issues a payment-scoped checkout link. Scheduled
jobs verify submitted transaction signatures and deliver signed webhooks, so
verification continues independently of the browser.

Merchant credentials and provider keys stay server-side. Wallet submission alone
does not settle a payment: the gateway verifies finalized execution, the recipient
and the exact amount before confirming it.

The [OpenAPI contract](openapi.json) defines the endpoints;
the [payment architecture](docs/ARCHITECTURE.md) describes pricing, persistence and
verification boundaries.
