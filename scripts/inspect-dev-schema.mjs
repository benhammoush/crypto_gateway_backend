/**
 * Inventory only dev schema definitions and migration names; never attest or migrate D1.
 * @file
 */
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { migrationDigest } from "./check-delivery.mjs";

// No caller-supplied SQL, parameters, paths or row-table queries are accepted.
export const CATALOG_SQL =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type, name LIMIT 129";
export const MIGRATIONS_SQL =
  "SELECT name FROM d1_migrations ORDER BY id LIMIT 129";
class InspectionError extends Error {}

/** Fail with a source-defined classification, never raw SQL or provider errors. */
function requireValue(condition, code) {
  if (!condition) throw new InspectionError(code);
}

/** Derive expected definitions in disposable local memory, never in remote D1. */
export function expectedSchema() {
  const files = readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort();
  requireValue(files.length > 0, "SOURCE_MIGRATIONS_MISSING");
  const memory = new DatabaseSync(":memory:");
  try {
    for (const file of files)
      memory.exec(readFileSync(`migrations/${file}`, "utf8"));
    const definitions = memory.prepare(CATALOG_SQL).all();
    requireValue(
      definitions.length > 0 && definitions.length <= 128,
      "SOURCE_SCHEMA_UNSUPPORTED",
    );
    return { files, definitions, digest: migrationDigest() };
  } finally {
    memory.close();
  }
}

/** Bound each response and expose only fixed error classifications. */
async function readProvider(fetcher, url, token, label, sql) {
  const response = await fetcher(url, {
    method: sql === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(sql === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(sql === undefined ? {} : { body: JSON.stringify({ sql }) }),
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new InspectionError(`${label}_HTTP_${response.status}`);
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

/** Send only one of the two fixed SELECT statements and reject write/unknown metrics. */
async function queryCatalog(fetcher, endpoint, token, sql) {
  requireValue(
    sql === CATALOG_SQL || sql === MIGRATIONS_SQL,
    "QUERY_NOT_ALLOWED",
  );
  const result = await readProvider(
    fetcher,
    endpoint,
    token,
    "SCHEMA_QUERY",
    sql,
  );
  requireValue(
    Array.isArray(result) &&
      result.length === 1 &&
      result[0]?.success === true &&
      Array.isArray(result[0].results),
    "QUERY_RESPONSE_INVALID",
  );
  const { meta, results } = result[0];
  requireValue(
    meta?.changed_db === false && meta.changes === 0 && meta.rows_written === 0,
    "QUERY_WRITE_METRICS_NOT_READ_ONLY",
  );
  requireValue(results.length <= 128, "CATALOG_LIMIT_EXCEEDED");
  return results;
}

/** Inspect exact configured dev D1 identity, then schema and migration metadata only. */
export async function inspectDevSchema(env, fetcher = globalThis.fetch) {
  requireValue(
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REF === "refs/heads/main" &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""),
    "MANUAL_MAIN_REQUIRED",
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
  const expected = expectedSchema();
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}`;
  const database = await readProvider(
    fetcher,
    endpoint,
    env.CLOUDFLARE_API_TOKEN,
    "D1_METADATA",
  );
  requireValue(
    database?.uuid === env.D1_DATABASE_ID &&
      database.name === "crypto-gateway-dev",
    "D1_IDENTITY_MISMATCH",
  );
  const catalog = await queryCatalog(
    fetcher,
    `${endpoint}/query`,
    env.CLOUDFLARE_API_TOKEN,
    CATALOG_SQL,
  );
  requireValue(
    catalog.every(
      (row) =>
        row &&
        typeof row.name === "string" &&
        typeof row.type === "string" &&
        typeof row.tbl_name === "string" &&
        typeof row.sql === "string",
    ) && new Set(catalog.map((row) => row.name)).size === catalog.length,
    "CATALOG_RESPONSE_INVALID",
  );
  const migrationTable = catalog.find((row) => row.name === "d1_migrations");
  requireValue(
    !migrationTable ||
      (migrationTable.type === "table" &&
        migrationTable.tbl_name === "d1_migrations"),
    "MIGRATION_TABLE_NOT_A_TABLE",
  );
  const application = catalog.filter((row) => row.name !== "d1_migrations");
  // Exact source-derived definitions only: equivalent rewrites still need operator review.
  requireValue(
    application.length === 0 ||
      (application.length === expected.definitions.length &&
        application.every((row) =>
          expected.definitions.some(
            (definition) =>
              definition.type === row.type &&
              definition.name === row.name &&
              definition.tbl_name === row.tbl_name &&
              definition.sql === row.sql,
          ),
        )),
    "APPLICATION_SCHEMA_REVIEW_REQUIRED",
  );
  const records = migrationTable
    ? await queryCatalog(
        fetcher,
        `${endpoint}/query`,
        env.CLOUDFLARE_API_TOKEN,
        MIGRATIONS_SQL,
      )
    : [];
  requireValue(
    records.every(
      (row) =>
        row &&
        typeof row.name === "string" &&
        expected.files.includes(row.name),
    ) && new Set(records.map((row) => row.name)).size === records.length,
    "MIGRATION_RECORDS_REVIEW_REQUIRED",
  );
  const recordsMatch = records.length === expected.files.length;
  return {
    sourceSha: env.GITHUB_SHA,
    databaseIdentityMatched: true,
    schemaState:
      application.length === 0
        ? records.length === 0
          ? "application-schema-absent"
          : "records-without-application-schema"
        : recordsMatch
          ? "definitions-and-records-match"
          : "definitions-present-records-incomplete",
    migrationTablePresent: Boolean(migrationTable),
    observedApplicationObjectCount: application.length,
    recordedExpectedMigrations: records.map((row) => row.name).sort(),
    expectedMigrationSetDigest: expected.digest,
    schemaAttestationRecorded: false,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    const result = await inspectDevSchema(process.env);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Dev schema metadata inspection\n\n${JSON.stringify(result)}\n\nOnly schema definitions and migration names were inspected. Application data was not queried. Source migrations were evaluated only in disposable local memory, never applied to D1. Expected digest is not a recorded remote attestation; no environment variable, deployment, migration, activation or recovery action is authorized by this result.\n`,
    );
  } catch (error) {
    const code =
      error instanceof InspectionError ? error.message : "INSPECTION_FAILED";
    process.stderr.write(
      `Dev schema inspection stopped: ${code}. Only fixed metadata SELECTs were permitted; no mutation SQL was requested. Inspect any unknown outcome before further action.\n`,
    );
    process.exitCode = 1;
  }
}
