/**
 * @fileoverview Shared fixture helpers for the upstream disposition-ledger
 * tests. Consolidated here (arch:drift duplication cleanup) —
 * `upstream-ledger-store-stamp.test.mjs` and `upstream-reconcile-apply.test.mjs`
 * each had their own identical copy of all three.
 *
 * @module tests/helpers/upstream-ledger-test-utils
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DISPOSITION_LEDGER_PATH } from '../../scripts/lib/upstream/commands.mjs';

/**
 * Run git, returning the full spawnSync result (caller reads .stdout/.status
 * as needed). Every setup command is CHECKED (code-audit R1 L2) — an ignored
 * spawnSync result means a failed `git init` or a failed seed commit produces
 * a fixture that is not what the test claims to be testing, and the
 * assertions then pass or fail for a reason no one can see.
 */
export function g(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) assert.fail(`git ${args.join(' ')} could not run: ${r.error.message}`);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r;
}

/** A deterministic, sortable fake UUID for fixture rows. */
export const uuid = (n) => `aaaaaaaa-1111-2222-3333-4444444444${String(n).padStart(2, '0')}`;

/** Read a fixture repo's disposition ledger entries. */
export const readLedger = (dir) => JSON.parse(fs.readFileSync(path.join(dir, DISPOSITION_LEDGER_PATH), 'utf-8')).entries;
