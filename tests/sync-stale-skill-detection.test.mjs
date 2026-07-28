/**
 * @fileoverview `sync-to-repos.mjs`'s real-time stale `.github/skills/`
 * shadow detection (docs/plans/refactor-skill-governance.md, round-1 H2,
 * corrected across round-2/round-3 — H1/M1/M2 on both the sync-to-repos.mjs
 * seam and the shared check-stale-skill-surface.mjs reader it calls).
 *
 * No existing test covered sync-to-repos.mjs's CLI/write-path behaviour
 * directly before this — tests/sync-inventory-parity.test.mjs covers a
 * different concern (array lock-step between sync-to-repos.mjs and
 * sync-inventory.mjs, not this). Everything here runs against fixture
 * directories under the test's own tmp scratch space — never a live
 * consumer repo, and never a write.
 *
 * **`inspectTargetSkillSurfaces` itself is read-only** (detect, never
 * delete — §2.1). But a detected SHADOW is NOT merely logged: audit-code
 * round-1 H7 found that warn-and-continue let a sync report success while
 * Copilot kept resolving the stale copy — the exact field incident this
 * plan exists to prevent, just relocated to the sync path. `decideShadowFailure`
 * (tested below) is the pure decision `main()`'s per-repo loop consults to
 * fail that repo's sync (non-zero exit, an unmissable error line) on a
 * genuine shadow — an orphan-only result stays advisory. This sentence was
 * previously "only reads + warns," which round-3 audit-code H1 correctly
 * flagged as stale relative to that fix — corrected here.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _internals } from '../scripts/sync-to-repos.mjs';

const { extractLiveSkillNames, inspectTargetSkillSurfaces, decideShadowFailure } = _internals;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeLogger() {
  const warnings = [];
  return { logger: { warn: (msg) => warnings.push(msg) }, warnings };
}

describe('extractLiveSkillNames (round-3 H1)', () => {
  it('projects a mixed bundle files array down to exactly the skill names', () => {
    const files = [
      '.claude/skills/foo/SKILL.md',
      '.claude/skills/foo/references/x.md',
      '.claude/skills/bar/SKILL.md',
      'scripts/foo.mjs',
      'docs/reference/consistency-contract.md',
    ];
    assert.deepEqual(extractLiveSkillNames(files), ['bar', 'foo']);
  });

  it('returns an empty array when nothing matches the .claude/skills/ prefix', () => {
    assert.deepEqual(extractLiveSkillNames(['scripts/foo.mjs', 'AGENTS.md']), []);
  });

  it('de-duplicates repeated names across multiple files', () => {
    const files = ['.claude/skills/foo/SKILL.md', '.claude/skills/foo/examples/a.md', '.claude/skills/foo/examples/b.md'];
    assert.deepEqual(extractLiveSkillNames(files), ['foo']);
  });
});

describe('inspectTargetSkillSurfaces (round-1 H2, round-2 H1/M1/M2, round-3 H1/M1/M2/L1)', () => {
  let tmp;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    tmp = undefined;
  });

  it('a shadowing .github/skills/<name> in desiredLiveNames triggers a warning naming it', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-stale-'));
    fs.mkdirSync(path.join(tmp, '.github', 'skills', 'ship'), { recursive: true });

    const { logger, warnings } = makeLogger();
    const result = inspectTargetSkillSurfaces({
      targetRoot: tmp, desiredLiveNames: ['ship', 'plan'], logger,
    });

    assert.equal(result.shadowed.length, 1);
    assert.equal(result.shadowed[0].name, 'ship');
    assert.ok(warnings.some((w) => w.includes('ship') && w.includes('shadowed')));
  });

  it('a clean target (no .github/skills/) produces no warning and an empty shadowed array', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-stale-'));

    const { logger, warnings } = makeLogger();
    const result = inspectTargetSkillSurfaces({ targetRoot: tmp, desiredLiveNames: ['ship'], logger });

    assert.deepEqual(result.shadowed, []);
    assert.deepEqual(result.orphans, []);
    assert.equal(result.inspectionError, null);
    assert.equal(warnings.length, 0);
  });

  it('round-2 H1 — detects a shadow even when the name is NOT yet on disk under .claude/skills/ (dry-run parity)', () => {
    // desiredLiveNames comes from the bundle's OWN computed set, never a
    // post-write disk read — this is the whole point of the round-2 H1 fix.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-stale-'));
    fs.mkdirSync(path.join(tmp, '.github', 'skills', 'ship'), { recursive: true });
    // Deliberately no .claude/skills/ship on disk at all — simulates
    // --dry-run, or a first-ever push before any write happened.
    assert.equal(fs.existsSync(path.join(tmp, '.claude', 'skills', 'ship')), false);

    const { logger, warnings } = makeLogger();
    const result = inspectTargetSkillSurfaces({ targetRoot: tmp, desiredLiveNames: ['ship'], logger });

    assert.equal(result.shadowed.length, 1, 'detection must not depend on a prior write having happened');
    assert.ok(warnings.some((w) => w.includes('ship')));
  });

  it('round-3 M1 — a non-overlapping stale name produces the distinct orphan warning, not silence', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-stale-'));
    fs.mkdirSync(path.join(tmp, '.github', 'skills', 'plan-backend'), { recursive: true });

    const { logger, warnings } = makeLogger();
    const result = inspectTargetSkillSurfaces({ targetRoot: tmp, desiredLiveNames: ['plan'], logger });

    assert.deepEqual(result.shadowed, []);
    assert.deepEqual(result.orphans, ['plan-backend']);
    assert.ok(warnings.some((w) => w.includes('plan-backend') && w.includes('no live counterpart')));
  });

  it('round-2 M1 / round-3 M2 — an injected unreadable listSurfaceNamesFn produces inspectionError, never a false-clean shadowed:[]', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-stale-'));
    const { logger, warnings } = makeLogger();
    const fakeError = { code: 'EACCES', message: 'permission denied', path: 'X' };

    const result = inspectTargetSkillSurfaces({
      targetRoot: tmp,
      desiredLiveNames: ['ship'],
      logger,
      listSurfaceNamesFn: () => ({ names: null, readable: false, error: fakeError }),
    });

    assert.equal(result.inspectionError, fakeError);
    assert.deepEqual(result.shadowed, [], 'no shadow claim can be made — but this must not read as "verified clean"');
    assert.ok(warnings.some((w) => w.includes('cannot inspect')));
  });

  it('never calls any delete/write fs API (source-text assertion, round-3 M2 — honest about what it proves)', () => {
    // Audit-code round-2 M1 (real bug, fixed): the original regex
    // (`\(\{([\s\S]*?)\n\}`) terminated at the FIRST `\n}`, which for this
    // function's multiline destructured-parameter signature is the
    // parameter list's own closing brace (`}) {`), not the function body —
    // the captured "body" was just the parameter names, so this assertion
    // always trivially passed regardless of what the real body did. Fixed:
    // capture through to the START of the NEXT top-level declaration
    // instead of brace-matching, which correctly reaches the real body.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf8');
    const match = /function inspectTargetSkillSurfaces\(\{[\s\S]*?\n\}\) \{([\s\S]*?)\n(?=function |export const |\/\*\*)/.exec(src);
    assert.ok(match, 'expected to locate the full inspectTargetSkillSurfaces function body');
    const fnBody = match[1];
    assert.ok(fnBody.length > 200, 'sanity check — the captured body must be the real implementation, not just the parameter list');
    // Audit-code round-3 L1: the original list (rmSync/writeFileSync/
    // unlinkSync) covered the obvious delete/write cases but not every
    // mutation-capable fs API a future edit might introduce — broadened to
    // the other synchronous mutation methods a directory/file-removal or
    // rewrite could plausibly use.
    assert.doesNotMatch(
      fnBody,
      /fs\.(rmSync|rmdirSync|unlinkSync|writeFileSync|appendFileSync|renameSync|copyFileSync|chmodSync|truncateSync)\b/,
      'inspectTargetSkillSurfaces must never mutate — detect, never delete, in a repo we do not own (§2.1)',
    );
  });
});

// docs/plans/refactor-skill-governance.md audit-code round-1 H7 (real gap,
// fixed): warn-and-continue let a sync report success while Copilot kept
// resolving the stale copy — the exact field incident (§1.3) this plan
// exists to prevent, just relocated to the sync path. decideShadowFailure
// is the extracted, testable decision main() now consults before deciding
// whether this repo's sync succeeded.
describe('decideShadowFailure (round-1 H7)', () => {
  it('a genuine shadow fails the repo, naming the shadowed skill(s) and the repo', () => {
    const msg = decideShadowFailure({ shadowed: [{ name: 'ship' }, { name: 'plan' }] }, 'wine-cellar-app');
    assert.match(msg, /ship, plan/);
    assert.match(msg, /wine-cellar-app/);
    assert.match(msg, /FAILURE/);
  });

  it('an orphan-only result (no shadow) does not fail the repo — advisory only', () => {
    assert.equal(decideShadowFailure({ shadowed: [] }, 'wine-cellar-app'), null);
  });

  it('Gemini gate round-2 shadow finding #2 (real bug, fixed) — an inspectionError fails the repo too, never a false-clean pass', () => {
    // The bug: checking only shadowed.length treated an UNREADABLE stale
    // surface exactly like a genuinely-clean one, so sync reported SUCCESS
    // for a repo it could not actually verify — the same false-clean class
    // already fixed three times elsewhere in listSurfaceNames.
    const msg = decideShadowFailure(
      { shadowed: [], inspectionError: { code: 'EACCES', message: 'permission denied' } },
      'wine-cellar-app',
    );
    assert.ok(msg, 'an inspection failure must never resolve to "this repo passes"');
    assert.match(msg, /cannot verify/);
    assert.match(msg, /wine-cellar-app/);
    assert.match(msg, /permission denied/);
  });

  it('inspectionError takes priority even if shadowed happens to be non-empty from stale data', () => {
    const msg = decideShadowFailure(
      { shadowed: [{ name: 'stale-from-before-the-error' }], inspectionError: { code: 'EACCES', message: 'permission denied' } },
      'wine-cellar-app',
    );
    assert.match(msg, /cannot verify/, 'the inspection-failure message must win — the shadowed list cannot be trusted once inspection failed');
  });
});

// Audit-code round-3 H1: GPT correctly read this file's own OLD docstring
// ("only reads + warns") as evidence the fix might be incomplete — the
// docstring is now corrected (above), but the underlying concern (is
// decideShadowFailure's result actually WIRED to repoErrors/totalErrors
// inside main()'s per-repo loop, not just correct in isolation?) is real
// and wasn't covered by any test. main() itself isn't exported (it performs
// a real multi-repo sync and calls process.exit) so this pins the wiring
// structurally, the same convention this file's own sibling assertions
// already use for main()-level contracts that have no executable seam.
describe('main() wiring — a decideShadowFailure result actually drives repoErrors/totalErrors', () => {
  it('the per-repo loop calls decideShadowFailure and increments both counters on a truthy result', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf8');
    const block = /const shadowFailure = decideShadowFailure\(inspection, repo\.name\);\s*\n\s*if \(shadowFailure\) \{([\s\S]*?)\n\s*\}/.exec(src);
    assert.ok(block, 'expected main() to call decideShadowFailure(inspection, repo.name) and branch on its result');
    assert.match(block[1], /repoErrors\+\+/, 'a genuine shadow must increment repoErrors');
    assert.match(block[1], /totalErrors\+\+/, 'a genuine shadow must increment totalErrors — the signal the final process.exit(totalErrors > 0 ? 1 : 0) reads');
  });

  it('the final exit code is driven by totalErrors (so a shadow failure is never silently swallowed at the end)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf8');
    assert.match(src, /process\.exit\(totalErrors > 0 \? 1 : 0\)/);
  });
});
