/**
 * Exercise the real blocking docblock configuration on in-memory source.
 * @packageDocumentation
 */

import { beforeAll, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

// Only virtual documentation fixtures lack a TS project entry.
const eslint = new ESLint({
  overrideConfig: [
    { files: ['**/*.{ts,tsx}'], ...tseslint.configs.disableTypeChecked },
  ],
});
const header =
  '/** Fixture module.\n * @packageDocumentation\n */\nimport "fixture";\n';
// Cold parser/plugin loading belongs to bounded setup, not the per-fixture assertion budget.
beforeAll(async () => {
  await eslint.lintText(header, { filePath: 'src/documentation-fixture.ts' });
}, 30_000);
/** Collect only documentation failures, leaving unrelated fixture lint outside this assertion.
 * @param source - In-memory fixture whose documentation is under test.
 * @param filePath - Virtual path selecting the actual JS or TS rules.
 * @returns Documentation-rule identifiers, rejecting malformed or ignored fixtures.
 */
async function errors(
  source: string,
  filePath = 'src/documentation-fixture.ts',
) {
  const [result] = await eslint.lintText(source, { filePath });
  expect(result.fatalErrorCount).toBe(0);
  expect(result.messages.filter((message) => message.ruleId === null)).toEqual(
    [],
  );
  return result.messages
    .filter((message) => /^(jsdoc\/|tsdoc\/)/.test(message.ruleId ?? ''))
    .map((message) => message.ruleId);
}

it.each([
  'function helper() { return 1; }',
  'const helper = () => 1;',
  'const Component = () => null;',
  'function useResource() { return null; }',
  'class Resource {}',
  'interface Contract { value: string }',
  'type Identity = string;',
  '/** Client boundary. */ interface Client { read(): string }',
  '/** Client boundary. */ interface Client { read: () => string }',
  'const client = { read: () => "value" };',
  'const Component = memo(() => null);',
  'const Component = React.forwardRef(() => null);',
])('rejects an undocumented named contract: %s', async (source) => {
  expect(await errors(header + source)).toContain('jsdoc/require-jsdoc');
});

it('rejects malformed or ignored lint fixtures instead of silently passing', async () => {
  await expect(errors('export const broken = ;')).rejects.toThrow();
  await expect(
    errors('export {};', 'dist/documentation-fixture.ts'),
  ).rejects.toThrow();
});

it('requires a separate module overview and function description', async () => {
  expect(
    await errors('/** Read the fixture. */ function read() { return 1; }'),
  ).toContain('jsdoc/require-file-overview');
  expect(
    await errors(header + '/** */ function read() { return 1; }'),
  ).toContain('jsdoc/require-description');
});

it('requires the TypeScript package overview to be initial and unique', async () => {
  expect(
    await errors(
      'const before = 1;\n/** Fixture module.\n * @packageDocumentation\n */\nexport {};',
    ),
  ).toContain('jsdoc/require-file-overview');
  expect(
    await errors(
      '/** First overview.\n * @packageDocumentation\n */\n/** Second overview.\n * @packageDocumentation\n */\nimport "fixture";',
    ),
  ).toContain('jsdoc/require-file-overview');
});

it('accepts documented contracts and exempts ordinary anonymous callbacks', async () => {
  for (const wrapper of [
    'memo',
    'React.memo',
    'forwardRef',
    'React.forwardRef',
  ]) {
    expect(
      await errors(
        header +
          `/** Render fixture. */ export const Component = ${wrapper}(/** Render the fixture.\n * @returns The empty fixture view. */ () => null);`,
      ),
    ).toEqual([]);
    expect(
      await errors(header + `export const Component = ${wrapper}(() => null);`),
    ).toContain('jsdoc/require-jsdoc');
  }
  expect(
    await errors(
      header +
        '/** Read the fixture identity.\n * @returns The fixture identity. */ const read = () => "id";',
    ),
  ).toEqual([]);
  expect(
    await errors(
      header + '[1, 2].map((value) => value * 2); test("case", () => {});',
    ),
  ).toEqual([]);
});

it('checks supplied parameter names, descriptions and return descriptions', async () => {
  expect(
    await errors(
      header +
        '/** Read identity.\n * @param wrong - Identity.\n */ function read(value: string) { return value; }',
    ),
  ).toContain('jsdoc/check-param-names');
  expect(
    await errors(
      header +
        '/** Read identity.\n * @param value\n * @returns\n */ function read(value: string) { return value; }',
    ),
  ).toEqual(
    expect.arrayContaining([
      'jsdoc/require-param-description',
      'jsdoc/require-returns-description',
    ]),
  );
});

it('requires parameter and return tags on implementations and callable contracts', async () => {
  for (const source of [
    '/** Preserve identity. */ function read(value: string) { return value; }',
    '/** Fixture contract. */ interface Fixture { /** Preserve identity. */ read(value: string): string; }',
    '/** Fixture contract. */ interface Fixture { /** Preserve identity. */ read: (value: string) => string; }',
  ]) {
    expect(await errors(header + source)).toEqual(
      expect.arrayContaining(['jsdoc/require-param', 'jsdoc/require-returns']),
    );
  }
});

it('rejects malformed TSDoc and duplicated TypeScript types', async () => {
  expect(
    await errors(
      header +
        '/** Read identity.\n * @notAStandardTag\n */ function read() { return 1; }',
    ),
  ).toContain('tsdoc/syntax');
  expect(
    await errors(
      header +
        '/** Read identity.\n * @param {string} value - Identity.\n */ function read(value: string) { return value; }',
    ),
  ).toContain('jsdoc/no-types');
});

it('parses typed TSX before applying documentation rules', async () => {
  const filePath = 'src/documentation-fixture.tsx';
  const [result] = await eslint.lintText(
    header +
      '/** Heading properties. */ interface Props { label: string }\n/** Render fixture.\n * @param props - Heading properties.\n * @returns The fixture heading. */ const Component = (props: Props) => <div>{props.label}</div>;',
    { filePath },
  );
  expect(result.fatalErrorCount).toBe(0);
  expect(
    result.messages.filter((message) =>
      /^(jsdoc\/|tsdoc\/)/.test(message.ruleId ?? ''),
    ),
  ).toEqual([]);
  expect(
    await errors(
      header +
        'const Component = (props: { label: string }) => <div>{props.label}</div>;',
      filePath,
    ),
  ).toContain('jsdoc/require-jsdoc');
});

it('requires JavaScript module and named-helper documentation', async () => {
  expect(
    await errors(
      'const read = () => "id";',
      'scripts/documentation-fixture.mjs',
    ),
  ).toEqual(
    expect.arrayContaining([
      'jsdoc/require-file-overview',
      'jsdoc/require-jsdoc',
    ]),
  );
  expect(
    await errors(
      '/** Fixture tooling.\n * @file\n */\nimport "fixture";\n/** Read fixture identity.\n * @returns The fixture identity. */ const read = () => "id";',
      'scripts/documentation-fixture.mjs',
    ),
  ).toEqual([]);
});

it('excludes generated Worker output without excluding handwritten tests', async () => {
  expect(await eslint.isPathIgnored('.wrangler/documentation-fixture.ts')).toBe(
    true,
  );
  expect(
    await errors(
      header + 'const helper = () => 1;',
      'tests/unit/documentation-fixture.test.ts',
    ),
  ).toContain('jsdoc/require-jsdoc');
});
