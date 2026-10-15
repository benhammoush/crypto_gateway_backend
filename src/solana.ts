import { Payment, PublicError } from "./types";

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

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
      instructions: { programId: string; parsed?: unknown }[];
    };
  };
}

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

export async function assertDevnet(url: string): Promise<void> {
  if ((await rpc<string>(url, "getGenesisHash")) !== DEVNET_GENESIS) {
    throw new PublicError(
      "WRONG_NETWORK",
      "Payment processing requires Solana Devnet.",
      503,
    );
  }
}

/** Verify only the supported checkout format: one top-level transfer and one memo. */
export function validateTransfer(
  tx: ParsedTransaction,
  signature: string,
  payment: Payment,
): string {
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
  if (!Array.isArray(instructions) || instructions.length !== 2)
    return reject();
  const [transfer, memo] = instructions;
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
