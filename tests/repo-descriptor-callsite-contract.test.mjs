/**
 * Contract: `getRepoIdByUuid` returns a repo DESCRIPTOR, not an id.
 *
 * The name says "getRepoId", the return is
 * `{id, name, activeRefreshId, activeEmbeddingModel, activeEmbeddingDim}`.
 * Every consumer must dereference `.id` before the value reaches a `uuid`
 * column or another repo-scoped API.
 *
 * Why a STATIC test and not a runtime one: the failure is silent-by-
 * construction. `recordRegressionSpec`'s only repo guard is `if (!repoId)`,
 * and an object is truthy — so the descriptor sails past the guard, reaches
 * the `repo_id uuid` column, and Postgres raises 22P02
 * (`invalid input syntax for type uuid: "{"id":"…","name":"…"}"`). That
 * throw is caught, logged to stderr, and turned into `return null`. The
 * canary still exits 0 and reads green. Nothing in a runtime suite observes
 * it without a live DB, which is exactly how it survived from 2026-05-20 to
 * 2026-08-11 (~12 weeks) and got mis-diagnosed downstream as "the feature has
 * zero adoption" — a broken writer and an unused feature produce the same
 * empty table.
 *
 * Reported by Lbstrydom/wine-cellar-app, 2026-08-11 (unfiled defect 2
 * alongside upstream report d6849e0b).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Source roots that may call the accessor. Tests are exempt (they stub it). */
const SCAN_DIRS = ['scripts'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Find `<lhs> = await getRepoIdByUuid(...)` assignments whose left-hand side
 * is an id-shaped name. `repo = await getRepoIdByUuid(...)` is correct usage
 * (the caller then reads `repo.id`); `repoId = await getRepoIdByUuid(...)` is
 * the defect — the name asserts a uuid and the value is an object.
 */
const ID_SHAPED_LHS = /(?:^|[^.\w])(\w*[rR]epoId|\w*repo_id|id)\s*=\s*await\s+(?:d\.)?getRepoIdByUuid\s*\(/;

/** Direct `.id` dereference on the call — always correct. */
const DEREFERENCED = /getRepoIdByUuid\s*\([^)]*\)\s*(?:\.catch\([^)]*\)\s*)?\)?\s*\??\.id\b/;

describe('getRepoIdByUuid call-site contract', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(REPO_ROOT, d)));

  it('subject probe: the scan actually reaches call sites', () => {
    const withCalls = files.filter((f) =>
      /getRepoIdByUuid\s*\(/.test(fs.readFileSync(f, 'utf8')));
    assert.ok(
      withCalls.length >= 5,
      `expected the accessor to have several call sites; found ${withCalls.length}. `
      + 'A near-zero count means the scan is broken, not that the repo is clean.',
    );
  });

  it('negative control: an id-shaped assignment is recognised as a violation', () => {
    assert.match('    let repoId = await getRepoIdByUuid(uuid);', ID_SHAPED_LHS);
    assert.doesNotMatch('    const repo = await getRepoIdByUuid(uuid);', ID_SHAPED_LHS);
  });

  it('no call site assigns the descriptor to an id-shaped variable', () => {
    const violations = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/getRepoIdByUuid\s*\(/.test(line)) return;
        if (DEREFERENCED.test(line)) return;
        if (ID_SHAPED_LHS.test(line)) {
          violations.push(`${path.relative(REPO_ROOT, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      violations, [],
      'getRepoIdByUuid returns {id, name, …} — assign it to `repo` and pass `repo.id`, '
      + 'or dereference inline with `?.id`. Passing the descriptor to a uuid column '
      + `raises 22P02 into a swallowed catch.\n${violations.join('\n')}`,
    );
  });
});
