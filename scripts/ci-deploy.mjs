/** Preserve isolated schema/configuration guards while deploying the already-tested Worker bundle. @file */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deliveryConfig, migrationDigest } from "./check-delivery.mjs";
import { smokeDelivery } from "./smoke-delivery.mjs";
import { deploymentExecutor } from "./deployment-error.mjs";

Object.assign(process.env, {
  SOURCE_SHA: process.env.CI_SOURCE_SHA,
  DELIVERY_TARGET: process.env.CI_ENVIRONMENT,
});
const config = deliveryConfig(process.env, migrationDigest());
writeFileSync("wrangler.delivery.json", `${JSON.stringify(config)}\n`);
const { publishWorker } = await import(
  pathToFileURL(
    resolve(process.env.CI_AUTOMATION_ROOT, "scripts/providers.mjs"),
  ).href
);
await publishWorker(
  process.env,
  {
    name: config.name,
    config: "wrangler.delivery.json",
    entry: "dist/index.js",
    configuration: config,
    /** Verify health/readiness without creating, submitting or settling a payment. */
    smoke: async (fetcher) => {
      await smokeDelivery(process.env, fetcher);
    },
  },
  fetch,
  deploymentExecutor(),
);
