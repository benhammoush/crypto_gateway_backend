# Security and release limitations

Devnet-only demonstration. No mainnet, real funds, custody, automated refunds or payment-provider certification.

Security-sensitive authentication, verification, database and webhook changes require affected tests and read-only review. Do not publish exploit details or credentials in public issues. Configure a private reporting channel before public launch.

Release blockers until independently accepted: hosted isolation and protection gates, scoped credentials, manual wallet/dev acceptance, webhook SSRF/public-network behavior, monitoring, durable backup/restore, retention requirements, dependency advisory disposition and compatible recovery evidence. Local implementation is not production acceptance.

Merchant profiles are operator-private D1 data. Authentication stores API-key hashes;
webhook signing secrets are AES-GCM ciphertext with a separate runtime keyring.
Contact fields are optional personal data and must not enter checkout responses,
webhooks or logs. The operator CLI has no public route, prints newly generated API
keys once, and needs private terminal handling and separate hosted mutation approval.
See [merchant onboarding](merchant-onboarding.md) for key recovery, rotation, audit
limitations, disabling semantics and cutover prerequisites.

The merchant example is public amount entry by design. Origin checks are not authentication or bot protection; configure edge abuse controls before exposing it. In real integrations the merchant backend computes the owed USD amount from trusted business data.

Dev-only `GET /ready` configuration failures include a fixed `error.diagnostic` classification. This public diagnostic reveals which configuration rule failed, but never includes secret values, URLs, parser exceptions or provider responses. Production, local and payment-route error envelopes stay generic. Readiness does not contact RPC providers or prove payment acceptance.
