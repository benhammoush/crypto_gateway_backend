/** Read-only bounded health/configuration checks, never payment acceptance.
 * @file
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { pathToFileURL, URL } from "node:url";

/** Read one bounded JSON body without redirects or retry, including expected 503.
 * @param response - Selected gateway health/readiness response.
 * @returns Parsed response JSON, rejecting oversized or malformed bodies.
 */
export async function readJson(response) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      assert.ok(size <= 65_536, "Response too large.");
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    if (!response.body?.locked) await response.body?.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Disabled readiness is exactly 503/ready:false, not arbitrary failure.
 * @param env - Explicit API origin and expected target configuration.
 * @param fetcher - Injectable bounded transport; never creates payments.
 * @returns Configuration-smoke observations, not payment acceptance.
 */
export async function smokeDelivery(env, fetcher = globalThis.fetch) {
  const origin = new URL(env.API_ORIGIN);
  assert.equal(origin.origin, env.API_ORIGIN);
  assert.equal(origin.protocol, "https:");
  const config = JSON.parse(env.WORKER_CONFIG_JSON);
  assert.ok(["dev", "production"].includes(config.vars.APP_ENV));
  assert.ok(["false", "true"].includes(config.vars.PAYMENTS_ENABLED));
  const enabled = config.vars.PAYMENTS_ENABLED === "true";
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  for (const path of ["/health", "/ready"]) {
    const response = await fetcher(`${origin.origin}${path}`, {
      method: "GET",
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(15_000),
    });
    const body = await readJson(response);
    assert.equal(response.status, path === "/health" || enabled ? 200 : 503);
    assert.ok(!body.error);
    if (path === "/health") {
      assert.equal(body.data?.service, "crypto_gateway_backend");
      assert.equal(body.data.version, version);
    } else {
      assert.deepEqual(body.data, {
        ready: enabled,
        environment: config.vars.APP_ENV,
        network: "solana-devnet",
      });
    }
  }
  return { configurationSmokeVerified: true, paymentsEnabled: enabled };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    process.stdout.write(
      `${JSON.stringify(await smokeDelivery(process.env))}\n`,
    );
  } catch {
    process.stderr.write(
      "Delivery smoke not verified; inspect without redeploying or enabling payments.\n",
    );
    process.exitCode = 1;
  }
}
