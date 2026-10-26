/** Native Node operator entry-point safety; no database or provider mutation is permitted.
 * @packageDocumentation
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each([
  { args: [] },
  {
    args: [
      '--environment',
      'dev',
      '--account',
      'invalid',
      '--database',
      'invalid',
    ],
  },
  { args: ['--environment', 'local', '--account', 'a'.repeat(32)] },
  { args: ['--environment', 'production'] },
])(
  'fails closed in the native Node entry point for incomplete or mixed targets: %j',
  ({ args }) => {
    const secret = 'synthetic_private_input_123456789012345';
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-transform-types',
        resolve('scripts/merchant.ts'),
        ...args,
      ],
      {
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
        input: JSON.stringify({ webhook_secret: secret }),
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Merchant operation failed or is uncertain.',
    );
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(secret);
  },
);
