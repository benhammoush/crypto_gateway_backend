/**
 * Prove typed promise checks and dependency audit thresholds remain blocking.
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';
import { expect, it } from 'vitest';

it('rejects unhandled promises through the real TypeScript project', async () => {
  const [result] = await new ESLint().lintText(
    '/** Quality fixture.\n * @packageDocumentation\n */\nPromise.resolve(1);',
    { filePath: 'src/security.ts' },
  );
  expect(result.fatalErrorCount).toBe(0);
  expect(result.messages.map((message) => message.ruleId)).toContain(
    '@typescript-eslint/no-floating-promises',
  );
}, 30_000);

it('keeps all advisory severities and lint warnings blocking', () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };
  expect(scripts.lint).toBe('eslint . --max-warnings 0');
  expect(scripts['audit:dependencies']).toBe(
    'npm audit && npm audit --omit=dev',
  );
  expect(scripts['ci:quality']).toBe('npm run check');
  expect(scripts.check).toContain('npm run audit:dependencies');
});

// The patched minimatch major override must not silently exclude handwritten code.
// Remove the override when all lint consumers support the patched major directly.
it('keeps lint file selection and typed rules active with the patched glob matcher', async () => {
  const eslint = new ESLint();
  for (const file of [
    'src/payments.ts',
    'tests/integration/gateway.test.ts',
    'scripts/check-delivery.mjs',
  ]) {
    expect(await eslint.isPathIgnored(file)).toBe(false);
    const config = (await eslint.calculateConfigForFile(file)) as
      Linter.Config | undefined;
    const documentation = config?.rules?.['jsdoc/require-jsdoc'];
    expect(
      Array.isArray(documentation) ? documentation[0] : documentation,
    ).toBe(2);
    if (file.endsWith('.ts')) {
      const promises =
        config?.rules?.['@typescript-eslint/no-floating-promises'];
      expect(Array.isArray(promises) ? promises[0] : promises).toBe(2);
    }
  }
  for (const file of [
    'dist/index.js',
    '.wrangler/fixture.js',
    'node_modules/fixture/index.js',
  ])
    expect(await eslint.isPathIgnored(file)).toBe(true);
}, 30_000);
