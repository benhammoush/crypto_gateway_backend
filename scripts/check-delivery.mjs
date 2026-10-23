/**
 * Validate an operator-managed hosted target without using local bindings or secrets.
 * This guard does not apply migrations or certify live payment/recovery acceptance.
 * @file
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL, URL } from "node:url";

/**
 * Fingerprint the exact reviewed migration files, not the mutable remote database.
 * @param directory - Selected candidate's migrations directory.
 * @returns Deterministic migration-set fingerprint for operator schema readback.
 */
export function migrationDigest(directory = "migrations") {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(files.length, "Migration files are required.");
  return createHash("sha256")
    .update(
      JSON.stringify(
        files.map((name) => [
          name,
          readFileSync(`${directory}/${name}`, "utf8"),
        ]),
      ),
    )
    .digest("hex");
}

/**
 * Require explicit isolation, reviewed migrations and native manual production flow.
 * @param env - Environment-scoped configuration; never printed.
 * @param digest - Selected source's migration-set fingerprint.
 * @returns Validated managed configuration for the hosted Worker only.
 */
export function hostedConfig(env, digest) {
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.match(env.SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
  const target = env.DELIVERY_TARGET;
  assert.ok(["dev", "production"].includes(target));
  assert.ok(["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME));
  if (target === "production") {
    assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
    assert.equal(
      env.GITHUB_RUN_ATTEMPT,
      "1",
      "Use a new dispatch and native approval.",
    );
  }
  assert.match(env.CLOUDFLARE_ACCOUNT_ID ?? "", /^[a-f0-9]{32}$/);
  assert.ok(
    env.CLOUDFLARE_API_TOKEN,
    "Missing environment deployment credential.",
  );
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  assert.match(env.D1_DATABASE_ID ?? "", uuid);
  assert.match(env.OTHER_D1_DATABASE_ID ?? "", uuid);
  assert.notEqual(env.D1_DATABASE_ID, env.OTHER_D1_DATABASE_ID);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(
    env.D1_SCHEMA_DIGEST,
    digest,
    "Operator migration readback is missing or outdated.",
  );
  const origin = new URL(env.API_ORIGIN);
  assert.equal(origin.origin, env.API_ORIGIN);
  assert.equal(origin.protocol, "https:");
  const config = JSON.parse(env.WORKER_CONFIG_JSON);
  assert.deepEqual(
    Object.keys(config).sort(),
    [
      "compatibility_date",
      "compatibility_flags",
      "d1_databases",
      "main",
      "name",
      "triggers",
      "vars",
      "workers_dev",
    ].sort(),
  );
  assert.equal(config.name, `crypto-gateway-${target}`);
  assert.equal(config.main, "src/index.ts");
  assert.equal(config.compatibility_date, "2026-10-04");
  assert.deepEqual(config.compatibility_flags, [
    "global_fetch_strictly_public",
  ]);
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.d1_databases, [
    {
      binding: "DB",
      database_name: `crypto-gateway-${target}`,
      database_id: env.D1_DATABASE_ID,
      migrations_dir: "migrations",
    },
  ]);
  assert.deepEqual(config.triggers, { crons: ["* * * * *"] });
  assert.deepEqual(
    Object.keys(config.vars)
      .filter((key) => key !== "SOLANA_RPC_URL")
      .sort(),
    ["APP_ENV", "CHECKOUT_ORIGIN", "PAYMENTS_ENABLED", "WEBHOOK_HOSTS"].sort(),
  );
  assert.equal(config.vars.APP_ENV, target);
  assert.ok(["true", "false"].includes(config.vars.PAYMENTS_ENABLED));
  const checkout = new URL(config.vars.CHECKOUT_ORIGIN);
  assert.equal(checkout.origin, config.vars.CHECKOUT_ORIGIN);
  assert.equal(checkout.protocol, "https:");
  // Keyed RPC and merchant/provider credentials belong in remote Worker secrets.
  if ("SOLANA_RPC_URL" in config.vars) {
    assert.equal(config.vars.SOLANA_RPC_URL, "https://api.devnet.solana.com");
  }
  assert.equal(typeof config.vars.WEBHOOK_HOSTS, "string");
  return config;
}

/** Only production requires activation; bootstrap has its own strict gate. */
export function deliveryConfig(env, digest) {
  if (env.DELIVERY_TARGET === "production")
    assert.equal(env.DEPLOY_ENABLED, "true", "Deployment remains disabled.");
  return hostedConfig(env, digest);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const config = deliveryConfig(process.env, migrationDigest());
    writeFileSync("wrangler.delivery.json", `${JSON.stringify(config)}\n`);
  } catch {
    process.stderr.write(
      "Delivery guard rejected the target. Review source, isolation, migration readback and environment setup without sharing credential values.\n",
    );
    process.exitCode = 1;
  }
}
