/**
 * @fileoverview `mergeScopeFiles` — a changed file the plan never mentions must
 * still be audited.
 *
 * The defect this pins: `--files` / `--scope diff` were only ever a FILTER over
 * `extractPlanPaths(...).found`, and every pass intersected the two
 * (`found.filter(f => fileFilter.some(...))`). A file could therefore be passed
 * in `--changed` AND `--files` and be read by no pass at all, because the plan
 * document did not name it.
 *
 * Measured 2026-08-09: `scripts/lib/audit/duplication-detector.mjs` was changed
 * and in scope for 15 consecutive rounds of its own audit and appeared in ZERO
 * rounds' `code_files`. The audit could not see its own blind spot — the shadow
 * reviewer found it.
 *
 * The degenerate case is the dangerous one: if the plan references none of the
 * changed files, the intersection is EMPTY, every pass runs on nothing, and the
 * audit still returns a verdict.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mergeScopeFiles, resolveReferenceExtension } from '../scripts/lib/plan-paths.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

// Real repo-relative paths — mergeScopeFiles requires existence on disk, so
// fabricated names would be rejected for the wrong reason and the test would
// pass vacuously.
const PLAN_FILE = 'scripts/symbol-index/extract.mjs';
const CHANGED_NOT_PLANNED = 'scripts/lib/audit/duplication-detector.mjs';

describe('mergeScopeFiles — changed-but-not-plan-referenced files', () => {
  before(() => {
    // Guard: if these move, every assertion below would be testing rejection
    // for non-existence rather than the merge behaviour.
    for (const p of [PLAN_FILE, CHANGED_NOT_PLANNED]) {
      assert.ok(fs.existsSync(path.resolve(REPO_ROOT, p)), `fixture path must exist: ${p}`);
    }
  });

  it('adds a scope file the plan never referenced', () => {
    const { files, addedFromScope } = mergeScopeFiles([PLAN_FILE], [PLAN_FILE, CHANGED_NOT_PLANNED]);
    assert.deepEqual(addedFromScope, [CHANGED_NOT_PLANNED]);
    assert.ok(files.includes(CHANGED_NOT_PLANNED), 'the changed file must be auditable');
    assert.ok(files.includes(PLAN_FILE), 'plan files must survive the merge');
  });

  it('covers the degenerate case: a plan referencing NONE of the changed files', () => {
    // Previously this produced an empty intersection — every pass read nothing
    // while the run still returned a verdict.
    const { files, addedFromScope } = mergeScopeFiles([], [CHANGED_NOT_PLANNED]);
    assert.deepEqual(files, [CHANGED_NOT_PLANNED]);
    assert.deepEqual(addedFromScope, [CHANGED_NOT_PLANNED]);
  });

  it('is a no-op without a scope filter (plan-only audits are unchanged)', () => {
    for (const empty of [null, undefined, []]) {
      const { files, addedFromScope } = mergeScopeFiles([PLAN_FILE], empty);
      assert.deepEqual(files, [PLAN_FILE]);
      assert.deepEqual(addedFromScope, []);
    }
  });

  it('never duplicates a file already referenced by the plan', () => {
    const { files, addedFromScope } = mergeScopeFiles([PLAN_FILE], [PLAN_FILE, './' + PLAN_FILE]);
    assert.deepEqual(files, [PLAN_FILE]);
    assert.deepEqual(addedFromScope, [], 'a ./-prefixed duplicate must normalise, not re-add');
  });

  it('preserves order: plan files first, scope additions appended', () => {
    const { files } = mergeScopeFiles([PLAN_FILE], [CHANGED_NOT_PLANNED]);
    assert.deepEqual(files, [PLAN_FILE, CHANGED_NOT_PLANNED]);
  });

  // ── Admission guards: a scope file may not widen the audit past what a
  //    plan-referenced file could reach ───────────────────────────────────

  it('rejects a file that does not exist on disk', () => {
    const { files, addedFromScope, rejected } = mergeScopeFiles([], ['scripts/does-not-exist.mjs']);
    assert.deepEqual(files, []);
    assert.deepEqual(addedFromScope, []);
    assert.deepEqual(rejected, ['scripts/does-not-exist.mjs']);
  });

  it('rejects a non-source extension', () => {
    const { addedFromScope, rejected } = mergeScopeFiles([], ['package-lock.json.lock', 'foo.bin']);
    assert.deepEqual(addedFromScope, []);
    assert.equal(rejected.length, 2);
  });

  it('rejects node_modules and URLs', () => {
    const { addedFromScope, rejected } = mergeScopeFiles([], ['node_modules/x/index.js', 'https://example.com/a.js']);
    assert.deepEqual(addedFromScope, []);
    assert.equal(rejected.length, 2);
  });

  it('honours the infra-file exclusion, and allowInfraFiles opts back in', () => {
    // openai-audit.mjs is the audit tool's own control plane: excluded from an
    // ordinary audit, admissible for a META plan that changes the tool itself.
    const infra = 'scripts/openai-audit.mjs';
    assert.ok(fs.existsSync(path.resolve(REPO_ROOT, infra)), 'fixture must exist');

    const off = mergeScopeFiles([], [infra]);
    assert.deepEqual(off.addedFromScope, [], 'infra must not enter an ordinary audit via --files');
    assert.deepEqual(off.rejected, [infra]);

    const on = mergeScopeFiles([], [infra], { allowInfraFiles: true });
    assert.deepEqual(on.addedFromScope, [infra], '--allow-infra-scope must still work');
  });

  it('reports rejections rather than dropping them silently', () => {
    // The caller logs `rejected`; returning [] for both admitted and refused
    // would make an unaudited file indistinguishable from an unrequested one.
    const { rejected } = mergeScopeFiles([], ['scripts/does-not-exist.mjs', CHANGED_NOT_PLANNED]);
    assert.deepEqual(rejected, ['scripts/does-not-exist.mjs']);
  });

  // ── Compound (double) extensions: `resolveReferenceExtension` ────────────
  //
  // `index.html.template` is a common wine-cellar-app-shaped source: an HTML
  // template regenerated into a gitignored `index.html` at build time.
  // `path.extname()` / a last-dot split both truncate it to `.template`,
  // which is not a `PLAN_REFERENCE_EXTENSIONS` member, so the file was
  // rejected as 'extension' and never reached the auditor's `--files`
  // allowlist for ANY plan or cluster that touched it.

  it('resolveReferenceExtension recognises a registered compound suffix', () => {
    assert.equal(resolveReferenceExtension('public/index.html.template'), 'html');
    assert.equal(resolveReferenceExtension('INDEX.HTML.TEMPLATE'), 'html', 'case-insensitive');
  });

  it('resolveReferenceExtension still rejects an unregistered double extension', () => {
    // The regression this guards: a general "strip the last segment and
    // retry" rule would also resolve `package-lock.json.lock` to `.json` —
    // see the 'rejects a non-source extension' test above, which pins that
    // file as REJECTED on purpose. Only a literal, explicit compound suffix
    // may be recognised.
    assert.equal(resolveReferenceExtension('package-lock.json.lock'), null);
  });

  it('mergeScopeFiles admits a real double-extension file via --files', () => {
    const templateFixture = path.resolve(REPO_ROOT, 'index.html.template');
    fs.writeFileSync(templateFixture, '<html></html>\n');
    try {
      const { addedFromScope, rejected } = mergeScopeFiles([], ['index.html.template']);
      assert.deepEqual(addedFromScope, ['index.html.template']);
      assert.deepEqual(rejected, []);
    } finally {
      fs.rmSync(templateFixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('package-lock.json.lock-shaped names stay rejected through mergeScopeFiles', () => {
    // Same fixture requirement as the pre-existing 'rejects a non-source
    // extension' test: existence is checked before extension, so a
    // non-existent path would be rejected for the wrong reason.
    const lockFixture = path.resolve(REPO_ROOT, 'package-lock.json.lock');
    fs.writeFileSync(lockFixture, '{}\n');
    try {
      const { addedFromScope, rejected } = mergeScopeFiles([], ['package-lock.json.lock']);
      assert.deepEqual(addedFromScope, []);
      assert.deepEqual(rejected, ['package-lock.json.lock']);
    } finally {
      fs.rmSync(lockFixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
