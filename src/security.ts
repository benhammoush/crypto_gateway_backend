/**
 * Credential hashing, authentication and bounded request parsing.
 * @packageDocumentation
 */

import { PublicError } from "./types";

const encoder = new TextEncoder();

/** Fixed-size digest comparison; do not compare raw credentials. */
export function equal(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

/** Hash input text for stable request or credential comparison. */
export async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Authenticate text with the supplied secret rather than exposing the secret itself. */
export async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

/** Encode raw digest bytes as lowercase hexadecimal. */
function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Decode base58 to validate exact key/signature byte lengths, not just a regex. */
export function base58Length(value: string): number {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (!value || value.length > 100) return -1;
  let number = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return -1;
    number = number * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (number > 0n) {
    bytes++;
    number >>= 8n;
  }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0);
}

/** Extract the bearer credential or raise the controlled authentication failure. */
export function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(header);
  if (!match)
    throw new PublicError(
      "UNAUTHORIZED",
      "A valid bearer credential is required.",
      401,
    );
  return match[1];
}

/** Bound the streamed body as well as Content-Length. */
export async function jsonBody(
  request: Pick<Request, "headers" | "body">,
): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new PublicError("INVALID_REQUEST", "Use application/json.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader)
    throw new PublicError("INVALID_REQUEST", "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) {
      await reader.cancel();
      throw new PublicError(
        "BODY_TOO_LARGE",
        "Request body is too large.",
        413,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new PublicError("INVALID_REQUEST", "A JSON object is required.");
  }
}
