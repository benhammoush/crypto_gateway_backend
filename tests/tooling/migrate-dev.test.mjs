/** Dev migration authorization, schema evidence and execution-boundary regressions.
 * @file
 */

import { expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import {
  APPROVED_DIGEST,
  APPROVED_MIGRATION,
  migrateDev,
  migrationArguments,
  migrationConfig,
  runMigrationCommand,
} from '../../scripts/migrate-dev.mjs';
import { migrationDigest } from '../../scripts/check-delivery.mjs';

// Historical first-schema behavior is exercised against its original catalog, not today's migrations.
const catalog = vi.hoisted(() => ({ historical: true }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    /** Select the historical fixture catalog without changing the production guard.
     * @param directory - Directory being inspected.
     * @returns Original first migration for historical tests; real files otherwise.
     */
    readdirSync(directory) {
      const files = actual.readdirSync(directory);
      return catalog.historical && directory === 'migrations'
        ? files.filter((name) => name === '0001_payments.sql')
        : files;
    },
  };
});

it('rejects the current multi-migration catalog before inspection or mutation', async () => {
  catalog.historical = false;
  const inspect = vi.fn();
  const execute = vi.fn();
  try {
    await expect(
      migrateDev(environment(), { inspect, execute }),
    ).rejects.toThrow('ONLY_REVIEWED_FIRST_MIGRATION_ALLOWED');
    expect(inspect).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  } finally {
    catalog.historical = true;
  }
});

/** Synthetic scope only; the injected executor never invokes Wrangler or providers.
 * @returns Explicit dev migration scope with synthetic identities only.
 */
function environment() {
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: 'a'.repeat(40),
    EXPECTED_SOURCE_SHA: 'a'.repeat(40),
    CONFIRM_FIRST_DEV_MIGRATION: 'true',
    PAYMENTS_ENABLED: 'false',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
    OTHER_D1_DATABASE_ID: '22222222-2222-4222-8222-222222222222',
    CLOUDFLARE_API_TOKEN: 'synthetic-write-secret',
  };
}

/** Schema observations mirror the separate inspector's fixed sanitized results.
 * @returns Controlled pre-migration schema evidence.
 */
function before() {
  return {
    sourceSha: environment().GITHUB_SHA,
    databaseIdentityMatched: true,
    expectedMigrationSetDigest: APPROVED_DIGEST,
    schemaState: 'application-schema-absent',
    migrationTablePresent: false,
    observedApplicationObjectCount: 0,
    recordedExpectedMigrations: [],
    schemaAttestationRecorded: false,
  };
}
/** Build the expected post-migration schema evidence.
 * @returns Controlled matching schema and migration-record evidence.
 */
function after() {
  return {
    ...before(),
    schemaState: 'definitions-and-records-match',
    migrationTablePresent: true,
    observedApplicationObjectCount: 6,
    recordedExpectedMigrations: [APPROVED_MIGRATION],
  };
}

it.each([undefined, 'false', 'true'])(
  'ignores obsolete deploy flag %s and applies once between exact-state inspections',
  async (enabled) => {
    const order = [];
    const inspect = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push('before');
        return before();
      })
      .mockImplementationOnce(async () => {
        order.push('after');
        return after();
      });
    const execute = vi.fn(async () => {
      order.push('apply-once');
      return true;
    });
    const result = await migrateDev(
      { ...environment(), DEPLOY_ENABLED: enabled },
      { inspect, execute },
    );
    expect(order).toEqual(['before', 'apply-once', 'after']);
    expect(result).toMatchObject({
      migration: APPROVED_MIGRATION,
      commandCompleted: true,
      definitionsAndRecordsVerified: true,
      expectedMigrationSetDigest: APPROVED_DIGEST,
      schemaAttestationRecorded: false,
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-write-secret');
    expect(execute).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(migrationDigest()).toBe(APPROVED_DIGEST);
  },
);

it('rejects unsafe source, reruns, missing confirmation, activation and shared bindings before inspection or execution', async () => {
  for (const [key, value] of [
    ['GITHUB_ACTIONS', 'false'],
    ['GITHUB_EVENT_NAME', 'push'],
    ['GITHUB_REF', 'refs/heads/feature'],
    ['GITHUB_RUN_ATTEMPT', '2'],
    ['EXPECTED_SOURCE_SHA', 'main'],
    ['EXPECTED_SOURCE_SHA', 'b'.repeat(40)],
    ['CONFIRM_FIRST_DEV_MIGRATION', 'false'],
    ['PAYMENTS_ENABLED', 'true'],
    ['CLOUDFLARE_ACCOUNT_ID', 'other'],
    ['D1_DATABASE_ID', 'other'],
    ['OTHER_D1_DATABASE_ID', ''],
    ['OTHER_D1_DATABASE_ID', environment().D1_DATABASE_ID],
    ['CLOUDFLARE_API_TOKEN', ''],
  ]) {
    const inspect = vi.fn();
    const execute = vi.fn();
    await expect(
      migrateDev({ ...environment(), [key]: value }, { inspect, execute }),
    ).rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  }
});

it('rejects initialized, partial, unexpected or inconsistent first-dev state without attempting repair', async () => {
  for (const observation of [
    after(),
    { ...before(), migrationTablePresent: true },
    { ...before(), observedApplicationObjectCount: 1 },
    { ...before(), recordedExpectedMigrations: [APPROVED_MIGRATION] },
    { ...before(), databaseIdentityMatched: false },
    { ...before(), expectedMigrationSetDigest: 'changed' },
    { ...before(), sourceSha: 'b'.repeat(40) },
    { ...before(), schemaState: 'records-without-application-schema' },
  ]) {
    const inspect = vi.fn(async () => observation);
    const execute = vi.fn();
    await expect(
      migrateDev(environment(), { inspect, execute }),
    ).rejects.toThrow('FIRST_DEV_STATE_REQUIRED_NO_AUTOMATIC_REPAIR');
    expect(execute).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledOnce();
  }
});

it('stops on inaccessible preflight state without reflecting provider errors', async () => {
  const inspect = vi
    .fn()
    .mockRejectedValue(
      new Error('private provider payload synthetic-write-secret'),
    );
  const execute = vi.fn();
  await expect(migrateDev(environment(), { inspect, execute })).rejects.toThrow(
    'PREFLIGHT_INSPECTION_REJECTED',
  );
  expect(execute).not.toHaveBeenCalled();
});

it.each([false, 'throw'])(
  'never retries an uncertain migration outcome (%s), even when subsequent definitions match',
  async (outcome) => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(before())
      .mockResolvedValueOnce(after());
    const execute = vi.fn(async () => {
      if (outcome === 'throw') throw new Error('private provider payload');
      return false;
    });
    const result = await migrateDev(environment(), { inspect, execute });
    expect(result.commandCompleted).toBe(false);
    expect(result.definitionsAndRecordsVerified).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
  },
);

it('reports possible partial tracking-table creation without resetting or retrying', async () => {
  const inspect = vi
    .fn()
    .mockResolvedValueOnce(before())
    .mockResolvedValueOnce({ ...before(), migrationTablePresent: true });
  const execute = vi.fn(async () => false);
  expect(await migrateDev(environment(), { inspect, execute })).toMatchObject({
    commandCompleted: false,
    postInspectionState: 'application-schema-absent',
    definitionsAndRecordsVerified: false,
  });
  expect(execute).toHaveBeenCalledOnce();
});

it('does not accept incomplete/mismatched post-inspection or record a schema attestation', async () => {
  for (const observation of [
    before(),
    { ...after(), migrationTablePresent: false },
    { ...after(), recordedExpectedMigrations: [] },
    { ...after(), expectedMigrationSetDigest: 'changed' },
    { ...after(), sourceSha: 'b'.repeat(40) },
    { ...after(), databaseIdentityMatched: false },
  ]) {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(before())
      .mockResolvedValueOnce(observation);
    const execute = vi.fn(async () => true);
    expect(await migrateDev(environment(), { inspect, execute })).toMatchObject(
      {
        definitionsAndRecordsVerified: false,
        schemaAttestationRecorded: false,
      },
    );
    expect(execute).toHaveBeenCalledOnce();
  }
});

it('stops when post-migration inspection is unavailable without repeating the mutation', async () => {
  const inspect = vi
    .fn()
    .mockResolvedValueOnce(before())
    .mockRejectedValueOnce(new Error('private provider payload'));
  const execute = vi.fn(async () => true);
  await expect(migrateDev(environment(), { inspect, execute })).rejects.toThrow(
    'MIGRATION_READBACK_UNCERTAIN_STOP_AND_INSPECT',
  );
  expect(execute).toHaveBeenCalledOnce();
  expect(inspect).toHaveBeenCalledTimes(2);
});

it('builds only the exact remote D1 migration command with isolated migration-only configuration', () => {
  const config = migrationConfig(environment());
  expect(config.name).toBe('crypto-gateway-dev');
  expect(config.account_id).toBe(environment().CLOUDFLARE_ACCOUNT_ID);
  expect(config.d1_databases).toEqual([
    {
      binding: 'DB',
      database_name: 'crypto-gateway-dev',
      database_id: environment().D1_DATABASE_ID,
      migrations_dir: resolve('migrations'),
    },
  ]);
  expect(isAbsolute(config.d1_databases[0].migrations_dir)).toBe(true);
  expect(config).not.toHaveProperty('main');
  expect(config).not.toHaveProperty('vars');
  const args = migrationArguments('synthetic-config.json');
  expect(args).toEqual([
    resolve('node_modules/wrangler/bin/wrangler.js'),
    'd1',
    'migrations',
    'apply',
    'DB',
    '--remote',
    '--config',
    'synthetic-config.json',
  ]);
  expect(args).not.toContain('deploy');
  expect(JSON.stringify(config)).not.toContain('synthetic-write-secret');
});

it.each([
  [{ status: 0 }, true],
  [{ status: 1 }, false],
  [{ status: null, error: new Error('synthetic timeout') }, false],
  [{ status: null, signal: 'SIGTERM' }, false],
])(
  'bounds the real executor path and removes its temporary config (%j)',
  (outcome, expected) => {
    const base = process.env.RUNNER_TEMP || join(tmpdir(), 'opencode');
    mkdirSync(base, { recursive: true });
    const root = mkdtempSync(join(base, 'gateway-migration-fixture-'));
    let configPath;
    const spawn = vi.fn((command, args, options) => {
      expect(command).toBe(process.execPath);
      configPath = args.at(-1);
      expect(args).toEqual(migrationArguments(configPath));
      expect(dirname(dirname(configPath))).toBe(root);
      expect(existsSync(configPath)).toBe(true);
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(
        migrationConfig(environment()),
      );
      expect(options).toMatchObject({
        timeout: 120_000,
        maxBuffer: 1_048_576,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          CI: 'true',
          WRANGLER_SEND_METRICS: 'false',
          CLOUDFLARE_API_TOKEN: 'synthetic-write-secret',
        },
      });
      expect(args.join(' ')).not.toContain('synthetic-write-secret');
      return {
        ...outcome,
        stdout: 'private provider output',
        stderr: 'synthetic-write-secret',
      };
    });
    try {
      expect(
        runMigrationCommand({ ...environment(), RUNNER_TEMP: root }, spawn),
      ).toBe(expected);
      expect(spawn).toHaveBeenCalledOnce();
      expect(existsSync(dirname(configPath))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('cleans up the config if process creation throws and rejects a missing runner temp directory', () => {
  const base = process.env.RUNNER_TEMP || join(tmpdir(), 'opencode');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'gateway-migration-fixture-'));
  let configPath;
  const spawn = vi.fn((command, args) => {
    configPath = args.at(-1);
    throw new Error('synthetic process failure');
  });
  try {
    expect(() =>
      runMigrationCommand({ ...environment(), RUNNER_TEMP: root }, spawn),
    ).toThrow('synthetic process failure');
    expect(existsSync(dirname(configPath))).toBe(false);
    spawn.mockClear();
    expect(() =>
      runMigrationCommand({ ...environment(), RUNNER_TEMP: '' }, spawn),
    ).toThrow('RUNNER_TEMP_REQUIRED');
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not print arbitrary error details through the CLI when context is rejected', () => {
  const module = new URL('../../scripts/migrate-dev.mjs', import.meta.url);
  const source = `process.argv[1] = ${JSON.stringify(fileURLToPath(module))}; await import(${JSON.stringify(module.href)});`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', source],
    {
      env: {
        ...environment(),
        GITHUB_REF: 'refs/heads/private-provider-payload',
      },
      encoding: 'utf8',
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('FRESH_MANUAL_MAIN_REQUIRED');
  expect(result.stdout + result.stderr).not.toMatch(
    /synthetic-write-secret|private-provider-payload/,
  );
});

it('retires the one-time first-schema workflow entry point', () => {
  expect(() => readFileSync('.github/workflows/migrate-dev.yml')).toThrow(
    expect.objectContaining({ code: 'ENOENT' }),
  );
});
