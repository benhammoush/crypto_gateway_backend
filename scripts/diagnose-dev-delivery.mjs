/**
 * Inspect fixed dev metadata and classify packaging without a provider mutation.
 * Raw provider/subprocess output and credential/policy values never leave this module.
 * @file
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostedConfig, migrationDigest } from './check-delivery.mjs';

/** Fetch one fixed-origin metadata resource; retain only numeric error codes.
 * @param path - Fixed Cloudflare metadata path.
 * @param token - Selected account's scoped provider credential.
 * @param fetcher - Injectable metadata transport.
 * @returns A bounded response classification, never raw provider failure text.
 */
async function metadata(path, token, fetcher) {
  try {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      },
    );
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) return { status: 'RESPONSE_TOO_LARGE' };
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const codes = (Array.isArray(body.errors) ? body.errors : [])
      .map(({ code }) => code)
      .filter(
        (code) => Number.isSafeInteger(code) && code >= 1000 && code <= 999_999,
      )
      .slice(0, 5);
    if (!response.ok) return { status: `HTTP_${response.status}`, codes };
    if (body.success !== true) return { status: 'API_REJECTED', codes };
    return { status: 'READ_OK', codes: [], result: body.result };
  } catch {
    return { status: 'READ_FAILED' };
  }
}

/** Keep only known scalar classifications, never remote bodies or token details.
 * @param observation - Captured metadata response classification.
 * @param observation.status - HTTP status observed by the diagnostic.
 * @param observation.codes - Optional numeric provider error codes.
 * @returns Only the status and optional controlled code list.
 */
function classification({ status, codes }) {
  return codes ? { status, codes } : { status };
}

/**
 * Diagnose the configured dev target with GETs and a credential-free local dry run.
 * Enabled deployments/payments are observed, not changed; old bootstrap guards remain.
 * @param env - Manual-main context and explicit isolated dev target identities.
 * @param fetcher - Injectable metadata-only transport.
 * @param execute - Injectable credential-free local dry-run executor.
 * @returns Sanitized observations, not deployment or payment acceptance.
 */
export async function diagnoseDev(env, fetcher = fetch, execute = spawnSync) {
  assert.equal(env.GITHUB_REPOSITORY, 'benhammoush/crypto_gateway_backend');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, '86151fe132605d222017f191e4a1ee01');
  const config = hostedConfig(
    { ...env, SOURCE_SHA: env.GITHUB_SHA, DELIVERY_TARGET: 'dev' },
    migrationDigest(),
  );
  const account = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  const worker = `${account}/workers/scripts/crypto-gateway-dev`;
  const token = env.CLOUDFLARE_API_TOKEN;
  const report = { sourceSha: env.GITHUB_SHA, readOnly: true, checks: {} };
  const history = await metadata(`${worker}/deployments`, token, fetcher);
  report.checks.deployments = classification(history);
  const versions = history.result?.deployments?.[0]?.versions;
  const versionId = versions?.length === 1 && versions[0].version_id;
  if (
    typeof versionId === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(versionId)
  ) {
    const version = await metadata(
      `${worker}/versions/${versionId}`,
      token,
      fetcher,
    );
    report.checks.version = classification(version);
    if (version.status === 'READ_OK') {
      const bindings = version.result?.resources?.bindings;
      report.runtimeConfigurationMatches = Array.isArray(bindings)
        ? bindings.some(
            (binding) => binding.name === 'APP_ENV' && binding.text === 'dev',
          ) &&
          bindings.some(
            (binding) =>
              binding.name === 'PAYMENTS_ENABLED' &&
              binding.text === config.vars.PAYMENTS_ENABLED,
          ) &&
          bindings.some(
            (binding) =>
              binding.name === 'DB' &&
              (binding.id ?? binding.database_id) === env.D1_DATABASE_ID,
          )
        : null;
      report.rpcSecretObserved = Array.isArray(bindings)
        ? bindings.some(
            (binding) =>
              binding.name === 'SOLANA_RPC_URL' &&
              binding.type === 'secret_text',
          )
        : null;
    }
  }
  for (const [label, path] of [
    ['workerSettings', `${worker}/settings`],
    ['workerSubdomain', `${account}/workers/subdomain`],
    ['databaseMetadata', `${account}/d1/database/${env.D1_DATABASE_ID}`],
  ])
    report.checks[label] = classification(await metadata(path, token, fetcher));

  // Self-policy visibility is optional: do not grant token-admin permissions for this check.
  let identity = await metadata('/user/tokens/verify', token, fetcher);
  let identityPath = '/user/tokens';
  report.checks.userTokenIdentity = classification(identity);
  if (identity.status !== 'READ_OK') {
    identityPath = `${account}/tokens`;
    identity = await metadata(`${identityPath}/verify`, token, fetcher);
    report.checks.accountTokenIdentity = classification(identity);
  }
  report.workerScriptWriteListed = null;
  if (
    identity.status === 'READ_OK' &&
    /^[a-f0-9]{32}$/.test(identity.result?.id ?? '')
  ) {
    const policy = await metadata(
      `${identityPath}/${identity.result.id}`,
      token,
      fetcher,
    );
    report.checks.tokenPolicy = classification(policy);
    if (Array.isArray(policy.result?.policies)) {
      report.workerScriptWriteListed = policy.result.policies.some(
        (entry) =>
          entry.effect === 'allow' &&
          entry.permission_groups?.some((group) =>
            ['Workers Scripts Write', 'Workers Scripts Edit'].includes(
              group.name,
            ),
          ),
      );
    }
  }

  const directory = mkdtempSync(
    join(env.RUNNER_TEMP || tmpdir(), 'gateway-dev-diagnostic-'),
  );
  try {
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify(config));
    const dryRun = execute(
      process.execPath,
      [
        resolve('node_modules/wrangler/bin/wrangler.js'),
        'deploy',
        resolve('dist/index.js'),
        '--no-bundle',
        '--config',
        configPath,
        '--dry-run',
        '--outdir',
        join(directory, 'output'),
      ],
      {
        cwd: directory,
        // No Cloudflare/GitHub credential, runtime secret or inherited NODE_OPTIONS in the child.
        env: {
          ...Object.fromEntries(
            ['PATH', 'SystemRoot']
              .filter((key) => env[key])
              .map((key) => [key, env[key]]),
          ),
          HOME: directory,
          USERPROFILE: directory,
          APPDATA: directory,
          XDG_CONFIG_HOME: directory,
          TEMP: directory,
          TMP: directory,
          WRANGLER_SEND_METRICS: 'false',
        },
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 1_048_576,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    report.packaging =
      dryRun.status === 0 && !dryRun.error ? 'DRY_RUN_OK' : 'DRY_RUN_FAILED';
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const report = await diagnoseDev(process.env);
    const text = `## Read-only dev delivery diagnostics\n\n${JSON.stringify(report, null, 2)}\n\nOnly GET metadata requests and a credential-free local dry run were used. Policy visibility/write-group names do not prove effective deployment permission or certify readiness. No upload, deployment, secret change, SQL or payment request was made.\n`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
    process.stdout.write(text);
  } catch {
    process.stderr.write(
      'Dev diagnostics stopped: UNSAFE_CONTEXT_OR_CONFIGURATION. No deployment was requested.\n',
    );
    process.exitCode = 1;
  }
}
