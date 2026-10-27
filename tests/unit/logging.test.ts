/** Failure boundaries retain safe references without serializing private exceptions.
 * @packageDocumentation
 */
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { config } from '../../src/config';
import { retryVerification } from '../../src/payments';
import { deliverWebhooks } from '../../src/webhooks';
import { Config, Env, PublicError } from '../../src/types';

vi.mock('../../src/config', async (original) => ({
  ...(await original<typeof import('../../src/config')>()),
  config: vi.fn(),
}));
vi.mock('../../src/payments', async (original) => ({
  ...(await original<typeof import('../../src/payments')>()),
  retryVerification: vi.fn(),
}));
vi.mock('../../src/webhooks', async (original) => ({
  ...(await original<typeof import('../../src/webhooks')>()),
  deliverWebhooks: vi.fn(),
}));

const settings: Config = {
  environment: 'local',
  enabled: true,
  checkoutOrigin: 'http://localhost:5173',
  checkoutSecret: 'fixture',
  webhookHosts: [],
  rpc: 'https://rpc.example.org',
  priceKey: 'fixture',
};
const secret = 'private-provider-payload-fixture';

/** Supply the complete binding shape while exercising only prepared operations.
 * @param prepare - Test-controlled statement factory.
 * @returns A database double with unused methods mocked.
 */
function database(prepare: D1Database['prepare']): D1Database {
  return {
    prepare,
    batch: vi.fn(),
    exec: vi.fn(),
    withSession: vi.fn(),
    dump: vi.fn(),
  };
}

afterEach(() => vi.restoreAllMocks());

it('correlates one sanitized API failure and ignores supplied request IDs', async () => {
  vi.mocked(config).mockReturnValue(settings);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const env: Env = {
    DB: database(() => {
      throw new Error(secret);
    }),
  };
  const response = await worker.fetch(
    new Request('http://localhost/v1/payments?secret=fixture', {
      headers: { 'x-request-id': secret, authorization: `Bearer ${secret}` },
    }),
    env,
  );
  expect(response.status).toBe(500);
  expect(log).toHaveBeenCalledExactlyOnceWith({
    event: 'api.failure',
    requestId: response.headers.get('x-request-id'),
    operation: 'rate_limit',
    code: 'INTERNAL_ERROR',
  });
  expect(
    JSON.stringify(log.mock.calls) + (await response.text()),
  ).not.toContain(secret);
});

it('does not log ordinary rate-limit rejections as unexpected failures', async () => {
  vi.mocked(config).mockReturnValue(settings);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const env: Env = {
    DB: database(() => {
      throw new PublicError('RATE_LIMITED', 'Too many requests.', 429);
    }),
  };
  const response = await worker.fetch(
    new Request('http://localhost/v1/payments'),
    env,
  );
  expect(response.status).toBe(429);
  expect(log).not.toHaveBeenCalled();
});

it('shares a scheduled run reference and never rethrows private exception text', async () => {
  vi.mocked(config).mockReturnValue(settings);
  vi.mocked(retryVerification).mockResolvedValue();
  vi.mocked(deliverWebhooks).mockRejectedValue(new Error(secret));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(
    worker.scheduled({} as ScheduledEvent, { DB: {} as D1Database }),
  ).rejects.toThrow('Scheduled gateway processing failed.');
  const runId = vi.mocked(retryVerification).mock.calls.at(-1)?.[2];
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  expect(vi.mocked(deliverWebhooks).mock.calls.at(-1)?.[2]).toBe(runId);
  expect(log).toHaveBeenCalledExactlyOnceWith({
    event: 'scheduled.failure',
    runId,
    operation: 'webhook_delivery',
    code: 'INTERNAL_ERROR',
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
});

it.each([
  ['unexpected', new Error(secret), true],
  [
    'transient provider',
    new PublicError('RPC_UNAVAILABLE', 'Temporarily unavailable.', 503),
    false,
  ],
])(
  'preserves durable per-candidate retry behavior for %s failures',
  async (_name, error, logged) => {
    const { retryVerification: retry } =
      await vi.importActual<typeof import('../../src/payments')>(
        '../../src/payments',
      );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prepare = vi
      .fn()
      .mockReturnValueOnce({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: [
              { payment_id: secret, signature: secret },
              { payment_id: secret, signature: secret },
            ],
          }),
        }),
      })
      .mockImplementation(() => {
        throw error;
      });
    await expect(
      retry(database(prepare), settings, 'fixture-run'),
    ).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(logged ? 2 : 0);
    if (logged)
      expect(log).toHaveBeenCalledWith({
        event: 'scheduled.failure',
        runId: 'fixture-run',
        operation: 'verification',
        code: 'INTERNAL_ERROR',
      });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  },
);

it('logs configuration errors once without exposing the original error', async () => {
  vi.mocked(config).mockImplementation(() => {
    throw new Error(secret);
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await worker.fetch(new Request('http://localhost/ready'), {
    DB: {} as D1Database,
  });
  expect(response.status).toBe(503);
  expect(log).toHaveBeenCalledExactlyOnceWith({
    event: 'api.failure',
    requestId: response.headers.get('x-request-id'),
    operation: 'configuration',
    code: 'CONFIGURATION_FAILED',
  });
  expect(
    JSON.stringify(log.mock.calls) + (await response.text()),
  ).not.toContain(secret);
});

it('does not log a disabled scheduled invocation', async () => {
  vi.mocked(config).mockReturnValue({ ...settings, enabled: false });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await worker.scheduled({} as ScheduledEvent, { DB: {} as D1Database });
  expect(log).not.toHaveBeenCalled();
});
