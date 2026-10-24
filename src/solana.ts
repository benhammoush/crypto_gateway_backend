/**
 * Solana network and finalized transaction validation.
 * @packageDocumentation
 */

import { Payment, PublicError } from "./types";
import { base58Length } from "./security";

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/** Parsed instruction fields consumed by transfer validation. */
interface ParsedInstruction {
  programId: string;
  parsed?: unknown;
  accounts?: string[];
  data?: string;
}

/** Finalized transaction evidence consumed by settlement validation. */
export interface ParsedTransaction {
  blockTime: number | null;
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: { pubkey: string; signer: boolean }[];
      instructions: ParsedInstruction[];
    };
  };
}

/** Send a bounded JSON-RPC request and reject transport or RPC-level failure. */
export async function rpc<T>(
  url: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "manual",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await response.json()) as { error?: unknown; result?: T };
    if (!response.ok || body.error || !("result" in body)) throw new Error();
    return body.result as T;
  } catch {
    throw new PublicError(
      "RPC_UNAVAILABLE",
      "Solana verification is temporarily unavailable.",
      503,
    );
  }
}

/** Require the configured RPC endpoint to report the Solana Devnet genesis identity. */
export async function assertDevnet(url: string): Promise<void> {
  if ((await rpc<string>(url, "getGenesisHash")) !== DEVNET_GENESIS) {
    throw new PublicError(
      "WRONG_NETWORK",
      "Payment processing requires Solana Devnet.",
      503,
    );
  }
}

/** Accept only account-free SetComputeUnitLimit(u32) / SetComputeUnitPrice(u64). */
function computeBudgetKind(instruction: ParsedInstruction): number | null {
  if (
    instruction?.programId !== COMPUTE_BUDGET_PROGRAM ||
    instruction.parsed !== undefined ||
    !Array.isArray(instruction.accounts) ||
    instruction.accounts.length !== 0 ||
    typeof instruction.data !== "string" ||
    instruction.data.length > 13
  )
    return null;
  const length = base58Length(instruction.data);
  if (length !== 5 && length !== 9) return null;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let bytes = 0n;
  for (const char of instruction.data)
    bytes = bytes * 58n + BigInt(alphabet.indexOf(char));
  const kind = Number(bytes >> BigInt((length - 1) * 8));
  return (kind === 2 && length === 5) || (kind === 3 && length === 9)
    ? kind
    : null;
}

/** Verify transfer + memo, optionally preceded by unique compute limit/price settings. */
export function validateTransfer(
  tx: ParsedTransaction,
  signature: string,
  payment: Payment,
): string {
  /** Reject the transaction instead of accepting incomplete validation evidence. */
  const reject = () => {
    throw new PublicError(
      "TRANSFER_REJECTED",
      "The transfer does not match this payment request.",
      422,
    );
  };
  if (
    !tx?.meta ||
    tx.meta.err !== null ||
    tx.transaction?.signatures?.[0] !== signature ||
    !Number.isSafeInteger(tx.blockTime)
  )
    return reject();
  const time = Number(tx.blockTime) * 1000;
  if (
    time < Math.floor(payment.created_at / 1000) * 1000 ||
    time > payment.expires_at
  )
    return reject();
  const keys = tx.transaction.message?.accountKeys;
  if (!Array.isArray(keys)) return reject();
  const payer = keys[0];
  if (
    !payer?.signer ||
    payer.pubkey === payment.recipient ||
    keys.filter((key) => key.pubkey === payment.recipient).length !== 1
  )
    return reject();
  const instructions = tx.transaction.message.instructions;
  if (
    !Array.isArray(instructions) ||
    instructions.length < 2 ||
    instructions.length > 4
  )
    return reject();
  const budgetKinds = new Set<number>();
  for (const instruction of instructions.slice(0, -2)) {
    const kind = computeBudgetKind(instruction);
    if (kind === null || budgetKinds.has(kind)) return reject();
    budgetKinds.add(kind);
  }
  const [transfer, memo] = instructions.slice(-2);
  if (!transfer || !memo) return reject();
  const parsed = transfer.parsed as
    | {
        type?: string;
        info?: { source?: string; destination?: string; lamports?: number };
      }
    | undefined;
  if (
    transfer.programId !== SYSTEM_PROGRAM ||
    parsed?.type !== "transfer" ||
    parsed.info?.source !== payer.pubkey ||
    parsed.info.destination !== payment.recipient ||
    !Number.isSafeInteger(parsed.info.lamports) ||
    String(parsed.info.lamports) !== payment.lamports ||
    memo.programId !== MEMO_PROGRAM ||
    memo.parsed !== `crypto_gateway:${payment.id}`
  )
    return reject();
  const index = keys.findIndex((key) => key.pubkey === payment.recipient);
  if (
    !Array.isArray(tx.meta.preBalances) ||
    !Array.isArray(tx.meta.postBalances)
  )
    return reject();
  const before = tx.meta.preBalances[index];
  const after = tx.meta.postBalances[index];
  if (
    !Number.isSafeInteger(before) ||
    !Number.isSafeInteger(after) ||
    before < 0 ||
    after < 0 ||
    BigInt(after) - BigInt(before) !== BigInt(payment.lamports)
  )
    return reject();
  return payer.pubkey;
}
