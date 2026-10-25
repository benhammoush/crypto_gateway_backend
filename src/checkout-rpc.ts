/**
 * Authenticated, allowlisted checkout RPC forwarding without exposing provider credentials.
 * @packageDocumentation
 */

import { base58Length, jsonBody } from './security';
import { DEVNET_GENESIS } from './solana';
import { Payment, PublicError } from './types';

/** Forward only bounded, read-only wallet preparation calls to operator configuration.
 * @param url - Operator-configured RPC endpoint, never a browser-supplied URL.
 * @param payment - Authenticated payment whose expiry and submission state gate preparation.
 * @param input - Untrusted JSON-RPC request to validate against the read-only allowlist.
 * @returns A sanitized JSON-RPC result using the caller's request identifier.
 */
export async function checkoutRpc(
  url: string,
  payment: Payment,
  input: Record<string, unknown>,
) {
  if (payment.signature || Date.now() >= payment.expires_at)
    throw new PublicError(
      'NOT_PAYABLE',
      'This payment is not currently payable.',
      409,
    );
  const { id, method, params } = input;
  const option: unknown = Array.isArray(params) ? params[0] : undefined;
  if (
    Object.keys(input).some(
      (key) => !['jsonrpc', 'id', 'method', 'params'].includes(key),
    ) ||
    input.jsonrpc !== '2.0' ||
    !(
      (typeof id === 'string' && id.length > 0 && id.length <= 64) ||
      (typeof id === 'number' && Number.isSafeInteger(id))
    ) ||
    !Array.isArray(params) ||
    !(
      (method === 'getGenesisHash' && params.length === 0) ||
      (method === 'getLatestBlockhash' &&
        params.length === 1 &&
        option &&
        typeof option === 'object' &&
        !Array.isArray(option) &&
        Object.keys(option).length === 1 &&
        'commitment' in option &&
        option.commitment === 'finalized')
    )
  )
    throw new PublicError(
      'INVALID_RPC_REQUEST',
      'Use an approved wallet preparation RPC call.',
    );

  let result: unknown;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const body = await jsonBody(response);
    if (body.error || body.jsonrpc !== '2.0' || body.id !== 1)
      throw new Error();
    if (method === 'getGenesisHash') {
      if (body.result !== DEVNET_GENESIS) throw new Error();
      result = DEVNET_GENESIS;
    } else {
      const value = body.result as {
        context?: { slot?: unknown };
        value?: { blockhash?: unknown; lastValidBlockHeight?: unknown };
      } | null;
      const slot = value?.context?.slot;
      const blockhash = value?.value?.blockhash;
      const height = value?.value?.lastValidBlockHeight;
      if (
        typeof slot !== 'number' ||
        !Number.isSafeInteger(slot) ||
        slot < 0 ||
        typeof blockhash !== 'string' ||
        base58Length(blockhash) !== 32 ||
        typeof height !== 'number' ||
        !Number.isSafeInteger(height) ||
        height < 1
      )
        throw new Error();
      result = {
        context: { slot },
        value: { blockhash, lastValidBlockHeight: height },
      };
    }
  } catch {
    // Do not reflect provider bodies, URLs, headers or error messages containing keys.
    throw new PublicError(
      'RPC_UNAVAILABLE',
      'Solana verification is temporarily unavailable.',
      503,
    );
  }
  return { jsonrpc: '2.0', id, result };
}
