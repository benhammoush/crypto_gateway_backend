# Security rules and limitations

This is a **Devnet-only demonstration**. It does not support mainnet, real funds,
custody, automatic refunds or payment-provider certification. Production hosting
does not change that limit.

## Credentials and merchant data

- Store merchant API-key hashes in D1, not original keys.
- Store webhook signing secrets as AES-GCM ciphertext. Keep the encryption keyring
  outside D1.
- Keep optional merchant contact details private. Do not include them in checkout
  responses, webhook payloads or logs.
- The merchant operator tool has no public administration route. It displays new
  API keys once and requires private handling. Hosted mutations need separate
  authorization.

See [merchant onboarding](merchant-onboarding.md) for rotation, recovery limits,
audit limitations and the effects of disabling a merchant.

## Public demo and diagnostics

The demo accepts public amount entry; it is not an authenticated merchant dashboard.
Origin checks do not stop bots. Configure abuse controls before exposing it. In a
real integration, the merchant server calculates the amount from trusted business data.

When dev `GET /ready` fails configuration checks, it may return a fixed
`error.diagnostic` category. It must not include secret values, URLs, parser errors
or provider responses. Local, production and payment-route configuration errors
remain generic. Readiness does not call RPC providers or prove payments work.

[Gateway error logs](support.md) have separate coverage and privacy requirements.
A gateway error is not proof that a payment failed.

## Checks required before release

Independently verify environment isolation, protection/approval gates, credential
scope, wallet payment behavior, webhook destination safety, operational logs,
retention, backups, isolated restore and compatible recovery artifacts. Review
dependency advisories. Local tests and deployment success do not replace hosted acceptance.

Authentication, transaction verification, database and webhook changes require
relevant tests and independent read-only review.

## Reporting security problems

Do not publish credentials or exploit details in public issues. Set up a private
reporting channel before public launch.
