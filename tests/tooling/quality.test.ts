/**
 * Prove typed promise checks and dependency audit thresholds remain blocking.
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { ESLint } from 'eslint';
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
