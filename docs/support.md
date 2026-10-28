# Gateway error logs

These logs help diagnose problems inside the gateway. They do **not** tell you
whether a payment succeeded or failed. Payment status and finalized blockchain
evidence are checked separately.

## Where to find logs

In Cloudflare, open **Workers & Pages → the intended gateway Worker → Observability
→ Logs**. Select a time range and search for the Request ID shown in the error message.

API failures use `event: api.failure` and `requestId`. Background-job failures use
`event: scheduled.failure` and `runId`. One background run can process several payments.

A Request ID is a lookup reference, not permission to view a payment. Authenticate
and check ownership before reading payment details.

## What is logged

- `INTERNAL_ERROR`: an unexpected failure while handling an API request or
  background operation.
- `CONFIGURATION_FAILED`: required API runtime settings could not be used.
- `WEBHOOK_CONFIGURATION_BLOCKED`: a webhook destination or signing configuration
  could not safely be used. Settlement is not undone.
- `SUPPORT_LOG_CHECK`: a deliberate, dev-only test error.

Records include a fixed operation name and a generated reference. Application logs
do not include credentials, checkout tokens, raw exceptions or provider payloads.
The code identifies the category, not the root cause.

## What is not logged by this feature

- Expected API errors, including ordinary rate-limit responses.
- Retryable verification-provider errors.
- Normal webhook network failures or unsuccessful HTTP responses. Webhook retry
  state stays in the database.
- Successful requests.
- Wallet-only failures or requests that never reach the backend.

Checkout displays validated API error references when available; it does not invent
one for wallet errors. Not every Request ID has a custom log entry. A missing log
does not prove that no transfer occurred. Never recommend another payment just
because a request failed. Use authorized payment-status reads and finalized-chain
checks to establish settlement.

## Access, privacy and availability

Logs are for restricted operators, not a public endpoint or merchant dashboard.
Before relying on them, verify access, collection and the complete stored event,
including fields added by Cloudflare. Application-field filtering alone does not
prove provider metadata is safe. Never export raw logs containing sensitive details.

Cloudflare documents three-day retention on Free and seven days on Paid. Check
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
for current limits and charges; these are provider defaults, not retention guarantees.

Configuration and hosted verification are separate operator procedures. Source
code, green CI and deployment success do not prove stored-log lookup or privacy.
Sampling, expiry, quotas or unavailable collection can explain missing records.
Keep credentials Sensitive; do not weaken key protection to test logging.

## Asking someone for details

Ask for the displayed Request ID, approximate time and action that failed. Never
ask for an API key, checkout URL/token, seed phrase or private key.
