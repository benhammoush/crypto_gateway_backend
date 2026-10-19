/** Read-only bounded health/configuration checks, never payment acceptance. @file */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { pathToFileURL, URL } from "node:url";

/** Read one bounded JSON body without redirects or retry, including expected 503. */
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

/** Validate private dev data-plane credentials before any deployment mutation. */
export function smokeConfig(env) {
  const origin = new URL(env.API_ORIGIN);
  assert.equal(origin.origin, env.API_ORIGIN);
  assert.equal(origin.protocol, "https:");
  const config = JSON.parse(env.WORKER_CONFIG_JSON);
  assert.ok(["dev", "production"].includes(config.vars.APP_ENV));
  assert.ok(["false", "true"].includes(config.vars.PAYMENTS_ENABLED));
  const headers = {};
  const dev = "https://crypto-gateway-dev.benhxm.workers.dev";
  if (config.vars.APP_ENV === "dev") {
    assert.equal(origin.origin, dev);
    for (const key of [
      "GATEWAY_ACCESS_CI_CLIENT_ID",
      "GATEWAY_ACCESS_CI_CLIENT_SECRET",
    ])
      assert.ok(
        env[key] && !/[^\x21-\x7e]/.test(env[key]),
        "Missing dev Access credential.",
      );
    headers["CF-Access-Client-Id"] = env.GATEWAY_ACCESS_CI_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.GATEWAY_ACCESS_CI_CLIENT_SECRET;
  } else {
    assert.notEqual(origin.origin, dev);
    assert.ok(
      !env.GATEWAY_ACCESS_CI_CLIENT_ID && !env.GATEWAY_ACCESS_CI_CLIENT_SECRET,
    );
  }
  return { origin, config, headers };
}

/** Disabled readiness is exactly 503/ready:false, not arbitrary failure. */
export async function smokeDelivery(env, fetcher = globalThis.fetch) {
  const { origin, config, headers } = smokeConfig(env);
  const enabled = config.vars.PAYMENTS_ENABLED === "true";
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  for (const path of ["/health", "/ready"]) {
    const response = await fetcher(`${origin.origin}${path}`, {
      method: "GET",
      redirect: "error",
      headers,
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
    if (process.argv[2] === "--preflight") smokeConfig(process.env);
    else
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
