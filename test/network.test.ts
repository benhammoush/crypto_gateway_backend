import { afterEach, expect, it, vi } from "vitest";
import { assertDevnet } from "../src/solana";

afterEach(() => vi.unstubAllGlobals());

it("accepts the full Devnet genesis hash returned by RPC", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      }),
    ),
  );
  await expect(
    assertDevnet("https://rpc.example.org"),
  ).resolves.toBeUndefined();
});

it.each([
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
])("rejects non-Devnet or truncated genesis hash %s", async (result) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ result })),
  );
  await expect(assertDevnet("https://rpc.example.org")).rejects.toMatchObject({
    code: "WRONG_NETWORK",
  });
});

it("fails closed when the RPC provider blocks the request", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: { code: 403 } }, { status: 403 })),
  );
  await expect(assertDevnet("https://rpc.example.org")).rejects.toMatchObject({
    code: "RPC_UNAVAILABLE",
  });
});
