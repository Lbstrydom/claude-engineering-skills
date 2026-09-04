/**
 * @fileoverview `scripts/.sync-owned.json` — the committed answer to "is this
 * file mine to fix?".
 *
 * The hole it closes, measured on a live consumer 2026-09-04: git-ignore state
 * covers `scripts/.claude-skills/**` but not `.claude/hooks/**` or
 * `.claude/skills/**` (both COMMITTED there); the content banner covers neither
 * of those (a `SKILL.md` cannot carry one — frontmatter must be the first
 * bytes — and the hooks do not); and `scripts/.sync-manifest.json`, which
 * covers everything, is gitignored on both sides and so absent from CI. That
 * consumer's duplication-policy verifier reported **32 violations and 1
 * mixed-owner triage without the manifest, 31 and 0 with it** — the extra one
 * being this bundle's own `readStdin` cluster across three of its hooks,
 * reported to them as their code to fix.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOwnedSidecar,
  isUpstreamOwned,
  isUsableSidecar,
  OWNED_SIDECAR_VERSION,
  OWNED_SIDECAR_RELATIVE_PATH,
} from '../scripts/lib/sync-owned-sidecar.mjs';
import { createUpstreamOwnershipOracle } from '../scripts/lib/upstream-ownership.mjs';
import { partitionByOwnership } from '../scripts/lib/debt-review-helpers.mjs';

describe('buildOwnedSidecar', () => {
  it('is a committed artifact: two builds of one input are byte-identical', () => {
    // The generated-artifact policy's own test (AGENTS.md category B). The
    // manifest fails it — clock + HEAD sha — which is why this is a separate
    // file rather than an un-gitignoring of that one.
    const input = ['b/y.mjs', 'a/x.mjs', 'scripts/.claude-skills/z.mjs'];
    const one = JSON.stringify(buildOwnedSidecar(input), null, 2);
    const two = JSON.stringify(buildOwnedSidecar([...input].reverse()), null, 2);
    assert.equal(one, two, 'input order must not change the artifact');
    assert.doesNotMatch(one, /\d{4}-\d{2}-\d{2}T/, 'no timestamp may appear in a committed artifact');
  });

  it('normalises separators and de-duplicates', () => {
    const s = buildOwnedSidecar(['a\\b.mjs', 'a/b.mjs', './a/b.mjs']);
    assert.deepEqual(s.paths, ['a/b.mjs']);
  });

  it('records the true case, and declares the comparison as case-insensitive', () => {
    // Six upstream-owned debt entries were classified as a consumer's own work
    // because their ledger said `skill.md` and the manifest said `SKILL.md`.
    const s = buildOwnedSidecar(['.claude/skills/audit-code/SKILL.md']);
    assert.deepEqual(s.paths, ['.claude/skills/audit-code/SKILL.md']);
    assert.equal(s.comparison, 'case-insensitive');
  });

  it('covers the surfaces neither git-ignore state nor a banner can', () => {
    const s = buildOwnedSidecar([
      'scripts/.claude-skills/cross-skill.mjs',
      '.claude/hooks/quickfix-scan.mjs',
      '.claude/skills/audit-code/SKILL.md',
    ]);
    assert.equal(s.paths.length, 3);
    assert.match(s.note, /maintained upstream/);
    assert.match(s.note, /upstream report/i);
  });

  it('ignores junk entries rather than emitting them', () => {
    const s = buildOwnedSidecar([null, '', 42, 'ok.mjs']);
    assert.deepEqual(s.paths, ['ok.mjs']);
    assert.deepEqual(buildOwnedSidecar(null).paths, []);
  });

  it('lands somewhere the managed .gitignore block does not cover', () => {
    // The block ignores `scripts/.sync-manifest.json` by exact path, so a
    // sibling under scripts/ is committable. A rename that collided with an
    // ignore pattern would silently recreate the very hole this closes.
    assert.equal(OWNED_SIDECAR_RELATIVE_PATH, 'scripts/.sync-owned.json');
    assert.notEqual(OWNED_SIDECAR_RELATIVE_PATH, 'scripts/.sync-manifest.json');
  });
});

describe('isUpstreamOwned', () => {
  const sidecar = buildOwnedSidecar(['.claude/skills/audit-code/SKILL.md', 'scripts/.claude-skills/a.mjs']);

  it('matches regardless of case or separator', () => {
    assert.equal(isUpstreamOwned(sidecar, '.claude/skills/audit-code/skill.md'), true);
    assert.equal(isUpstreamOwned(sidecar, '.claude\\skills\\audit-code\\SKILL.md'), true);
  });

  it("does NOT claim a consumer's own file", () => {
    // The direction that must not fire: over-claiming ownership silently
    // excuses a real defect in the consumer's own code.
    assert.equal(isUpstreamOwned(sidecar, 'src/app.ts'), false);
    assert.equal(isUpstreamOwned(sidecar, '.claude/skills/their-own-skill/SKILL.md'), false);
  });

  it('answers false — never throws — on an absent or unknown-version sidecar', () => {
    assert.equal(isUpstreamOwned(null, 'x'), false);
    assert.equal(isUpstreamOwned({ version: OWNED_SIDECAR_VERSION + 1, paths: ['x'] }, 'x'), false);
    assert.equal(isUpstreamOwned(sidecar, ''), false);
  });
});

describe('createUpstreamOwnershipOracle — two sources, unioned', () => {
  const stubIgnored = (paths) => () => ({ paths: new Set(paths), degraded: false, warning: null });
  const degradedGit = () => ({ paths: new Set(), degraded: true, warning: 'no git' });

  it('unions git-ignore state with the sidecar', () => {
    const o = createUpstreamOwnershipOracle('/repo',
      ['scripts/.claude-skills/a.mjs', '.claude/hooks/h.mjs', 'src/mine.ts'], {
        classify: stubIgnored(['scripts/.claude-skills/a.mjs']),
        sidecar: buildOwnedSidecar(['.claude/hooks/h.mjs']),
      });
    assert.equal(o.isUpstreamOwned('scripts/.claude-skills/a.mjs'), true, 'gitignore half');
    assert.equal(o.isUpstreamOwned('.claude/hooks/h.mjs'), true, 'sidecar half');
    assert.equal(o.isUpstreamOwned('src/mine.ts'), false);
    assert.deepEqual(o.sources, ['gitignore', 'sync-sidecar']);
    assert.equal(o.degraded, false);
  });

  it('is not degraded while EITHER source can speak', () => {
    const gitOnly = createUpstreamOwnershipOracle('/repo', ['a'], {
      classify: stubIgnored(['a']), sidecar: null,
    });
    assert.equal(gitOnly.degraded, false);
    const sidecarOnly = createUpstreamOwnershipOracle('/repo', ['a'], {
      classify: degradedGit, sidecar: buildOwnedSidecar(['a']),
    });
    assert.equal(sidecarOnly.degraded, false);
    assert.equal(sidecarOnly.isUpstreamOwned('a'), true);
  });

  it('degrades — and answers false — when NEITHER source can', () => {
    const o = createUpstreamOwnershipOracle('/repo', ['a'], { classify: degradedGit, sidecar: null });
    assert.equal(o.degraded, true);
    assert.equal(o.isUpstreamOwned('a'), false, 'over-claiming would excuse a real local defect');
    assert.deepEqual(o.sources, []);
  });

  it('matches case-insensitively on the gitignore half too', () => {
    // Under the tooling root, which the gitignore half is now scoped to
    // (upstream ad8fcbd3). The old fixture used a bare 'A/B.MJS' — a path that
    // half must no longer claim, so it was asserting the defect.
    const o = createUpstreamOwnershipOracle('/repo', ['scripts/.claude-skills/A/B.MJS'], {
      classify: stubIgnored(['scripts/.claude-skills/A/B.MJS']), sidecar: null,
    });
    assert.equal(o.isUpstreamOwned('scripts/.claude-skills/a/b.mjs'), true);
  });
});

describe('partitionByOwnership', () => {
  const upstream = (p) => p.startsWith('.claude/');
  const entry = (topicId, files) => ({ topicId, severity: 'LOW', affectedFiles: files });

  it('keeps a fully-upstream entry out of ranking but not out of sight', () => {
    const { actionable, upstreamOwned } = partitionByOwnership([
      entry('a', ['.claude/skills/x/SKILL.md']),
      entry('b', ['src/app.ts']),
    ], upstream);
    assert.deepEqual(actionable.map(e => e.topicId), ['b']);
    assert.deepEqual(upstreamOwned.map(e => e.topicId), ['a']);
  });

  it('a MIXED entry stays actionable — part of it can be fixed here', () => {
    const { actionable, upstreamOwned } = partitionByOwnership(
      [entry('m', ['.claude/skills/x/SKILL.md', 'src/app.ts'])], upstream);
    assert.equal(actionable.length, 1);
    assert.equal(upstreamOwned.length, 0);
  });

  it('an entry citing NO file is this repo\u2019s by default', () => {
    // Absence of evidence must not read as "someone else's problem".
    const { actionable } = partitionByOwnership([entry('n', [])], upstream);
    assert.equal(actionable.length, 1);
  });
});

describe('ownership oracle — partial is a THIRD state, not a flavour of clean', () => {
  const gitOk = (paths) => () => ({ paths: new Set(paths), degraded: false, warning: null });
  const gitDead = () => ({ paths: new Set(), degraded: true, warning: 'no git' });

  it('git healthy + NO sidecar is partial, and names what it did not look at', () => {
    // Audit R1 M3. The gitignore half is structurally blind to the committed
    // surfaces the sidecar exists for, so reporting only `degraded:false` told
    // a caller the answer was verified for exactly the paths nothing examined
    // — this change's own defect, one layer up.
    const o = createUpstreamOwnershipOracle('/repo', ['a'], { classify: gitOk(['a']), sidecar: null });
    assert.equal(o.degraded, false);
    assert.equal(o.partial, true);
    assert.ok(o.blindTo.some(s => s.includes('.claude/hooks')));
    assert.ok(o.blindTo.some(s => s.includes('.claude/skills')));
  });

  it('sidecar present + git dead is partial, naming the gitignored half', () => {
    const o = createUpstreamOwnershipOracle('/repo', ['a'], {
      classify: gitDead, sidecar: buildOwnedSidecar(['a']),
    });
    assert.equal(o.degraded, false);
    assert.equal(o.partial, true);
    assert.ok(o.blindTo.some(s => /gitignored/.test(s)));
  });

  it('BOTH sources present is neither partial nor degraded — the direction that must not fire', () => {
    const o = createUpstreamOwnershipOracle('/repo', ['a'], {
      classify: gitOk(['a']), sidecar: buildOwnedSidecar(['b']),
    });
    assert.equal(o.degraded, false);
    assert.equal(o.partial, false);
    assert.deepEqual(o.blindTo, []);
  });

  it('neither source is degraded, and degraded is never ALSO partial', () => {
    const o = createUpstreamOwnershipOracle('/repo', ['a'], { classify: gitDead, sidecar: null });
    assert.equal(o.degraded, true);
    assert.equal(o.partial, false, 'degraded already says nothing was checked');
  });

  it('an unsupported-version sidecar is NOT counted as a source', () => {
    // Audit R1 M13: `isUpstreamOwned` already refused it, so counting it here
    // let a stale sidecar clear `partial` while answering nothing.
    const stale = { ...buildOwnedSidecar(['a']), version: OWNED_SIDECAR_VERSION + 1 };
    const o = createUpstreamOwnershipOracle('/repo', ['a'], { classify: gitOk([]), sidecar: stale });
    assert.deepEqual(o.sources, ['gitignore']);
    assert.equal(o.partial, true);
    assert.equal(o.isUpstreamOwned('a'), false);
  });

  it('a malformed sidecar (no paths array) is NOT counted as a source', () => {
    const o = createUpstreamOwnershipOracle('/repo', ['a'], {
      classify: gitOk([]), sidecar: { version: OWNED_SIDECAR_VERSION, paths: 'nope' },
    });
    assert.deepEqual(o.sources, ['gitignore']);
    assert.equal(o.partial, true);
  });
});

describe('usableSidecar rejects what isUpstreamOwned refuses (audit R2 M1)', () => {
  const gitOk = () => ({ paths: new Set(), degraded: false, warning: null });

  it('a non-string path entry disqualifies the whole sidecar', () => {
    // `isUpstreamOwned` coerces with String(p), so `[42]` would compare as
    // "42" — a malformed committed file counted as live evidence.
    const o = createUpstreamOwnershipOracle('/repo', ['a'], {
      classify: gitOk, sidecar: { version: OWNED_SIDECAR_VERSION, paths: ['ok.mjs', 42] },
    });
    assert.deepEqual(o.sources, ['gitignore']);
    assert.equal(o.partial, true);
    assert.equal(o.isUpstreamOwned('ok.mjs'), false, 'a rejected sidecar answers nothing at all');
  });

  it('an all-string sidecar is still accepted — the direction that must not fire', () => {
    const o = createUpstreamOwnershipOracle('/repo', ['a'], {
      classify: gitOk, sidecar: buildOwnedSidecar(['ok.mjs']),
    });
    assert.ok(o.sources.includes('sync-sidecar'));
    assert.equal(o.isUpstreamOwned('ok.mjs'), true);
  });
});

describe('isUpstreamOwned and usableSidecar agree on a malformed sidecar (audit R3 M6)', () => {
  const malformed = { version: OWNED_SIDECAR_VERSION, paths: [42] };

  it('the direct reader refuses a non-string entry rather than coercing it', () => {
    // `String(42) === '42'` used to match a path literally spelled "42" here,
    // while `usableSidecar` rejected the same document — a direct caller and
    // the oracle disagreeing about one file.
    assert.equal(isUpstreamOwned(malformed, '42'), false);
  });

  it('a well-formed entry still matches — the direction that must not fire', () => {
    assert.equal(isUpstreamOwned(buildOwnedSidecar(['a/b.mjs']), 'a/b.mjs'), true);
  });
});

describe('path comparison normalises BOTH sides (audit R4 M12)', () => {
  it('a stored `./`-prefixed entry matches a bare query', () => {
    // The query side stripped `./` and the stored side did not, so a
    // hand-edited sidecar entry never matched. Normalising one side of a
    // comparison is the recurring shape of this whole change.
    const handEdited = { version: OWNED_SIDECAR_VERSION, paths: ['./a/b.mjs'] };
    assert.equal(isUpstreamOwned(handEdited, 'a/b.mjs'), true);
  });

  it('and a bare stored entry matches a `./`-prefixed query', () => {
    assert.equal(isUpstreamOwned(buildOwnedSidecar(['a/b.mjs']), './a/b.mjs'), true);
  });

  it('still does not match a different path — the direction that must not fire', () => {
    assert.equal(isUpstreamOwned(buildOwnedSidecar(['a/b.mjs']), 'a/c.mjs'), false);
  });
});

describe('isUsableSidecar is the SINGLE validity oracle (audit R5 M3/M14)', () => {
  const gitOk = () => ({ paths: new Set(), degraded: false, warning: null });
  const halfBad = { version: OWNED_SIDECAR_VERSION, paths: ['.claude/hooks/h.mjs', 42] };

  it('a half-malformed paths array is rejected WHOLE, by both entry points', () => {
    // Four rounds of this audit found the same defect in four places because
    // two functions decided validity separately. They now share one.
    assert.equal(isUsableSidecar(halfBad), false);
    assert.equal(isUpstreamOwned(halfBad, '.claude/hooks/h.mjs'), false,
      'reading the entries that happen to parse is how a broken file gives confident partial answers');
    const o = createUpstreamOwnershipOracle('/repo', ['a'], { classify: gitOk, sidecar: halfBad });
    assert.deepEqual(o.sources, ['gitignore']);
    assert.equal(o.partial, true);
  });

  it('agrees with the oracle on every shape', () => {
    const cases = [
      [null, false],
      [{ version: OWNED_SIDECAR_VERSION + 1, paths: ['a'] }, false],
      [{ version: OWNED_SIDECAR_VERSION, paths: 'nope' }, false],
      [{ version: OWNED_SIDECAR_VERSION, paths: [42] }, false],
      [buildOwnedSidecar(['a.mjs']), true],
      [{ version: OWNED_SIDECAR_VERSION, paths: [] }, true],
    ];
    for (const [doc, expected] of cases) {
      assert.equal(isUsableSidecar(doc), expected, JSON.stringify(doc));
      const o = createUpstreamOwnershipOracle('/repo', ['a'], { classify: gitOk, sidecar: doc });
      assert.equal(o.sources.includes('sync-sidecar'), expected,
        `oracle disagreed with isUsableSidecar for ${JSON.stringify(doc)}`);
    }
  });
});

describe('determinism holds for case-equivalent paths too (audit R5 L1)', () => {
  it('input order cannot change which spelling survives', () => {
    // The existing determinism test passed vacuously: its fixture had no
    // case-equivalent pair, so "first spelling wins" was never exercised.
    const a = buildOwnedSidecar(['A/B.mjs', 'a/b.mjs']);
    const b = buildOwnedSidecar(['a/b.mjs', 'A/B.mjs']);
    assert.deepEqual(a.paths, b.paths);
    assert.equal(a.paths.length, 1, 'case-equivalent paths still collapse to one entry');
  });

  it('and the surviving spelling is still matched case-insensitively', () => {
    const s = buildOwnedSidecar(['A/B.mjs', 'a/b.mjs']);
    assert.equal(isUpstreamOwned(s, 'a/b.mjs'), true);
    assert.equal(isUpstreamOwned(s, 'A/B.mjs'), true);
  });
});

describe('BOTH oracle halves reduce through comparisonKey (Gemini final gate)', () => {
  const stubIgnored = (paths) => () => ({ paths: new Set(paths), degraded: false, warning: null });

  it('the gitignore half matches a `./`-prefixed query', () => {
    // Fifth instance of one class, and the last hand-spelled one: the R4 M12
    // fix introduced comparisonKey and applied it to the sidecar half only, so
    // this half still lower-cased without stripping `./`.
    const o = createUpstreamOwnershipOracle('/repo', ['scripts/.claude-skills/src/f.js'], {
      classify: () => ({ paths: new Set(['scripts/.claude-skills/src/f.js']), degraded: false, warning: null }),
      sidecar: null,
    });
    assert.equal(o.isUpstreamOwned('./scripts/.claude-skills/src/f.js'), true);
    assert.equal(o.isUpstreamOwned('scripts/.claude-skills/src/f.js'), true);
    assert.equal(o.isUpstreamOwned('SCRIPTS/.CLAUDE-SKILLS/SRC/F.JS'), true);
  });

  // ── The git-ignore half is scoped (upstream ad8fcbd3) ──────────────────
  //
  // The report's closing line is the load-bearing one: "a fixture built only
  // from bundle paths cannot distinguish the two predicates." Every fixture
  // above IS a bundle path, which is exactly why 35 passing tests never saw
  // this. The rows below use a consumer-owned generated artifact — ignored and
  // untracked, and none of our business.

  it('a gitignored CONSUMER-owned artifact is not upstream-owned', () => {
    // public/index.html, rendered from a TRACKED public/index.html.template and
    // gitignored per the generated-artifact policy. `disowned-paths.mjs` says
    // "not part of the corpus" and that is a true answer to a DIFFERENT
    // question; reading it as ownership told a consumer to file their own
    // build output as our bug. Four of their five false positives were this.
    const o = createUpstreamOwnershipOracle('/repo', ['public/index.html'], {
      classify: stubIgnored(['public/index.html']),
      sidecar: null,
    });
    assert.equal(o.isUpstreamOwned('public/index.html'), false);
  });

  it('a path that does not exist is not upstream-owned either', () => {
    // `git check-ignore` does not require existence, so a stale ledger path
    // was silently classified upstream-owned and left the leverage ranking.
    const o = createUpstreamOwnershipOracle('/repo', ['src/services/credentials/'], {
      classify: stubIgnored(['src/services/credentials/']),
      sidecar: null,
    });
    assert.equal(o.isUpstreamOwned('src/services/credentials/'), false);
  });

  it('the SIDECAR still speaks for paths outside the tooling root', () => {
    // The scoping applies to the git half ONLY. The sidecar is an allowlist and
    // stays authoritative everywhere — it is the only thing that can classify
    // `.claude/hooks/**` and `.claude/skills/**`, which consumers COMMIT.
    // Narrowing both halves would have re-opened the hole the sidecar exists for.
    const o = createUpstreamOwnershipOracle('/repo', ['.claude/hooks/h.mjs'], {
      classify: stubIgnored([]),
      sidecar: buildOwnedSidecar(['.claude/hooks/h.mjs']),
    });
    assert.equal(o.isUpstreamOwned('.claude/hooks/h.mjs'), true);
  });

  it('still claims the tooling root — the case the git half was added for', () => {
    // The direction that must NOT regress: scoping is only correct if it keeps
    // answering true where the heuristic is actually evidence.
    const o = createUpstreamOwnershipOracle('/repo', ['scripts/.claude-skills/lib/x.mjs'], {
      classify: stubIgnored(['scripts/.claude-skills/lib/x.mjs']),
      sidecar: null,
    });
    assert.equal(o.isUpstreamOwned('scripts/.claude-skills/lib/x.mjs'), true);
  });

  it('partitions a consumer artifact into ACTIONABLE, not upstream-owned', () => {
    // End to end, in the shape debt-review consumes: the entry must stay
    // rankable. The consequence being pinned is that two HIGH entries — one
    // about persisting a generated AES key — left the ranking entirely.
    const o = createUpstreamOwnershipOracle('/repo', ['public/index.html'], {
      classify: stubIgnored(['public/index.html']),
      sidecar: null,
    });
    const entries = [
      { id: 'consumer-artifact', affectedFiles: ['public/index.html'] },
      { id: 'real-upstream', affectedFiles: ['scripts/.claude-skills/lib/x.mjs'] },
    ];
    const oUpstream = createUpstreamOwnershipOracle('/repo',
      ['public/index.html', 'scripts/.claude-skills/lib/x.mjs'], {
        classify: stubIgnored(['public/index.html', 'scripts/.claude-skills/lib/x.mjs']),
        sidecar: null,
      });
    const { actionable, upstreamOwned } = partitionByOwnership(entries, oUpstream.isUpstreamOwned);
    assert.deepEqual(actionable.map((e) => e.id), ['consumer-artifact']);
    assert.deepEqual(upstreamOwned.map((e) => e.id), ['real-upstream']);
    assert.equal(o.isUpstreamOwned('public/index.html'), false);
  });

  it('and still does not match a different path', () => {
    const o = createUpstreamOwnershipOracle('/repo', ['scripts/.claude-skills/src/f.js'], {
      classify: () => ({ paths: new Set(['scripts/.claude-skills/src/f.js']), degraded: false, warning: null }),
      sidecar: null,
    });
    assert.equal(o.isUpstreamOwned('scripts/.claude-skills/src/other.js'), false);
  });
});
