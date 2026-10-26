/** Authenticated, versioned webhook-secret encryption shared by Worker and operator tool.
 * @packageDocumentation
 */

/** Separate runtime keyring; key IDs permit incremental encryption-key rotation. */
export interface MerchantKeyring {
  active: string;
  keys: Record<string, string>;
}

/** Validate a bounded JSON keyring of 256-bit hex keys without retaining raw errors.
 * @param value - Runtime secret, never a public configuration variable.
 * @returns Validated key identifiers and material.
 */
export function merchantKeyring(value: string | undefined): MerchantKeyring {
  try {
    if (!value || value.length > 4096) throw new Error();
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') throw new Error();
    const ring = parsed as MerchantKeyring;
    if (!ring.keys || typeof ring.keys !== 'object' || Array.isArray(ring.keys))
      throw new Error();
    const entries = Object.entries(ring.keys);
    if (
      entries.length < 1 ||
      entries.length > 10 ||
      !entries.every(
        ([id, key]) =>
          /^[A-Za-z0-9_-]{1,32}$/.test(id) &&
          typeof key === 'string' &&
          /^[a-f0-9]{64}$/.test(key),
      ) ||
      typeof ring.active !== 'string' ||
      !Object.hasOwn(ring.keys, ring.active)
    )
      throw new Error();
    return { active: ring.active, keys: Object.fromEntries(entries) };
  } catch {
    throw new Error('Merchant encryption keyring is invalid.');
  }
}

/** Decode canonical hexadecimal key or envelope data.
 * @param text - Lowercase hexadecimal bytes.
 * @returns Fresh byte array.
 */
function unhex(text: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-f0-9]{2})+$/.test(text))
    throw new Error('Invalid encrypted secret.');
  return Uint8Array.from(text.match(/../g)!, (pair) => parseInt(pair, 16));
}

/** Encode bytes without Node-specific globals.
 * @param bytes - Bytes to encode.
 * @returns Canonical lowercase hexadecimal.
 */
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/** Bind ciphertext to format, key ID, environment and merchant so records cannot be swapped.
 * @param environment - Isolated gateway environment.
 * @param id - Stable merchant identity.
 * @param keyId - Encryption key identifier.
 * @returns Authenticated metadata, not secret material.
 */
function context(
  environment: string,
  id: string,
  keyId: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify(['webhook-secret', 1, environment, id, keyId]),
  );
}

/** Encrypt a webhook signing secret with a new 96-bit nonce and 128-bit GCM tag.
 * @param ring - Validated keyring.
 * @param environment - Target environment, bound into authentication metadata.
 * @param id - Merchant that owns this secret.
 * @param secret - Plaintext signing secret; never log or persist it.
 * @returns Versioned authenticated ciphertext for D1 storage.
 */
export async function encryptWebhookSecret(
  ring: MerchantKeyring,
  environment: string,
  id: string,
  secret: string,
): Promise<string> {
  if (secret.length < 32 || secret.length > 512)
    throw new Error('Webhook secret must contain 32 to 512 characters.');
  const key = await crypto.subtle.importKey(
    'raw',
    unhex(ring.keys[ring.active]),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: context(environment, id, ring.active),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(secret),
  );
  return `v1:${ring.active}:${hex(iv)}:${hex(new Uint8Array(ciphertext))}`;
}

/** Authenticate and decrypt only the expected merchant/environment envelope; fail closed.
 * @param ring - Keyring retaining keys still referenced by stored ciphertext.
 * @param environment - Expected isolated environment.
 * @param id - Expected merchant identity.
 * @param envelope - Bounded versioned ciphertext from D1.
 * @returns Plaintext used only for signing a delivery or immediate re-encryption.
 */
export async function decryptWebhookSecret(
  ring: MerchantKeyring,
  environment: string,
  id: string,
  envelope: string,
): Promise<string> {
  try {
    if (typeof envelope !== 'string' || envelope.length > 5000)
      throw new Error();
    const parts = envelope.split(':');
    const [version, keyId, nonce, ciphertext] = parts;
    if (
      parts.length !== 4 ||
      version !== 'v1' ||
      !Object.hasOwn(ring.keys, keyId) ||
      !/^[a-f0-9]{24}$/.test(nonce)
    )
      throw new Error();
    const key = await crypto.subtle.importKey(
      'raw',
      unhex(ring.keys[keyId]),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const result = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: unhex(nonce),
        additionalData: context(environment, id, keyId),
        tagLength: 128,
      },
      key,
      unhex(ciphertext),
    );
    const secret = new TextDecoder('utf-8', { fatal: true }).decode(result);
    if (secret.length < 32 || secret.length > 512) throw new Error();
    return secret;
  } catch {
    throw new Error('Webhook secret could not be decrypted.');
  }
}
