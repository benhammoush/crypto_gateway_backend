/** Hash the supplied merchant credential without retaining its plaintext.
 * @file
 */

import { createHash } from 'node:crypto';

// Read from stdin, never CLI arguments (which can appear in process listings).
let input = '';
for await (const chunk of process.stdin) input += chunk;
const key = input.trim();
if (key.length < 32)
  throw new Error(
    'Use a randomly generated credential of at least 32 characters.',
  );
process.stdout.write(`${createHash('sha256').update(key).digest('hex')}\n`);
