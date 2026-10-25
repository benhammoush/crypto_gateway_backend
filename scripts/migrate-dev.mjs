/**
 * Apply only the reviewed first dev migration after fresh exact-state inspection.
 * Never deploy, activate payments, repair data or retry an uncertain outcome.
 * @file
 */
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrationDigest } from './check-delivery.mjs';
import { inspectDevSchema } from './inspect-dev-schema.mjs';

export const APPROVED_MIGRATION = '0001_payments.sql';
export const APPROVED_DIGEST =
  '0b9c864f51e36b27b6c8d38b061cd5cdff837cd2547ec445f8691e84aafab042';
/** Controlled migration failure distinguished from raw provider or command errors. */
class MigrationError extends Error {}

/** Reject with fixed classifications, without printing credentials or provider output.
 * @param condition - Migration guard that must hold before proceeding.
 * @param code - Controlled failure label safe for logs.
 */
function requireValue(condition, code) {
  if (!condition) throw new MigrationError(code);
}

/** A migration-only config has no Worker entrypoint, secrets, vars or deployment routes.
 * @param env - Explicit account and dev database identities.
 * @returns Configuration scoped only to the selected migration target.
 */
export function migrationConfig(env) {
  return {
    name: 'crypto-gateway-dev',
    account_id: env.CLOUDFLARE_ACCOUNT_ID,
    compatibility_date: '2026-10-04',
    workers_dev: false,
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'crypto-gateway-dev',
        database_id: env.D1_DATABASE_ID,
        migrations_dir: resolve('migrations'),
      },
    ],
  };
}

/** Use only pinned local Wrangler's migrations command, capturing all raw output.
 * @param configPath - Generated migration-only configuration path.
 * @returns Arguments for the pinned local Wrangler migrations command.
 */
export function migrationArguments(configPath) {
  return [
    resolve('node_modules/wrangler/bin/wrangler.js'),
    'd1',
    'migrations',
    'apply',
    'DB',
    '--remote',
    '--config',
    configPath,
  ];
}

/** Run once in the isolated runner workspace; never stream raw CLI/provider output.
 * @param env - Explicit approved dev migration context and runner workspace.
 * @param spawn - Injectable one-attempt process executor.
 * @returns Captured command success without printing provider output.
 */
export function runMigrationCommand(env, spawn = spawnSync) {
  requireValue(
    typeof env.RUNNER_TEMP === 'string' && env.RUNNER_TEMP.length > 0,
    'RUNNER_TEMP_REQUIRED',
  );
  const directory = mkdtempSync(
    join(env.RUNNER_TEMP, 'gateway-dev-migration-'),
  );
  try {
    const configPath = join(directory, 'wrangler.migration.json');
    writeFileSync(configPath, `${JSON.stringify(migrationConfig(env))}\n`, {
      mode: 0o600,
    });
    const result = spawn(process.execPath, migrationArguments(configPath), {
      env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1_048_576,
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Inspect, apply once, then inspect once; fixture injection never uses live credentials.
 * @param env - Explicitly authorized dev migration context.
 * @param dependencies - Injectable inspection and execution boundaries.
 * @param dependencies.inspect - Read-only schema inspector.
 * @param dependencies.execute - One-attempt migration executor.
 * @returns Sanitized before/after migration evidence.
 */
export async function migrateDev(
  env,
  { inspect = inspectDevSchema, execute = runMigrationCommand } = {},
) {
  requireValue(
    env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_REF === 'refs/heads/main' &&
      env.GITHUB_RUN_ATTEMPT === '1',
    'FRESH_MANUAL_MAIN_REQUIRED',
  );
  requireValue(
    /^[a-f0-9]{40}$/.test(env.EXPECTED_SOURCE_SHA ?? '') &&
      env.EXPECTED_SOURCE_SHA === env.GITHUB_SHA,
    'EXACT_REVIEWED_SOURCE_REQUIRED',
  );
  requireValue(
    env.CONFIRM_FIRST_DEV_MIGRATION === 'true',
    'EXPLICIT_DEV_MIGRATION_CONFIRMATION_REQUIRED',
  );
  requireValue(
    env.PAYMENTS_ENABLED === 'false',
    'PAYMENTS_MUST_REMAIN_DISABLED',
  );
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  requireValue(
    /^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') &&
      uuid.test(env.D1_DATABASE_ID ?? '') &&
      uuid.test(env.OTHER_D1_DATABASE_ID ?? '') &&
      env.D1_DATABASE_ID !== env.OTHER_D1_DATABASE_ID &&
      Boolean(env.CLOUDFLARE_API_TOKEN),
    'ISOLATED_DEV_CONFIGURATION_REQUIRED',
  );
  const files = readdirSync('migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort();
  requireValue(
    files.length === 1 &&
      files[0] === APPROVED_MIGRATION &&
      migrationDigest() === APPROVED_DIGEST,
    'ONLY_REVIEWED_FIRST_MIGRATION_ALLOWED',
  );
  let before;
  try {
    before = await inspect(env);
  } catch {
    throw new MigrationError('PREFLIGHT_INSPECTION_REJECTED');
  }
  requireValue(
    before.databaseIdentityMatched === true &&
      before.sourceSha === env.GITHUB_SHA &&
      before.expectedMigrationSetDigest === APPROVED_DIGEST &&
      before.schemaState === 'application-schema-absent' &&
      before.migrationTablePresent === false &&
      before.observedApplicationObjectCount === 0 &&
      before.recordedExpectedMigrations.length === 0,
    'FIRST_DEV_STATE_REQUIRED_NO_AUTOMATIC_REPAIR',
  );
  let completed = false;
  try {
    completed = (await execute(env)) === true;
  } catch {
    // A thrown/failed command may already have changed schema or migration records.
  }
  let after;
  try {
    after = await inspect(env);
  } catch {
    throw new MigrationError('MIGRATION_READBACK_UNCERTAIN_STOP_AND_INSPECT');
  }
  const verified =
    completed &&
    after.databaseIdentityMatched === true &&
    after.sourceSha === env.GITHUB_SHA &&
    after.expectedMigrationSetDigest === APPROVED_DIGEST &&
    after.schemaState === 'definitions-and-records-match' &&
    after.migrationTablePresent === true &&
    after.recordedExpectedMigrations.length === 1 &&
    after.recordedExpectedMigrations[0] === APPROVED_MIGRATION;
  return {
    sourceSha: env.GITHUB_SHA,
    migration: APPROVED_MIGRATION,
    expectedMigrationSetDigest: APPROVED_DIGEST,
    commandCompleted: completed,
    postInspectionState: after.schemaState,
    definitionsAndRecordsVerified: verified,
    schemaAttestationRecorded: false,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const result = await migrateDev(process.env);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## First dev migration and readback\n\n${JSON.stringify(result)}\n\nNo Worker deployment, payment activation or production operation was requested. D1_SCHEMA_DIGEST was not set. If command completion or readback is uncertain, stop and inspect; never rerun or reset automatically.\n`,
    );
    if (!result.definitionsAndRecordsVerified) {
      process.stderr.write(
        'Migration completion/readback is not verified. Stop for separately reviewed inspection; do not retry, rerun, reset or repair automatically.\n',
      );
      process.exitCode = 1;
    }
  } catch (error) {
    const code =
      error instanceof MigrationError
        ? error.message
        : 'MIGRATION_OUTCOME_UNCERTAIN';
    process.stderr.write(
      `First dev migration stopped: ${code}. No deployment was requested; inspect before any fresh dispatch.\n`,
    );
    process.exitCode = 1;
  }
}
