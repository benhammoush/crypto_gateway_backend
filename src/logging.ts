/** Allowlisted support diagnostics without exception or request serialization.
 * @packageDocumentation
 */

/** Operations selected by gateway code, never derived from raw request URLs. */
export type Operation =
  | 'configuration'
  | 'support_log_check'
  | 'rate_limit'
  | 'merchant_authentication'
  | 'payment_create'
  | 'payment_read'
  | 'checkout_read'
  | 'checkout_rpc'
  | 'transaction_submit'
  | 'verification'
  | 'webhook_delivery'
  | 'rate_limit_cleanup';

/** Emit only internally selected support fields, never the original exception.
 * @param scope - HTTP request or scheduled invocation.
 * @param id - Internally generated opaque reference.
 * @param operation - Fixed operation category.
 * @param code - Allowlisted failure classification.
 */
export function logFailure(
  scope: 'api' | 'scheduled',
  id: string,
  operation: Operation,
  code:
    | 'INTERNAL_ERROR'
    | 'CONFIGURATION_FAILED'
    | 'SUPPORT_LOG_CHECK'
    | 'WEBHOOK_CONFIGURATION_BLOCKED' = 'INTERNAL_ERROR',
): void {
  console.error({
    event: `${scope}.failure`,
    ...(scope === 'api' ? { requestId: id } : { runId: id }),
    operation,
    code,
  });
}
