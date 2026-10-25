/** Drive scheduled events against the local Worker only, with no hosted fallback.
 * @file
 */

// Local-only scheduled-event driver. No configurable host or hosted fallback.
const endpoint = "http://localhost:8787/__scheduled?cron=*+*+*+*+*";
let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});
while (!stopped) {
  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    await response.body?.cancel();
    if (!response.ok)
      process.stderr.write("Local scheduled invocation failed.\n");
  } catch {
    process.stderr.write(
      "Local gateway is unavailable; retrying scheduled invocation.\n",
    );
  }
  if (!stopped) await new Promise((resolve) => setTimeout(resolve, 15_000));
}
