import { base58Length } from "./security";
import { Config, Env, Merchant } from "./types";

/** Validate configuration without probing dependencies. Missing setup fails closed. */
export function config(env: Env): Config {
  if (!["local", "dev", "production"].includes(env.APP_ENV ?? ""))
    throw new Error("Invalid APP_ENV.");
  const local = env.APP_ENV === "local";
  const checkout = new URL(env.CHECKOUT_ORIGIN ?? "");
  if (
    checkout.origin !== env.CHECKOUT_ORIGIN ||
    checkout.username ||
    checkout.password ||
    (local
      ? !["localhost", "127.0.0.1"].includes(checkout.hostname) ||
        checkout.protocol !== "http:"
      : checkout.protocol !== "https:")
  ) {
    throw new Error("Invalid checkout origin.");
  }
  const rpc = new URL(env.SOLANA_RPC_URL ?? "");
  if (rpc.protocol !== "https:" || rpc.username || rpc.password)
    throw new Error("Invalid RPC URL.");
  const merchants: unknown = JSON.parse(env.MERCHANTS_JSON ?? "[]");
  if (!Array.isArray(merchants) || merchants.length > 100)
    throw new Error("Invalid merchants.");
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const hosts = (env.WEBHOOK_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  for (const merchant of merchants as Merchant[]) {
    if (
      !merchant ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(merchant.id) ||
      !/^[a-f0-9]{64}$/.test(merchant.apiKeyHash) ||
      base58Length(merchant.recipient) !== 32 ||
      merchant.recipient === "11111111111111111111111111111111" ||
      ids.has(merchant.id) ||
      hashes.has(merchant.apiKeyHash)
    ) {
      throw new Error("Invalid merchant configuration.");
    }
    ids.add(merchant.id);
    hashes.add(merchant.apiKeyHash);
    if (Boolean(merchant.webhookUrl) !== Boolean(merchant.webhookSecret))
      throw new Error("Incomplete webhook configuration.");
    if (merchant.webhookUrl) {
      const url = new URL(merchant.webhookUrl);
      if (
        url.protocol !== "https:" ||
        (url.port && url.port !== "443") ||
        url.username ||
        url.password ||
        url.hash ||
        !hosts.includes(url.hostname) ||
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(
          url.hostname,
        ) ||
        /^[\d.]+$/.test(url.hostname) ||
        (merchant.webhookSecret?.length ?? 0) < 32
      ) {
        throw new Error("Invalid webhook destination.");
      }
    }
  }
  const enabled = env.PAYMENTS_ENABLED === "true";
  if (
    enabled &&
    (!env.JUPITER_API_KEY ||
      (env.CHECKOUT_SECRET?.length ?? 0) < 32 ||
      !merchants.length)
  ) {
    throw new Error("Payment configuration is incomplete.");
  }
  return {
    environment: env.APP_ENV as Config["environment"],
    enabled,
    checkoutOrigin: checkout.origin,
    checkoutSecret: env.CHECKOUT_SECRET ?? "",
    merchants: merchants as Merchant[],
    rpc: rpc.href,
    priceKey: env.JUPITER_API_KEY ?? "",
  };
}
