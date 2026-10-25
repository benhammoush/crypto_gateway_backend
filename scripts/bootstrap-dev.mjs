/** Explicit first dev deployment only; no provisioning, migration or activation.
 * @file
 */
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostedConfig, migrationDigest } from "./check-delivery.mjs";
import { inspectDevSchema } from "./inspect-dev-schema.mjs";
import { readJson, smokeDelivery } from "./smoke-delivery.mjs";

/** Require explicit first-dev authorization and successful empty-history reads.
 * @param env - Explicit bootstrap authorization and isolated dev identities.
 * @returns Validated first-dev Worker configuration, rejecting ambiguous state.
 */
export function bootstrapConfig(env) {
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  assert.equal(env.SOURCE_SHA, env.GITHUB_SHA);
  assert.equal(env.CONFIRM_FIRST_DEV_DEPLOYMENT, "true");
  assert.equal(env.DELIVERY_TARGET, "dev");
  assert.equal(env.PAYMENTS_ENABLED, "false");
  assert.match(env.EXPECTED_WORKER_ID ?? "", /^[a-f0-9]{32}$/);
  assert.ok(env.CLOUDFLARE_WORKER_BOOTSTRAP_TOKEN);
  const config = hostedConfig(env, migrationDigest());
  assert.equal(config.vars.PAYMENTS_ENABLED, "false");
  return { ...config, preview_urls: false };
}

/** Fixed metadata GETs only; do not print provider bodies or retry failures.
 * @param env - Selected account and its scoped provider credential.
 * @param path - Fixed metadata path beneath the account's Workers API.
 * @param fetcher - Injectable metadata-only transport.
 * @returns The bounded provider response for identity validation.
 */
async function metadata(env, path, fetcher) {
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/${path}`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_WORKER_BOOTSTRAP_TOKEN}`,
      },
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Worker metadata inaccessible.");
  }
  const body = await readJson(response);
  assert.equal(body.success, true);
  return body;
}

/** A successful new-API empty-version inventory, NOT a legacy 404, permits bootstrap.
 * @param env - Selected dev Worker identities.
 * @param fetcher - Injectable metadata-only transport.
 * @param empty - Whether the pre-bootstrap version inventory must be empty.
 * @returns Validated Worker and version observations.
 */
async function workerState(env, fetcher, empty) {
  const path = `workers/${env.EXPECTED_WORKER_ID}`;
  const { result: worker } = await metadata(env, path, fetcher);
  assert.equal(worker?.id, env.EXPECTED_WORKER_ID);
  assert.equal(worker.name, "crypto-gateway-dev");
  assert.equal(worker.subdomain?.url, env.API_ORIGIN);
  assert.equal(worker.subdomain?.previews_enabled, false);
  assert.equal(worker.subdomain?.enabled, !empty);
  const versions = await metadata(
    env,
    `${path}/versions?page=1&per_page=100`,
    fetcher,
  );
  assert.ok(Array.isArray(versions.result));
  assert.ok(
    versions.result_info?.page === 1 && versions.result_info?.per_page === 100,
  );
  assert.equal(versions.result_info.count, versions.result.length);
  assert.equal(versions.result_info.total_count, empty ? 0 : 1);
  assert.equal(versions.result.length, empty ? 0 : 1);
  if (empty) {
    // Reject attached domains/routes/services; do not bootstrap a referenced resource.
    for (const key of [
      "domains",
      "queues",
      "workers",
      "durable_objects",
      "dispatch_namespace_outbounds",
    ]) {
      assert.ok(Array.isArray(worker.references?.[key]));
      assert.equal(worker.references[key].length, 0);
    }
    return null;
  }
  assert.match(versions.result[0]?.id ?? "", /^[a-f0-9-]{32,36}$/);
  return versions.result[0].id;
}

/** Use pinned Wrangler exactly once with explicit config in the selected source root.
 * @param env - Bootstrap execution scope and account identity.
 * @param config - Validated isolated Worker configuration.
 * @param spawn - Injectable one-attempt process executor.
 * @returns Whether the single captured Wrangler command succeeded.
 */
export function runBootstrapCommand(env, config, spawn = spawnSync) {
  const path = resolve("wrangler.bootstrap.json");
  writeFileSync(
    path,
    `${JSON.stringify({ ...config, account_id: env.CLOUDFLARE_ACCOUNT_ID }, null, 2)}\n`,
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  try {
    const result = spawn(
      process.execPath,
      [
        resolve("node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        path,
      ],
      {
        env: {
          ...env,
          CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_WORKER_BOOTSTRAP_TOKEN,
          WRANGLER_SEND_METRICS: "false",
        },
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1_048_576,
        windowsHide: true,
      },
    );
    return !result.error && result.status === 0;
  } finally {
    unlinkSync(path);
  }
}

/** One attempt followed by metadata/schema/smoke inspection; failure never retries.
 * @param env - Explicitly authorized first-dev execution context.
 * @param dependencies - Injectable boundaries; fixtures must not reach real providers.
 * @param dependencies.fetcher - Metadata transport.
 * @param dependencies.inspect - Read-only database schema inspector.
 * @param dependencies.execute - One-attempt bootstrap executor.
 * @param dependencies.smoke - Bounded post-bootstrap configuration checks.
 * @param dependencies.record - Evidence sink retaining uncertain outcomes too.
 * @returns Sanitized bootstrap evidence, never user acceptance or recovery certification.
 */
export async function bootstrapDev(
  env,
  {
    fetcher = globalThis.fetch,
    inspect = inspectDevSchema,
    execute = runBootstrapCommand,
    smoke = smokeDelivery,
    record = () => {},
  } = {},
) {
  const config = bootstrapConfig(env);
  /** Inspect the expected database schema without applying changes.
   * @returns Matching schema evidence for the selected source and database.
   */
  const inspectSchema = async () => {
    const schema = await inspect(env);
    assert.equal(schema.sourceSha, env.SOURCE_SHA);
    assert.equal(schema.databaseIdentityMatched, true);
    assert.equal(schema.schemaState, "definitions-and-records-match");
    assert.equal(schema.migrationTablePresent, true);
    assert.equal(schema.expectedMigrationSetDigest, env.D1_SCHEMA_DIGEST);
    return schema;
  };
  await inspectSchema();
  await workerState(env, fetcher, true);
  record({
    sourceSha: env.SOURCE_SHA,
    workerId: env.EXPECTED_WORKER_ID,
    stage: "ATTEMPT_STARTING_NO_ACCEPTED_PREDECESSOR",
  });
  let commandCompleted = false;
  try {
    commandCompleted = (await execute(env, config)) === true;
  } catch {
    /* Outcome may be partial. */
  }
  let verified = false;
  let versionId = null;
  try {
    versionId = await workerState(env, fetcher, false);
    const { result: history } = await metadata(
      env,
      "scripts/crypto-gateway-dev/deployments",
      fetcher,
    );
    assert.equal(history?.deployments?.length, 1);
    const deployment = history.deployments[0];
    assert.match(deployment.id ?? "", /^[a-f0-9-]{32,36}$/);
    assert.deepEqual(deployment.versions, [
      { version_id: versionId, percentage: 100 },
    ]);
    record({
      sourceSha: env.SOURCE_SHA,
      workerId: env.EXPECTED_WORKER_ID,
      versionId,
      deploymentId: deployment.id,
      stage: "PROVIDER_IDENTITIES_OBSERVED",
    });
    await inspectSchema();
    const result = await smoke(env, fetcher);
    assert.equal(result.configurationSmokeVerified, true);
    assert.equal(result.paymentsEnabled, false);
    verified = true;
  } catch {
    /* Readback failure is not permission to retry or deploy a repair. */
  }
  return {
    sourceSha: env.SOURCE_SHA,
    workerId: env.EXPECTED_WORKER_ID,
    versionId,
    commandCompleted,
    bootstrapVerified: commandCompleted && verified,
    acceptedRecoveryPredecessor: false,
    paymentActivationPerformed: false,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    /** Append the inspected state to the retained bootstrap evidence.
     * @param value - Sanitized bootstrap observation to retain.
     * @returns Completion after appending the evidence.
     */
    const record = (value) =>
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## First dev bootstrap\n\n${JSON.stringify(value)}\n\nNo accepted recovery baseline. Stop and inspect any uncertainty; never rerun or reset automatically.\n`,
      );
    const result = await bootstrapDev(process.env, { record });
    record(result);
    if (!result.bootstrapVerified) process.exitCode = 1;
  } catch {
    process.stderr.write(
      "First dev bootstrap stopped. Inspect metadata and persistent effects before any new authorization; no automatic retry or rollback.\n",
    );
    process.exitCode = 1;
  }
}
