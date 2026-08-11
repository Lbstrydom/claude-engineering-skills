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
    // Orphans carry their surface STRUCTURALLY (not a pre-joined string), so
    // the renderer can group by directory without re-parsing a path.
    assert.deepEqual(result.orphans, [{ surface: '.github/skills', name: 'plan-backend' }]);
    assert.ok(warnings.some((w) => w.includes('plan-backend') && w.includes('.github/skills/')));
  });

  // Regression: the orphan warning hardcoded STALE_SURFACE as the containing
  // directory while each orphan already carried its own surface prefix, so an
  // orphan found in `.agents/skills/` was announced as living in
  // `.github/skills/` — a directory that, in the consumer this fired on, did
  // not exist at all. `decideShadowFailure` had already fixed exactly this for
  // the shadowed message ("the remedy differs by directory"); the orphan
  // message never got the same treatment.
  it('names the surface each orphan was actually read from, never a different one', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-stale-'));
    fs.mkdirSync(path.join(tmp, '.agents', 'skills', 'use-railway'), { recursive: true });
    // `.github/skills/` deliberately does NOT exist — the live shape.
    assert.equal(fs.existsSync(path.join(tmp, '.github', 'skills')), false);

    const { logger, warnings } = makeLogger();
    const result = inspectTargetSkillSurfaces({ targetRoot: tmp, desiredLiveNames: ['plan'], logger });

    assert.deepEqual(result.orphans, [{ surface: '.agents/skills', name: 'use-railway' }]);
    const orphanWarn = warnings.find((w) => w.includes('use-railway'));
    assert.ok(orphanWarn, 'the orphan must still be reported');
    assert.ok(
      orphanWarn.includes('.agents/skills/'),
      `must name the surface it was read from; got: ${orphanWarn}`,
    );
    assert.ok(
      !orphanWarn.includes('.github/skills'),
      `must NOT name a surface the orphan is not in (and which does not exist here); got: ${orphanWarn}`,
    );
    // `.agents/skills/use-railway` is not double-qualified inside another path.
    assert.ok(
      !orphanWarn.includes('.agents/skills/.agents/skills'),
      `must not nest the surface inside itself; got: ${orphanWarn}`,
    );
  });

  it('groups orphans by surface — one warning per directory, each listing only its own', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-stale-'));
    fs.mkdirSync(path.join(tmp, '.github', 'skills', 'gh-only'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.agents', 'skills', 'agents-only'), { recursive: true });

    const { logger, warnings } = makeLogger();
    inspectTargetSkillSurfaces({ targetRoot: tmp, desiredLiveNames: ['plan'], logger });

    const gh = warnings.find((w) => w.includes('gh-only'));
    const ag = warnings.find((w) => w.includes('agents-only'));
    assert.ok(gh && ag, 'both surfaces must be reported');
    assert.notEqual(gh, ag, 'a shared warning cannot name the right directory for both');
    assert.ok(gh.includes('.github/skills/') && !gh.includes('agents-only'));
    assert.ok(ag.includes('.agents/skills/') && !ag.includes('gh-only'));
  });

  // The wording, not just the path. `cmp.orphans` means "not a name THIS
  // BUNDLE deploys" — it says nothing about the consumer's own
  // `.claude/skills/`. The old text claimed "with no live counterpart today",
  // which was false in the live case (both orphans DID have one there) and hid
  // the actual hazard: one name in two discovered roots, precedence undefined.
  it('does not claim there is no live counterpart — it cannot know that', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-stale-'));
    fs.mkdirSync(path.join(tmp, '.agents', 'skills', 'use-railway'), { recursive: true });
    // The consumer's OWN copy — exactly the case the old wording denied.
    fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'use-railway'), { recursive: true });

    const { logger, warnings } = makeLogger();
    inspectTargetSkillSurfaces({ targetRoot: tmp, desiredLiveNames: ['plan'], logger });

    const orphanWarn = warnings.find((w) => w.includes('use-railway'));
    assert.ok(
      !orphanWarn.includes('no live counterpart'),
      `a counterpart exists in .claude/skills/; got: ${orphanWarn}`,
    );
    assert.ok(
      orphanWarn.includes('precedence'),
      `the real hazard is undefined precedence between roots; got: ${orphanWarn}`,
    );
  });

  // The consumer case this whole rule exists for, on the SYNC path. A plugin
  // keeps its skill in `.agents/skills/<n>` and exposes it as
  // `.claude/skills/<n>` via a junction: ONE directory, two names, nothing
  // ambiguous. Until 2026-08-10 this warned on every sync, because sync passed
  // no `realPathOf` and the classifier tested ownership before identity — so a
  // non-bundle name could never reach the alias branch. Two of these fired
  // against a real consumer for eleven days.
  it('says nothing at all about a junctioned alias — one directory is not an ambiguity', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-stale-'));
    const target = path.join(tmp, '.agents', 'skills', 'use-railway');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(tmp, '.claude', 'skills'), { recursive: true });
    try {
      fs.symlinkSync(target, path.join(tmp, '.claude', 'skills', 'use-railway'), 'junction');
    } catch {
      return;   // platform forbids links — the alias case cannot arise either
    }

    const { logger, warnings } = makeLogger();
    inspectTargetSkillSurfaces({ targetRoot: tmp, desiredLiveNames: ['plan'], logger });

    assert.deepEqual(
      warnings.filter((w) => w.includes('use-railway')), [],
      'an alias must produce no warning of any kind — not a softened one',
    );
  });

  // Identity is not the only reason a name in two roots is fine, and on most
  // machines it is not even the common one. The `skills` CLI (skills.sh) treats
  // `.agents/skills/` as CANONICAL and fans a COPY out to every agent root the
  // skill was added for — separate directories, so `realpath` differs and the
  // alias rule above cannot help. `skills-lock.json` is that tool's own record.
  //
  // `check-stale-skill-surface.mjs` has honoured the lockfile since 2026-08-09,
  // after an operator followed a "resolve this" note, deleted a copy, and the
  // tool restored it — the lockfile is the source of truth. The sync path never
  // learned: it reimplements orphan reporting and reads no lockfile, so it kept
  // issuing the advice that was already known to be wrong.
  it('honours skills-lock.json — a tool-managed copy is expected, not an ambiguity', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-stale-'));
    // Two genuinely separate directories, exactly as `skills add` fans them out.
    fs.mkdirSync(path.join(tmp, '.agents', 'skills', 'use-railway'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'use-railway'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'skills-lock.json'), JSON.stringify({
      version: 1,
      skills: { 'use-railway': { source: 'railwayapp/railway-skills', sourceType: 'github' } },
    }));

    const { logger, warnings } = makeLogger();
    inspectTargetSkillSurfaces({ targetRoot: tmp, desiredLiveNames: ['plan'], logger });

    const w = warnings.find((x) => x.includes('use-railway')) ?? '';
    assert.ok(
      !/yours to resolve|precedence/.test(w),
      `the lockfile explains this copy; telling the operator to resolve it sends them to break multi-agent access. Got: ${w}`,
    );
  });

  // The companion, so the lockfile rule cannot swallow a real one: a name the
  // lockfile does NOT claim, present as a separate directory in both roots, is
  // still an undefined-precedence ambiguity worth naming.
  it('an unclaimed name in two separate directories still reports undefined precedence', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-stale-'));
    fs.mkdirSync(path.join(tmp, '.agents', 'skills', 'hand-copied'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'hand-copied'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'skills-lock.json'), JSON.stringify({ version: 1, skills: {} }));

    const { logger, warnings } = makeLogger();
    inspectTargetSkillSurfaces({ targetRoot: tmp, desiredLiveNames: ['plan'], logger });

    const w = warnings.find((x) => x.includes('hand-copied')) ?? '';
    assert.match(w, /precedence/, `nothing explains this one; got: ${w}`);
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
    // `surface` is set by inspectTargetSkillSurfaces on every entry — the fixture
    // mirrors the real shape rather than the pre-two-root one.
    const msg = decideShadowFailure({
      shadowed: [{ name: 'ship', surface: '.github/skills' }, { name: 'plan', surface: '.github/skills' }],
    }, 'wine-cellar-app');
    // The message names the SURFACE per shadow — a bare "ship, plan" would have
    // been a wrong instruction half the time once `.agents/skills` joined the set.
    assert.match(msg, /\.github\/skills\/ship, \.github\/skills\/plan/);
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
