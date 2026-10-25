/**
 * Environment validation and effective runtime configuration.
 * @packageDocumentation
 */

import { base58Length } from './security';
import { Config, Env, Merchant } from './types';

/** Fixed configuration-failure labels safe for diagnostics. */
type ConfigurationDiagnostic =
  | 'APP_ENV_INVALID'
  | 'CHECKOUT_ORIGIN_INVALID'
  | 'RPC_URL_INVALID'
  | 'RPC_URL_NOT_HTTPS'
  | 'RPC_URL_HAS_CREDENTIALS'
  | 'MERCHANTS_JSON_INVALID'
  | 'MERCHANT_CONFIGURATION_INVALID'
  | 'WEBHOOK_CONFIGURATION_INVALID'
  | 'PRICE_KEY_MISSING'
  | 'CHECKOUT_SECRET_TOO_SHORT'
  | 'MERCHANTS_MISSING';

/** Fixed classifications only; never retain parser errors or configuration values. */
export class ConfigurationError extends Error {
  /** Retain the fixed diagnostic code rather than the failing secret binding value.
   * @param diagnostic - Allowlisted setup failure label safe for public responses.
   */
  constructor(readonly diagnostic: ConfigurationDiagnostic) {
    super('Gateway configuration is incomplete.');
  }
}

/** Validate an absolute URL and report only its fixed configuration diagnostic.
 * @param value - Configured URL, which may be missing or contain private details.
 * @param diagnostic - Controlled label used if URL validation fails.
 * @returns The parsed absolute URL, rejecting without exposing its input.
 */
function configurationUrl(
  value: string | undefined,
  diagnostic: ConfigurationDiagnostic,
): URL {
  try {
    return new URL(value ?? '');
  } catch {
    throw new ConfigurationError(diagnostic);
  }
}

/** Validate configuration without probing dependencies. Missing setup fails closed.
 * @param env - Selected Worker's bindings and runtime configuration.
 * @returns Validated gateway settings, or a controlled configuration failure.
 */
export function config(env: Env): Config {
  if (!['local', 'dev', 'production'].includes(env.APP_ENV ?? ''))
    throw new ConfigurationError('APP_ENV_INVALID');
  const local = env.APP_ENV === 'local';
  const checkout = configurationUrl(
    env.CHECKOUT_ORIGIN,
    'CHECKOUT_ORIGIN_INVALID',
  );
  if (
    checkout.origin !== env.CHECKOUT_ORIGIN ||
    checkout.username ||
    checkout.password ||
    (local
      ? !['localhost', '127.0.0.1'].includes(checkout.hostname) ||
        checkout.protocol !== 'http:'
      : checkout.protocol !== 'https:')
  ) {
    throw new ConfigurationError('CHECKOUT_ORIGIN_INVALID');
  }
  const rpc = configurationUrl(env.SOLANA_RPC_URL, 'RPC_URL_INVALID');
  if (rpc.protocol !== 'https:')
    throw new ConfigurationError('RPC_URL_NOT_HTTPS');
  if (rpc.username || rpc.password)
    throw new ConfigurationError('RPC_URL_HAS_CREDENTIALS');
  let merchants: unknown;
  try {
    merchants = JSON.parse(env.MERCHANTS_JSON ?? '[]');
  } catch {
    throw new ConfigurationError('MERCHANTS_JSON_INVALID');
  }
  if (!Array.isArray(merchants) || merchants.length > 100)
    throw new ConfigurationError('MERCHANTS_JSON_INVALID');
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const hosts = (env.WEBHOOK_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  for (const merchant of merchants as Merchant[]) {
    if (
      !merchant ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(merchant.id) ||
      !/^[a-f0-9]{64}$/.test(merchant.apiKeyHash) ||
      base58Length(merchant.recipient) !== 32 ||
      merchant.recipient === '11111111111111111111111111111111' ||
      ids.has(merchant.id) ||
      hashes.has(merchant.apiKeyHash)
    ) {
      throw new ConfigurationError('MERCHANT_CONFIGURATION_INVALID');
    }
    ids.add(merchant.id);
    hashes.add(merchant.apiKeyHash);
    if (Boolean(merchant.webhookUrl) !== Boolean(merchant.webhookSecret))
      throw new ConfigurationError('WEBHOOK_CONFIGURATION_INVALID');
    if (merchant.webhookUrl) {
      const url = configurationUrl(
        merchant.webhookUrl,
        'WEBHOOK_CONFIGURATION_INVALID',
      );
      if (
        url.protocol !== 'https:' ||
        (url.port && url.port !== '443') ||
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
        throw new ConfigurationError('WEBHOOK_CONFIGURATION_INVALID');
      }
    }
  }
  const enabled = env.PAYMENTS_ENABLED === 'true';
  if (enabled) {
    if (!env.JUPITER_API_KEY) throw new ConfigurationError('PRICE_KEY_MISSING');
    if ((env.CHECKOUT_SECRET?.length ?? 0) < 32)
      throw new ConfigurationError('CHECKOUT_SECRET_TOO_SHORT');
    if (!merchants.length) throw new ConfigurationError('MERCHANTS_MISSING');
  }
  return {
    environment: env.APP_ENV as Config['environment'],
    enabled,
    checkoutOrigin: checkout.origin,
    checkoutSecret: env.CHECKOUT_SECRET ?? '',
    merchants: merchants as Merchant[],
    rpc: rpc.href,
    priceKey: env.JUPITER_API_KEY ?? '',
  };
}
