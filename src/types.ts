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

export interface Merchant {
  id: string;
  apiKeyHash: string;
  recipient: string;
  webhookUrl?: string;
  webhookSecret?: string;
}

export interface Config {
  environment: "local" | "dev" | "production";
  enabled: boolean;
  checkoutOrigin: string;
  checkoutSecret: string;
  merchants: Merchant[];
  rpc: string;
  priceKey: string;
}

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

export class PublicError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
