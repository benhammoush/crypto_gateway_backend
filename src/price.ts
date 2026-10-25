/**
 * USD-cent pricing and exact lamport conversion for payment quotes.
 * @packageDocumentation
 */

import { PublicError } from "./types";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const MAX_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);

/** Convert cents with decimal rational arithmetic, rounding upward once. */
export function lamportsForUsd(cents: number, price: string): string {
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 1_000_000)
    throw new PublicError("INVALID_AMOUNT", "Use 1 to 1000000 USD cents.");
  if (price.length > 100) throw new Error("Invalid price.");
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(price);
  if (!match) throw new Error("Invalid price.");
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30)
    throw new Error("Invalid exponent.");
  let numerator = BigInt(match[1] + (match[2] ?? ""));
  let scale = (match[2]?.length ?? 0) - exponent;
  if (scale < 0) {
    numerator *= 10n ** BigInt(-scale);
    scale = 0;
  }
  if (numerator <= 0n || scale > 30) throw new Error("Invalid price.");
  const dividend = BigInt(cents) * 1_000_000_000n * 10n ** BigInt(scale);
  const divisor = 100n * numerator;
  const result = (dividend + divisor - 1n) / divisor;
  if (result < 1n || result > MAX_LAMPORTS)
    throw new Error("Unsupported lamport amount.");
  return result.toString();
}

/** Format exact lamports as nine-decimal SOL without floating-point conversion. */
export function formatSol(lamports: string): string {
  const value = BigInt(lamports);
  return `${value / 1_000_000_000n}.${(value % 1_000_000_000n).toString().padStart(9, "0")}`;
}

/** Load a bounded SOL/USD quote and reject unusable pricing evidence. */
export async function getQuote(
  apiKey: string,
): Promise<{ usdPrice: string; blockId: number }> {
  try {
    const response = await fetch(
      `https://api.jup.ag/price/v3?ids=${SOL_MINT}`,
      {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(8000),
        redirect: "manual",
      },
    );
    const body = (await response.json()) as Record<
      string,
      { usdPrice?: unknown; blockId?: unknown; decimals?: unknown }
    >;
    const price = body[SOL_MINT];
    const usdPrice =
      typeof price?.usdPrice === "number" || typeof price?.usdPrice === "string"
        ? String(price.usdPrice)
        : "";
    if (
      !response.ok ||
      price?.decimals !== 9 ||
      !Number.isSafeInteger(price.blockId) ||
      Number(price.blockId) < 1
    )
      throw new Error();
    lamportsForUsd(1, usdPrice);
    return { usdPrice, blockId: price.blockId as number };
  } catch {
    throw new PublicError(
      "PRICE_UNAVAILABLE",
      "A reliable SOL/USD quote is unavailable. Try again later.",
      503,
    );
  }
}
