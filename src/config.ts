/**
 * Environment validation and effective runtime configuration.
 * @packageDocumentation
 */

import { merchantKeyring } from './merchant-crypto';
import { webhookHosts } from './merchants';
import { Config, Env } from './types';

/** Fixed configuration-failure labels safe for diagnostics. */
type ConfigurationDiagnostic =
  | 'APP_ENV_INVALID'
  | 'CHECKOUT_ORIGIN_INVALID'
  | 'RPC_URL_INVALID'
  | 'RPC_URL_NOT_HTTPS'
  | 'RPC_URL_HAS_CREDENTIALS'
  | 'MERCHANT_ENCRYPTION_KEYS_INVALID'
  | 'PRICE_KEY_MISSING'
  | 'CHECKOUT_SECRET_TOO_SHORT';

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
  let merchantKeys: Config['merchantKeys'];
  if (env.MERCHANT_ENCRYPTION_KEYS) {
    try {
      merchantKeys = merchantKeyring(env.MERCHANT_ENCRYPTION_KEYS);
    } catch {
      throw new ConfigurationError('MERCHANT_ENCRYPTION_KEYS_INVALID');
    }
  }
  const enabled = env.PAYMENTS_ENABLED === 'true';
  if (enabled) {
    if (!env.JUPITER_API_KEY) throw new ConfigurationError('PRICE_KEY_MISSING');
    if ((env.CHECKOUT_SECRET?.length ?? 0) < 32)
      throw new ConfigurationError('CHECKOUT_SECRET_TOO_SHORT');
  }
  return {
    environment: env.APP_ENV as Config['environment'],
    enabled,
    checkoutOrigin: checkout.origin,
    checkoutSecret: env.CHECKOUT_SECRET ?? '',
    webhookHosts: webhookHosts(env.WEBHOOK_HOSTS),
    merchantKeys,
    rpc: rpc.href,
    priceKey: env.JUPITER_API_KEY ?? '',
  };
}
