/** Retain fixed failure classifications, never raw subprocess output or credentials. @file */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { errorSealer } from "./encrypted-error.mjs";

// Unknown provider numbers are deliberately omitted rather than treated as safe text.
const providerCodes = new Set([
  10000, 10001, 10007, 10021, 10034, 10042, 10063, 9109, 7000, 7003,
]);

/** Extract only allowlisted values from bounded, captured Wrangler output. */
export function classifyDeploymentError(error) {
  const output = [error?.stdout, error?.stderr]
    .filter((value) => typeof value === "string")
    .map((value) => value.slice(0, 1_048_576))
    .join("\n");
  const codes = [...output.matchAll(/\[code:\s*(\d{4,6})\]/g)]
    .map((match) => Number(match[1]))
    .filter((code) => providerCodes.has(code));
  const processCode = ["ENOENT", "ETIMEDOUT", "ENOBUFS", "EACCES"].includes(
    error?.code,
  )
    ? error.code
    : "UNCLASSIFIED";
  return {
    stage: "WRANGLER_SUBPROCESS",
    exitCode:
      Number.isInteger(error?.status) &&
      error.status >= 0 &&
      error.status <= 255
        ? error.status
        : null,
    processCode,
    providerCodes: [...new Set(codes)].sort((a, b) => a - b),
    moduleNotFound:
      /(?:Error: Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)/.test(
        output,
      ),
    dashboardMetadataFailure: output.includes(
      "Unable to fetch bindings, routes, or services metadata from the dashboard",
    ),
    authenticationFailure:
      /Authentication error|Unable to authenticate|Could not authenticate/.test(
        output,
      ),
  };
}

/** Preserve the uncertain checkpoint/status; append only the classifier's fixed schema. */
export function retainDeploymentFailure(
  diagnostic,
  path = "delivery-record.json",
  encryptedError,
) {
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.failure = diagnostic;
  if (encryptedError) record.encryptedError = encryptedError;
  // Same filesystem: a failed write/rename must leave the recovery checkpoint intact.
  const temporary = mkdtempSync(join(dirname(path), ".delivery-failure-"));
  try {
    const pending = join(temporary, "delivery-record.json");
    writeFileSync(pending, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(pending, path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Pass through the exact mutation once; suppress raw errors even if evidence retention fails. */
export function deploymentExecutor(
  execute = execFileSync,
  retain = retainDeploymentFailure,
  seal = errorSealer(),
) {
  return (...args) => {
    try {
      return execute(...args);
    } catch (error) {
      const diagnostic = classifyDeploymentError(error);
      try {
        retain(diagnostic, "delivery-record.json", seal(error, args[2]?.env));
      } catch {
        // Preserve failure, not a provider error containing command/env/response data.
        throw new Error("WRANGLER_FAILED_DIAGNOSTIC_RETENTION_FAILED");
      }
      // Raw cause includes provider output/credentials; only the classification may escape.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("WRANGLER_FAILED_INSPECT_RETAINED_CLASSIFICATION");
    }
  };
}
