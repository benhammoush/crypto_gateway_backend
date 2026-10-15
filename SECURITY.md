# Security and release limitations

Devnet-only demonstration. No mainnet, real funds, custody, automated refunds or payment-provider certification.

Security-sensitive authentication, verification, database and webhook changes require affected tests and read-only review. Do not publish exploit details or credentials in public issues. Configure a private reporting channel before public launch.

Release blockers until independently accepted: hosted isolation and protection gates, scoped credentials, manual wallet/dev acceptance, webhook SSRF/public-network behavior, monitoring, durable backup/restore, retention requirements, dependency advisory disposition and compatible recovery evidence. Local implementation is not production acceptance.

The merchant example is public amount entry by design. Origin checks are not authentication or bot protection; configure edge abuse controls before exposing it. In real integrations the merchant backend computes the owed USD amount from trusted business data.
