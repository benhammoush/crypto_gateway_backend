/** Explicit-target operator provisioning; no public administrative HTTP endpoint.
 * @packageDocumentation
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  encryptWebhookSecret,
  decryptWebhookSecret,
  merchantKeyring,
} from '../src/merchant-crypto.ts';
import { validateMerchant, webhookHosts } from '../src/merchants.ts';
import type { MerchantRecord } from '../src/merchants.ts';
import { sha256 } from '../src/security.ts';

/** Fixed operations; profile patches cannot directly change keys, status or audit fields. */
type Operation =
  'add' | 'update' | 'disable' | 'enable' | 'rotate-key' | 'reencrypt';
/** Parameterized transport shared by the hosted API and local Wrangler adapter. */
export type Query = (
  sql: string,
  params: (string | number | null)[],
) => Promise<{ results: MerchantRecord[]; changes: number }>;
/** Explicit target and optimistic version selected by the operator. */
export interface MerchantOperation {
  environment: 'local' | 'dev' | 'production';
  operation: Operation;
  id: string;
  operator: string;
  revision: number;
  confirm: string;
}

/** Private operator encryption inputs; no defaults or credential discovery. */
interface OperatorSecrets {
  keys?: string;
  hosts?: string;
}
/** Fixed provider query body with parameter binding. */
interface QueryBody {
  sql: string;
  params: (string | number | null)[];
}

const profileFields = [
  'name',
  'legal_name',
  'email',
  'phone',
  'country_code',
  'recipient',
  'webhook_url',
  'webhook_secret',
] as const;

/** Build and apply one guarded mutation; D1 triggers atomically retain its value-free audit entry.
 * @param query - Explicitly selected target transport, never a silent remote fallback.
 * @param options - Operation identity, confirmation and expected revision.
 * @param input - Private profile patch from stdin, not process arguments.
 * @param secrets - Runtime keyring and approved hosts supplied through the operator environment.
 * @returns Nonsecret revision summary and, for credential creation/rotation only, the one-time key.
 */
export async function provisionMerchant(
  query: Query,
  options: MerchantOperation,
  input: Record<string, unknown>,
  secrets: OperatorSecrets,
) {
  const { environment, operation, id, operator, revision } = options;
  if (
    !['local', 'dev', 'production'].includes(environment) ||
    !['add', 'update', 'disable', 'enable', 'rotate-key', 'reencrypt'].includes(
      operation,
    ) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
    !/^[A-Za-z0-9_.@-]{1,100}$/.test(operator) ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    options.confirm !== `${environment}:${id}:${operation}:${revision}`
  )
    throw new Error('Invalid operation or confirmation.');
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !profileFields.includes(key as (typeof profileFields)[number]),
    ) ||
    Object.values(input).some(
      (value) => value !== null && typeof value !== 'string',
    ) ||
    (!['add', 'update'].includes(operation) && Object.keys(input).length)
  )
    throw new Error('Invalid profile input.');
  const existing = (await query('SELECT * FROM merchants WHERE id = ?', [id]))
    .results[0];
  if (
    (operation === 'add' && (existing || revision !== 0)) ||
    (operation !== 'add' && (!existing || existing.revision !== revision))
  )
    throw new Error(
      'Merchant is absent, already exists, or its revision changed.',
    );
  const now = Date.now();
  const next: MerchantRecord = existing
    ? { ...existing }
    : {
        id,
        name: '',
        legal_name: null,
        email: null,
        phone: null,
        country_code: null,
        recipient: '',
        api_key_hash: '',
        webhook_url: null,
        webhook_secret_encrypted: null,
        status: 'active',
        revision: 0,
        created_at: now,
        updated_at: now,
        updated_by: operator,
      };
  for (const field of profileFields) {
    if (field !== 'webhook_secret' && Object.hasOwn(input, field)) {
      const value = input[field];
      if (field === 'name' || field === 'recipient') {
        if (typeof value !== 'string')
          throw new Error('Name and recipient are required.');
        next[field] = value;
      } else next[field] = value as string | null;
    }
  }
  let apiKey: string | undefined;
  if (operation === 'add' || operation === 'rotate-key') {
    apiKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    next.api_key_hash = await sha256(apiKey);
  }
  if (operation === 'disable') next.status = 'disabled';
  if (operation === 'enable') next.status = 'active';
  if (Object.hasOwn(input, 'webhook_secret')) {
    const secret = input.webhook_secret;
    next.webhook_secret_encrypted =
      secret === null
        ? null
        : await encryptWebhookSecret(
            merchantKeyring(secrets.keys),
            environment,
            id,
            secret as string,
          );
  }
  if (!next.webhook_url) {
    if (input.webhook_secret) throw new Error('A webhook secret needs a URL.');
    next.webhook_secret_encrypted = null;
  }
  if (
    next.webhook_url &&
    existing?.webhook_url !== next.webhook_url &&
    !input.webhook_secret
  )
    throw new Error(
      'A changed webhook destination requires an explicit signing secret.',
    );
  if (operation === 'reencrypt') {
    if (!next.webhook_secret_encrypted)
      throw new Error('Merchant has no webhook secret.');
    const ring = merchantKeyring(secrets.keys);
    next.webhook_secret_encrypted = await encryptWebhookSecret(
      ring,
      environment,
      id,
      await decryptWebhookSecret(
        ring,
        environment,
        id,
        next.webhook_secret_encrypted,
      ),
    );
  }
  next.updated_at = now;
  next.updated_by = operator;
  next.revision = revision + 1;
  validateMerchant(next, webhookHosts(secrets.hosts));
  const fields = [
    'name',
    'legal_name',
    'email',
    'phone',
    'country_code',
    'api_key_hash',
    'recipient',
    'webhook_url',
    'webhook_secret_encrypted',
    'status',
    'revision',
    'created_at',
    'updated_at',
    'updated_by',
  ] as const;
  const values = fields.map((field) => next[field]);
  const result =
    operation === 'add'
      ? await query(
          `INSERT INTO merchants (id, ${fields.join(', ')}) VALUES (?, ${fields.map(() => '?').join(', ')}) RETURNING id, revision`,
          [id, ...values],
        )
      : await query(
          `UPDATE merchants SET ${fields.map((field) => `${field} = ?`).join(', ')} WHERE id = ? AND revision = ? RETURNING id, revision`,
          [...values, id, revision],
        );
  // D1 change metrics include audit-trigger writes; RETURNING identifies the one guarded merchant write.
  if (
    result.results.length !== 1 ||
    result.results[0].id !== id ||
    result.results[0].revision !== next.revision
  )
    throw new Error(
      'Merchant changed concurrently; inspect before another operation.',
    );
  return {
    id,
    revision: next.revision,
    status: next.status,
    ...(apiKey ? { apiKey } : {}),
  };
}

/** Read bounded provider JSON; never surface response bodies or parser exceptions.
 * @param url - Fixed provider URL derived from validated target IDs.
 * @param token - Explicit operator credential from the process environment.
 * @param body - Optional parameterized D1 query.
 * @returns Provider envelope after transport validation.
 */
async function provider(
  url: string,
  token: string,
  body?: QueryBody,
): Promise<{ success: boolean; result: unknown }> {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok || !response.body)
    throw new Error('D1 operation failed; inspect target before retrying.');
  const reader = response.body.getReader();
  let text = '';
  let size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262_144) throw new Error('D1 response exceeded limit.');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const parsed = JSON.parse(text) as { success: boolean; result: unknown };
    if (parsed.success !== true) throw new Error();
    return parsed;
  } finally {
    await reader.cancel();
  }
}

/** Execute one local parameterized operation through the installed Wrangler, with private temporary SQL.
 * @param sql - Fixed provisioning SQL.
 * @param params - Validated values, escaped as SQL literals rather than shell arguments.
 * @returns Local D1 rows and direct change count, omitting Wrangler output.
 */
function localQuery(sql: string, params: (string | number | null)[]) {
  let index = 0;
  const rendered = sql.replace(/\?/g, () => {
    const value = params[index++];
    return value === null
      ? 'NULL'
      : typeof value === 'number'
        ? String(value)
        : `'${value.replaceAll("'", "''")}'`;
  });
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const directory = mkdtempSync(join(tmpdir(), 'gateway-merchant-'));
  try {
    const path = join(directory, 'query.sql');
    writeFileSync(path, rendered, { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/wrangler/bin/wrangler.js'),
        'd1',
        'execute',
        'DB',
        '--local',
        '--config',
        join(root, 'wrangler.toml'),
        '--file',
        path,
        '--json',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 524_288,
        windowsHide: true,
      },
    );
    if (result.status !== 0)
      throw new Error('Local D1 operation failed; inspect before retrying.');
    const rows = JSON.parse(result.stdout) as {
      results: MerchantRecord[];
      meta: { changes: number };
    }[];
    return Promise.resolve({
      results: rows[0].results,
      changes: rows[0].meta.changes,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Run an explicitly confirmed operator command; no implicit credential discovery or retries.
 * @returns Completion after exactly one provisioning operation.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      environment: { type: 'string' },
      operation: { type: 'string' },
      id: { type: 'string' },
      operator: { type: 'string' },
      revision: { type: 'string' },
      confirm: { type: 'string' },
      account: { type: 'string' },
      database: { type: 'string' },
      'confirm-target': { type: 'string' },
    },
  });
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (new TextEncoder().encode(input).byteLength > 16_384)
      throw new Error('Profile input exceeds limit.');
  }
  const options: MerchantOperation = {
    environment: values.environment as MerchantOperation['environment'],
    operation: values.operation as Operation,
    id: values.id ?? '',
    operator: values.operator ?? '',
    revision: values.revision === undefined ? -1 : Number(values.revision),
    confirm: values.confirm ?? '',
  };
  let query: Query;
  if (options.environment === 'local') {
    if (values.account || values.database || values['confirm-target'])
      throw new Error('Local mode rejects hosted target flags.');
    query = localQuery;
  } else {
    if (
      !['dev', 'production'].includes(options.environment) ||
      !/^[a-f0-9]{32}$/.test(values.account ?? '') ||
      !/^[a-f0-9-]{36}$/.test(values.database ?? '') ||
      values['confirm-target'] !==
        `${options.environment}:${values.account}:${values.database}` ||
      !process.env.CLOUDFLARE_API_TOKEN
    )
      throw new Error('Explicit hosted target and confirmation required.');
    const base = `https://api.cloudflare.com/client/v4/accounts/${values.account}/d1/database/${values.database}`;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const metadata = (await provider(base, token)).result as {
      uuid: string;
      name: string;
    };
    if (
      metadata.uuid !== values.database ||
      metadata.name !== `crypto-gateway-${options.environment}`
    )
      throw new Error('Hosted database identity mismatch.');
    query = async (sql, params) => {
      const response = await provider(`${base}/query`, token, { sql, params });
      const results = response.result as {
        success: boolean;
        results: MerchantRecord[];
        meta: { changes: number };
      }[];
      if (results.length !== 1 || results[0].success !== true)
        throw new Error('D1 operation uncertain; inspect before retrying.');
      return { results: results[0].results, changes: results[0].meta.changes };
    };
  }
  const result = await provisionMerchant(
    query,
    options,
    JSON.parse(input || '{}') as Record<string, unknown>,
    {
      keys: process.env.MERCHANT_ENCRYPTION_KEYS,
      hosts: process.env.WEBHOOK_HOSTS,
    },
  );
  // The original API key is deliberately returned once to the operator, never to audit records.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    process.stderr.write(
      'Merchant operation failed or is uncertain. Inspect the selected target before another mutation. No raw diagnostics are printed.\n',
    );
    process.exitCode = 1;
  });
}
