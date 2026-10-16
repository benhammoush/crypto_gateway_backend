/**
 * Read dev provider metadata only; never deploy, query SQL or certify readiness.
 * @file
 */
import { appendFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";

class VerificationError extends Error {}

/** Fail with a source-defined classification, never a provider response. */
function requireValue(condition, code) {
  if (!condition) throw new VerificationError(code);
}

/** Read a bounded JSON response without redirects, retries or payload logging. */
async function readMetadata(fetcher, url, token, label) {
  const response = await fetcher(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new VerificationError(`${label}_HTTP_${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireValue(size <= 65_536, `${label}_RESPONSE_TOO_LARGE`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requireValue(body?.success === true, `${label}_REJECTED`);
  return body.result;
}

/** Inspect only the configured dev database and named dev Worker's metadata. */
export async function verifyDev(env, fetcher = globalThis.fetch) {
  requireValue(
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REF === "refs/heads/main" &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""),
    "MANUAL_MAIN_REQUIRED",
  );
  requireValue(
    !env.DEPLOY_ENABLED || env.DEPLOY_ENABLED === "false",
    "DEPLOYMENT_MUST_REMAIN_DISABLED",
  );
  requireValue(
    !env.PAYMENTS_ENABLED || env.PAYMENTS_ENABLED === "false",
    "PAYMENTS_MUST_REMAIN_DISABLED",
  );
  requireValue(
    /^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
        env.D1_DATABASE_ID ?? "",
      ) &&
      Boolean(env.CLOUDFLARE_API_TOKEN),
    "DEV_CONFIGURATION_MISSING_OR_INVALID",
  );
  const account = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  const database = await readMetadata(
    fetcher,
    `${account}/d1/database/${env.D1_DATABASE_ID}`,
    env.CLOUDFLARE_API_TOKEN,
    "D1_METADATA",
  );
  requireValue(
    database?.uuid === env.D1_DATABASE_ID &&
      database.name === "crypto-gateway-dev",
    "D1_IDENTITY_MISMATCH",
  );
  const history = await readMetadata(
    fetcher,
    `${account}/workers/scripts/crypto-gateway-dev/deployments`,
    env.CLOUDFLARE_API_TOKEN,
    "WORKER_DEPLOYMENTS",
  );
  requireValue(
    Array.isArray(history?.deployments),
    "WORKER_DEPLOYMENTS_RESPONSE_INVALID",
  );
  return {
    sourceSha: env.GITHUB_SHA,
    databaseIdentityMatched: true,
    workerDeploymentListingReadable: true,
    deploymentEntriesObserved: history.deployments.length,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const result = await verifyDev(process.env);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Read-only dev metadata\n\n${JSON.stringify(result)}\n\nOnly selected metadata reads succeeded. Token least-privilege scope, schema state, runtime secrets, payment acceptance and recovery eligibility are not certified. No deployment or SQL was requested.\n`,
    );
  } catch (error) {
    const code =
      error instanceof VerificationError
        ? error.message
        : "VERIFICATION_FAILED";
    process.stderr.write(
      `Read-only dev verification rejected: ${code}. No provider changes were requested; do not infer empty history from failed inspection.\n`,
    );
    process.exitCode = 1;
  }
}
