# crypto_gateway_backend

Standalone, non-custodial USD-to-SOL payment API. **Solana Devnet only; no real funds.** No commerce platform, orders, taxes, custody or fulfillment.

## Local setup

Requires Node 24 and npm. No Cloudflare login is required for local development.

1. `npm ci`
2. Copy `.dev.vars.example` to `.dev.vars` (ignored).
3. Generate your own high-entropy merchant credential and checkout secret (at least 32 characters). Supply the merchant credential through stdin to `npm run credential:hash`; never place it in CLI arguments. Configure `MERCHANTS_JSON` with the digest, merchant ID and a dedicated Devnet recipient public key. Never supply a wallet private key.
4. Supply a Jupiter API key and checkout secret. Set `PAYMENTS_ENABLED=true` only when prerequisites are configured.
5. `npm run db:local` applies migrations to local-only persistence.
6. `npm run dev` serves `http://localhost:8787` with local scheduled-event support.
7. In another terminal, run `npm run dev:scheduler`. Wrangler does not automatically fire Cron Triggers locally; this loopback-only driver invokes the scheduled handler every fifteen seconds for durable verification and webhook retries. Keep it running during local payment acceptance, even after closing checkout.
8. Run the sibling frontend and its server-side example adapter using its README.

The committed configuration is local-only and disabled by default. Do not deploy it. Tests use isolated persistence and provider fixtures; there is no runtime fixture mode that can accidentally certify payments.

## API

`openapi.json` is the public v1 contract. All amounts supplied by merchants are integer USD cents (1–1000000); SOL amounts are decimal strings of integer lamports. Responses use `{ data, meta: { requestId } }` or `{ error: { code, message, requestId } }`, except successful checkout RPC calls, which return JSON-RPC 2.0 results.

| Endpoint                             | Authorization                                             |
| ------------------------------------ | --------------------------------------------------------- |
| `POST /v1/payments`                  | Merchant bearer + `Idempotency-Key`                       |
| `GET /v1/payments/:id`               | Owning merchant bearer                                    |
| `GET /v1/checkout/:id`               | Payment-scoped checkout bearer                            |
| `POST /v1/checkout/:id/transactions` | Checkout bearer; `{ "signature": "..." }`                 |
| `POST /v1/checkout/:id/rpc`          | Checkout bearer; bounded read-only wallet preparation RPC |
| `GET /health`                        | Public liveness/version                                   |
| `GET /ready`                         | Public configuration readiness, not provider availability |

Creation body: `{ "usdCents": 1000, "merchantReference": "invoice-123" }`. Use an opaque reference, never customer PII. Recipients and webhook destinations are operator-managed. The first version has no arbitrary return URL; the checkout shows the result directly.

Merchant credentials stay on the integrating backend. The browser receives only the checkout capability. Idempotent retries return the original payment/quote/checkout link; changing the payload with the same key is a conflict. Merchant fulfillment must use authoritative status or authenticated webhooks, never a redirect.

## Checkout RPC

Set `SOLANA_RPC_URL` in server-only configuration (for example the Helius Devnet endpoint with a dedicated dev key). Never put the keyed URL in public/VITE configuration. Keep prod credentials separate and unused during local acceptance. Keys within one Helius project share quotas; local tests must not change Iris credentials or restrictions.

The authenticated RPC route accepts only JSON-RPC `getGenesisHash` with `[]` and `getLatestBlockhash` with `[{"commitment":"finalized"}]`, while the payment is unexpired and unsettled. No batches, notifications, transaction writes, caller-selected URLs or arbitrary parameters. Limits: 12 requests/checkout/minute and 60 globally/minute, plus the existing checkout/IP limits. Request and provider bodies are bounded to 4096 bytes; upstream requests have an eight-second timeout and do not follow redirects. Only validated result fields are returned; errors never reflect provider responses or credentials. Shared provider quotas can still be exhausted; configure edge abuse controls before hosting. The legacy `rpcUrl` payment field remains a public, unkeyed Devnet URL for older clients and is deprecated.

## Checks

- `npm run check`: lint, formatting, types, deterministic tests and Worker dry-run build.
- `npm audit --audit-level=high`: dependency security gate; lower severities still require review.
- Hosted dev and manual browser/wallet acceptance are separate; fixtures cannot establish them.

See [architecture](docs/ARCHITECTURE.md), [delivery](DELIVERY.md), [security](SECURITY.md) and [board design](docs/BOARD.md).
