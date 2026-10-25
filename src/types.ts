/**
 * Shared payment, configuration and public-error contracts.
 * @packageDocumentation
 */

/** Worker bindings; provider credentials remain server-side. */
export interface Env {
  DB: D1Database;
  APP_ENV?: string;
  PAYMENTS_ENABLED?: string;
  CHECKOUT_ORIGIN?: string;
  CHECKOUT_SECRET?: string;
  MERCHANTS_JSON?: string;
  SOLANA_RPC_URL?: string;
  JUPITER_API_KEY?: string;
  WEBHOOK_HOSTS?: string;
}

/** Persisted merchant identity and settlement configuration. */
export interface Merchant {
  id: string;
  apiKeyHash: string;
  recipient: string;
  webhookUrl?: string;
  webhookSecret?: string;
}

/** Validated gateway configuration used by request and scheduled handlers. */
export interface Config {
  environment: "local" | "dev" | "production";
  enabled: boolean;
  checkoutOrigin: string;
  checkoutSecret: string;
  merchants: Merchant[];
  rpc: string;
  priceKey: string;
}

/** Persisted payment including integer-cent and exact lamport quote fields. */
export interface Payment {
  id: string;
  merchant_id: string;
  merchant_reference: string;
  idempotency_key: string;
  request_hash: string;
  usd_cents: number;
  lamports: string;
  usd_price: string;
  price_block_id: number;
  recipient: string;
  created_at: number;
  expires_at: number;
  signature: string | null;
  payer: string | null;
  settled_at: number | null;
}

/** Controlled gateway failure safe to serialize to a public response. */
export class PublicError extends Error {
  /** Retain the public error code, message and HTTP status for the response boundary.
   * @param code - Stable public gateway error code.
   * @param message - Controlled explanation safe for the caller.
   * @param status - HTTP status, defaulting to a rejected client request.
   */
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
