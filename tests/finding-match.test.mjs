/**
 * @fileoverview Tier-1 tests for the cross-model finding matcher.
 *
 * Every case here is a defect that was MEASURED on real bake-off data, or an
 * anti-green invariant from plan §2.6. The module is pure, so these are
 * test-first by the repo's doctrine.
 *
 * @module tests/finding-match
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFileRefs, affectedFilesOf, primaryFileOf, sharesFile,
  matchFindings, conserves, signatureOf, affectedLociOf, sectionLociOf,
} from '../scripts/lib/finding-match.mjs';
import { populateFindingMetadata } from '../scripts/lib/ledger.mjs';
import { buildFileReferenceRegex } from '../scripts/lib/language-profiles.mjs';
import { normalizePath } from '../scripts/lib/file-io.mjs';

/** The two real section strings whose hash never matched but whose file did. */
const GEM_SECTION = 'scripts/check-gate-poison-pills.mjs';
const OPUS_SECTION = 'scripts/check-gate-poison-pills.mjs — extractCheckGates()';
/** The reversed multi-file pair, snapshot c63035cbe740. */
const MULTI_A = 'scripts/lib/audit/tiered-shadow-summary.mjs & scripts/lib/audit/tiered-shadow-compare.mjs';
const MULTI_B = 'scripts/lib/audit/tiered-shadow-compare.mjs + scripts/lib/audit/tiered-shadow-summary.mjs';
/** A plan-mode section naming no file at all. */
const PROSE_SECTION = '§0.3 (Activation Addendum) vs §6.1 (Per run)';

const f = (over) => ({ category: 'c', section: 's', detail: 'd', ...over });
const OPTS = { threshold: 0.3, coverageFloor: 0.6 };

describe('extractFileRefs', () => {
  it('pulls the same file out of both real prose forms — the measured defect', () => {
    assert.deepEqual(extractFileRefs(GEM_SECTION), ['scripts/check-gate-poison-pills.mjs']);
    assert.deepEqual(extractFileRefs(OPUS_SECTION), ['scripts/check-gate-poison-pills.mjs']);
  });

  it('returns [] for a section naming no file — NOT a prose fragment', () => {
    // The ledger's legacy fallback yields "§0.3" here. Using that as a grouping
    // key would merge unrelated §-referenced findings — the same bug, relocated.
    assert.deepEqual(extractFileRefs(PROSE_SECTION), []);
  });

  it('extracts every file in a multi-file section, de-duplicated', () => {
    assert.deepEqual(extractFileRefs(MULTI_A), [
      'scripts/lib/audit/tiered-shadow-summary.mjs',
      'scripts/lib/audit/tiered-shadow-compare.mjs',
    ]);
  });

  it('is total on junk input', () => {
    for (const v of [null, undefined, '', 42, {}]) assert.deepEqual(extractFileRefs(v), []);
  });
});

describe('primaryFileOf / affectedFilesOf — reporting vs matching keys', () => {
  it('primaryFileOf is null when nothing is extractable, never a prose fragment', () => {
    assert.equal(primaryFileOf(f({ section: PROSE_SECTION })), null);
  });

  it('primaryFileOf never returns a bogus key even from a stamped _primaryFile', () => {
    // A legacy record may carry _primaryFile: '§0.3' from the ledger fallback.
    assert.equal(primaryFileOf(f({ section: PROSE_SECTION, _primaryFile: '§0.3' })), null);
  });

  it('affectedFilesOf prefers a pre-stamped list but normalises it', () => {
    const r = affectedFilesOf(f({ affectedFiles: ['Scripts/Foo.mjs', 'scripts/foo.mjs'] }));
    assert.deepEqual(r, ['scripts/foo.mjs'], 'case-folded and de-duplicated');
  });

  it('sharesFile is ORDER-INDEPENDENT — the c63035cbe740 pair', () => {
    // primaryFileOf differs for these two (files[0] is positional), which is
    // exactly why matching must not use it.
    assert.notEqual(primaryFileOf(f({ section: MULTI_A })), primaryFileOf(f({ section: MULTI_B })));
    assert.equal(sharesFile(f({ section: MULTI_A }), f({ section: MULTI_B })), true);
  });
});

describe('populateFindingMetadata — the refactor is behaviour-PRESERVING', () => {
  // Phase 1 claimed a pure refactor. This asserts it against a verbatim copy of
  // the pre-refactor implementation, because "I only moved code" is exactly the
  // claim that decays silently. `generateTopicId` folds `_primaryFile` in, so a
  // drift here would shift topicIds and break R2+ ledger suppression repo-wide.
  const original = (finding) => {
    const section = finding.section || '';
    const files = [];
    const re = buildFileReferenceRegex();
    let m;
    while ((m = re.exec(section)) !== null) files.push(normalizePath(m[1]));
    const primary = files[0] || normalizePath(section.split(':')[0].split('(')[0].trim());
    return { primary, affected: files.length > 0 ? files : [primary] };
  };

  const SECTIONS = [
    GEM_SECTION, OPUS_SECTION, MULTI_A, PROSE_SECTION,
    'scripts/gate-contracts/_exemptions.json + scripts/check-gate-poison-pills.mjs (reconcile)',
    'scripts/a.mjs and again scripts/a.mjs',   // duplicate paths — the dedupe trap
    'src/app/main.py:42', '', 'no files at all here',
    './rel.mjs and ../up.mjs and /abs/x.mjs',
  ];

  for (const s of SECTIONS) {
    it(`preserves output for ${JSON.stringify(s.slice(0, 46))}`, () => {
      const want = original({ section: s });
      const got = populateFindingMetadata({ section: s, category: 'c', detail: 'd' }, 'p');
      assert.equal(got._primaryFile, want.primary);
      assert.deepEqual(got.affectedFiles, want.affected);
    });
  }

  it('keeps DUPLICATE paths in affectedFiles — dedupe would be a silent change', () => {
    const got = populateFindingMetadata({ section: 'scripts/a.mjs and again scripts/a.mjs', category: 'c', detail: 'd' }, 'p');
    assert.deepEqual(got.affectedFiles, ['scripts/a.mjs', 'scripts/a.mjs']);
  });
});

describe('matchFindings — the measured defect now matches', () => {
  const gem = f({ _hash: 'aaaa', section: GEM_SECTION, category: 'Logic Error', detail: 'extractCheckGates mis-parses the gate list and undercounts' });
  const opus = f({ _hash: 'bbbb', section: OPUS_SECTION, category: 'Scope-completeness', detail: 'extractCheckGates mis-parses the gate list and undercounts gates' });

  it('pairs them, where the exact hash never could', () => {
    assert.notEqual(gem._hash, opus._hash);
    const r = matchFindings([gem], [opus], OPTS);
    assert.equal(r.both, 1);
    assert.equal(r.shadowOnly, 0);
    assert.deepEqual(r.pairs[0].sharedFiles, ['scripts/check-gate-poison-pills.mjs']);
  });

  it('keeps BOTH hashes and the similarity as evidence', () => {
    const r = matchFindings([gem], [opus], OPTS);
    assert.equal(r.pairs[0].primaryHash, 'aaaa');
    assert.equal(r.pairs[0].shadowHash, 'bbbb');
    assert.ok(r.pairs[0].similarity >= OPTS.threshold);
  });

  it('same file, DISSIMILAR text → stays two uniques (no over-merge)', () => {
    const other = f({ _hash: 'cccc', section: GEM_SECTION, category: 'Perf', detail: 'the regex is recompiled on every call inside a hot loop' });
    const r = matchFindings([gem], [other], { ...OPTS, threshold: 0.9 });
    assert.equal(r.both, 0);
    assert.equal(r.primaryOnly, 1);
    assert.equal(r.shadowOnly, 1);
  });

  it('same text, DIFFERENT files → not a match', () => {
    const a = f({ _hash: 'a1', section: 'scripts/one.mjs', detail: 'identical detail text here' });
    const b = f({ _hash: 'b1', section: 'scripts/two.mjs', detail: 'identical detail text here' });
    assert.equal(matchFindings([a], [b], OPTS).both, 0);
  });

  it('matches a reversed multi-file pair (order-independence, R2/M1)', () => {
    const a = f({ _hash: 'm1', section: MULTI_A, detail: 'the summary and compare paths disagree on the same field' });
    const b = f({ _hash: 'm2', section: MULTI_B, detail: 'the compare and summary paths disagree on the same field' });
    assert.equal(matchFindings([a], [b], OPTS).both, 1);
  });
});

describe('matchFindings — unmatchable is not unique', () => {
  it('a finding with NO locus at all is unmatchable on BOTH sides, never shadowOnly', () => {
    // Invariant 3 unchanged: absence of a comparable key is not evidence of
    // distinctness. What changed (v2) is WHICH findings have no key — a
    // `§`-section is now a locus, so the fixture here is prose naming neither
    // a file nor a section.
    const p = f({ _hash: 'p1', section: 'the retry loop behaves oddly' });
    const s = f({ _hash: 's1', section: 'the retry loop behaves oddly' });
    const r = matchFindings([p], [s], OPTS);
    assert.equal(r.unmatchablePrimary, 1);
    assert.equal(r.unmatchableShadow, 1);
    assert.equal(r.shadowOnly, 0, 'a locus-less finding must never be counted as a unique');
    assert.equal(r.both, 0);
  });

  it('two arms citing the SAME §-section now match — that is the v2 change', () => {
    // Before v2 these were both `unmatchable`, so a plan-mode comparison
    // reported every finding as unique: "unique" meant "total", which is the
    // defect this module exists to fix, surviving in the one place the file
    // key could not reach.
    const p = f({ _hash: 'p1', section: PROSE_SECTION, detail: 'alpha beta gamma' });
    const s = f({ _hash: 's1', section: PROSE_SECTION, detail: 'alpha beta gamma delta' });
    const r = matchFindings([p], [s], OPTS);
    assert.equal(r.both, 1);
    assert.equal(r.unmatchablePrimary, 0);
    assert.equal(r.pairs[0].locusKind, 'section');
    assert.deepEqual(r.pairs[0].sharedFiles, [], 'a section match shares NO files, and says so');
    assert.ok(r.pairs[0].sharedLoci.includes('section:§0.3'));
  });

  it('DIFFERENT sections do not match, however similar the prose', () => {
    const p = f({ _hash: 'p1', section: '§0.3 Activation', detail: 'identical words here' });
    const s = f({ _hash: 's1', section: '§9.9 Something else', detail: 'identical words here' });
    assert.equal(matchFindings([p], [s], OPTS).both, 0, 'the locus must still discriminate');
  });

  it('a section locus NEVER matches a file locus — the two key spaces are disjoint', () => {
    const p = f({ _hash: 'p1', section: '§2 budget', detail: 'same words' });
    const s = f({ _hash: 's1', section: 'scripts/a.mjs', detail: 'same words' });
    assert.equal(matchFindings([p], [s], OPTS).both, 0);
  });

  it('conservation holds on a mixed set', () => {
    const P = [f({ _hash: 'p1', section: GEM_SECTION, detail: 'alpha beta gamma' }),
      f({ _hash: 'p2', section: PROSE_SECTION }),
      f({ _hash: 'p3', section: 'scripts/lonely.mjs', detail: 'nothing like it' })];
    const S = [f({ _hash: 's1', section: OPUS_SECTION, detail: 'alpha beta gamma delta' }),
      f({ _hash: 's2', section: PROSE_SECTION })];
    const r = matchFindings(P, S, OPTS);
    assert.ok(conserves(r, P.length, S.length), JSON.stringify(r));
  });
});

describe('affectedLociOf — a FALLBACK, so file matching is untouched', () => {
  it('a finding that names a file ignores its §-sections entirely', () => {
    // The union alternative would give every code finding a second key space,
    // so two findings sharing no file could match on a stray `§2`. This is the
    // assertion that says it did not happen.
    assert.deepEqual(
      affectedLociOf({ section: 'scripts/a.mjs — see §2 and D7c' }),
      ['scripts/a.mjs'],
    );
  });

  it('only a finding with no file at all falls through to section keys', () => {
    assert.deepEqual(affectedLociOf({ section: '§2 Envelope budget, per D7c' }), ['section:§2', 'section:d7c']);
    assert.deepEqual(affectedLociOf({ section: 'no locus of any kind' }), []);
  });

  it('section keys are normalised and de-duplicated', () => {
    assert.deepEqual(sectionLociOf({ section: '§2 vs §2. and KD-3 and kd-3' }), ['section:§2', 'section:kd-3']);
  });

  it('reads every section-ish field, like affectedFilesOf does for paths', () => {
    assert.deepEqual(sectionLociOf({ primaryFile: '§6b Phase 0' }), ['section:§6b']);
    assert.deepEqual(sectionLociOf({}), []);
    assert.deepEqual(sectionLociOf(null), []);
  });
});

describe('matchFindings — coverage states are three, not two', () => {
  it('no findings on either side → coverage null, verdict not-applicable', () => {
    const r = matchFindings([], [], OPTS);
    assert.equal(r.coverage, null, 'never NaN, never 0, never 1');
    assert.equal(r.verdict, 'not-applicable');
  });

  it('coverage below the floor → verdict unknown, not a clean number', () => {
    // Locus-less prose on both primary entries: neither a path nor a section.
    const P = [f({ _hash: 'p1', section: 'a vague remark' }), f({ _hash: 'p2', section: 'another vague remark' })];
    const S = [f({ _hash: 's1', section: 'scripts/a.mjs', detail: 'x' })];
    const r = matchFindings(P, S, OPTS);
    assert.ok(r.coverage < OPTS.coverageFloor);
    assert.equal(r.verdict, 'unknown');
  });

  it('good coverage → verdict ok', () => {
    const P = [f({ _hash: 'p1', section: 'scripts/a.mjs', detail: 'x' })];
    const S = [f({ _hash: 's1', section: 'scripts/b.mjs', detail: 'y' })];
    assert.equal(matchFindings(P, S, OPTS).verdict, 'ok');
  });
});

describe('decideReRaise — the guard that was silently inert', () => {
  const OPT = { threshold: 0.9, requireSameFile: true };
  const nb = (file) => ({ finding_id: 'n1', cosine: 0.95, primary_file: file });

  it('a PROSE section now resolves and suppresses — the live defect', async () => {
    // Before: normalizePath('scripts/foo.mjs — someFn()') never equalled
    // 'scripts/foo.mjs', so this returned different-file and NOTHING was ever
    // suppressed for such a finding.
    const { decideReRaise } = await import('../scripts/lib/semantic-suppression.mjs');
    const d = decideReRaise({ section: OPUS_SECTION }, nb('scripts/check-gate-poison-pills.mjs'), OPT);
    assert.equal(d.suppress, true, 'a prose section must resolve to its file');
  });

  it('a genuinely different file still does NOT suppress', async () => {
    const { decideReRaise } = await import('../scripts/lib/semantic-suppression.mjs');
    assert.equal(decideReRaise({ section: OPUS_SECTION }, nb('scripts/other.mjs'), OPT).reason, 'different-file');
  });

  it('an unresolvable candidate fails OPEN (keeps the row)', async () => {
    const { decideReRaise } = await import('../scripts/lib/semantic-suppression.mjs');
    assert.equal(decideReRaise({ section: PROSE_SECTION }, nb('scripts/a.mjs'), OPT).suppress, false);
  });

  it('a legacy neighbour with no primary_file fails OPEN', async () => {
    const { decideReRaise } = await import('../scripts/lib/semantic-suppression.mjs');
    for (const v of [null, '', undefined]) {
      assert.equal(decideReRaise({ section: GEM_SECTION }, nb(v), OPT).suppress, false);
    }
  });

  it('a MULTI-FILE candidate matches on membership, not files[0]', async () => {
    // The neighbour stores one file; the candidate names two in the other order.
    const { decideReRaise } = await import('../scripts/lib/semantic-suppression.mjs');
    const d = decideReRaise({ section: MULTI_B }, nb('scripts/lib/audit/tiered-shadow-summary.mjs'), OPT);
    assert.equal(d.suppress, true, 'membership, not positional equality');
  });
});

describe('nearestOpenReRaise — the same-file filter is IN the query', () => {
  // Cluster-A audit H2: `LIMIT 1` ranks repo-wide, so filtering only afterwards
  // lets one high-cosine different-file row shadow every eligible same-file
  // duplicate beneath it. Latent while the guard was inert; live once it works.
  const fakePool = () => { const rec = {}; return { rec, query: async (sql, params) => { rec.sql = sql; rec.params = params; return { rows: [] }; } }; };

  it('binds the candidate file set as a SQL predicate, not a post-filter', async () => {
    const { nearestOpenReRaise } = await import('../scripts/lib/semantic-suppression.mjs');
    const p = fakePool();
    await nearestOpenReRaise({ pool: p, repoId: 'r', embedding: [1, 2], threshold: 0.9, sameFileScope: ['scripts/a.mjs'] });
    assert.match(p.rec.sql, /f\.primary_file = ANY\(\$5::text\[\]\)/);
    assert.deepEqual(p.rec.params[4], ['scripts/a.mjs'], 'a PLAIN array — pgArray() is for the write builders, not a raw WHERE');
  });

  it('unscoped is byte-identical to the pre-change behaviour (param null)', async () => {
    const { nearestOpenReRaise } = await import('../scripts/lib/semantic-suppression.mjs');
    const p = fakePool();
    await nearestOpenReRaise({ pool: p, repoId: 'r', embedding: [1, 2], threshold: 0.9 });
    assert.equal(p.rec.params[4], null, 'requireSameFile:false must not gain a constraint');
  });

  it('an EMPTY scope short-circuits without querying, never matching on an empty array', async () => {
    const { nearestOpenReRaise } = await import('../scripts/lib/semantic-suppression.mjs');
    const p = fakePool();
    assert.equal(await nearestOpenReRaise({ pool: p, repoId: 'r', embedding: [1, 2], threshold: 0.9, sameFileScope: [] }), null);
    assert.equal(p.rec.sql, undefined, 'no query issued for an unresolvable candidate');
  });
});

describe('matchFindings — determinism and one-to-one', () => {
  it('one primary cannot claim two shadows', () => {
    const p = f({ _hash: 'p1', section: 'scripts/a.mjs', detail: 'shared words here' });
    const s1 = f({ _hash: 's1', section: 'scripts/a.mjs', detail: 'shared words here' });
    const s2 = f({ _hash: 's2', section: 'scripts/a.mjs', detail: 'shared words here too' });
    const r = matchFindings([p], [s1, s2], OPTS);
    assert.equal(r.both, 1, 'at most one pair per finding');
    assert.equal(r.shadowOnly, 1);
    assert.ok(conserves(r, 1, 2));
  });

  it('two runs over the same input bucket identically', () => {
    const P = [f({ _hash: 'p1', section: 'scripts/a.mjs', detail: 'aa bb cc' }), f({ _hash: 'p2', section: 'scripts/a.mjs', detail: 'aa bb cc' })];
    const S = [f({ _hash: 's1', section: 'scripts/a.mjs', detail: 'aa bb cc' }), f({ _hash: 's2', section: 'scripts/a.mjs', detail: 'aa bb cc' })];
    assert.deepEqual(matchFindings(P, S, OPTS), matchFindings(P, S, OPTS));
  });

  it('signatureOf matches applyDebtSuppression’s shape', () => {
    assert.equal(signatureOf({ category: 'A', section: 'B', detail: 'C' }), 'A B C');
  });
});

describe('decideReRaise resolves without double-parsing a stored path (Gemini gate)', () => {
  const OPT = { threshold: 0.9, requireSameFile: true };
  const nb = (file) => ({ finding_id: 'n1', cosine: 0.95, primary_file: file });

  it('a BACKSLASH primaryFile resolves — the prose round-trip used to drop it', async () => {
    // String.raw is load-bearing: written with ordinary escapes this literal is
    // `scriptswinc.mjs` (JS has no `\w`/`\c` escape), a different string that
    // would test nothing. That artifact is also what made a first pass at this
    // test report the wrong failure mechanism.
    //
    // The real defect: the prose regex matches forward-slash paths but not
    // backslash ones, so feeding an already-stored path back through it
    // extracted NOTHING and the suppression was silently skipped. normalizePath
    // handles the separator fine — it was the round-trip in front of it that lost.
    const { decideReRaise } = await import('../scripts/lib/semantic-suppression.mjs');
    const stored = String.raw`scripts\win\c.mjs`;
    assert.deepEqual(extractFileRefs(stored), [], 'precondition: the prose parser cannot read this path');
    assert.equal(decideReRaise({ primaryFile: stored }, nb('scripts/win/c.mjs'), OPT).suppress, true,
      'a stored path must resolve regardless of separator');
  });

  it('an explicit affectedFiles array still wins over primaryFile', async () => {
    const { decideReRaise } = await import('../scripts/lib/semantic-suppression.mjs');
    const cand = { affectedFiles: ['scripts/a.mjs', 'scripts/b.mjs'], primaryFile: 'scripts/zzz.mjs' };
    assert.equal(decideReRaise(cand, nb('scripts/b.mjs'), OPT).suppress, true);
  });

  it('prose section is still parsed when no structured field exists', async () => {
    const { decideReRaise } = await import('../scripts/lib/semantic-suppression.mjs');
    assert.equal(decideReRaise({ section: OPUS_SECTION }, nb('scripts/check-gate-poison-pills.mjs'), OPT).suppress, true);
  });
});

describe('greedyReRaiseClusters passes file fields through (Gemini union R2)', () => {
  it('a multi-file finding clusters on its file SET, not just files[0]', async () => {
    // The seam hand-built `{primaryFile: f.primaryFile}`, re-creating §2.6's
    // invariant 1 (positional comparison) and invariant 3 (fields dropped at a
    // rebuilt envelope) in a single line — silently narrowing the very match
    // decideReRaise had just been widened to make.
    const { greedyReRaiseClusters } = await import('../scripts/lib/semantic-suppression.mjs');
    const emb = [1, 0, 0];
    const findings = [
      { id: 'a', createdAt: '2026-01-01', primaryFile: 'scripts/x.mjs', affectedFiles: ['scripts/x.mjs', 'scripts/shared.mjs'], embedding: emb },
      // Its files[0] differs, but the SET intersects on scripts/shared.mjs.
      { id: 'b', createdAt: '2026-01-02', primaryFile: 'scripts/shared.mjs', affectedFiles: ['scripts/shared.mjs'], embedding: emb },
    ];
    const clusters = greedyReRaiseClusters(findings, { threshold: 0.9, requireSameFile: true });
    assert.equal(clusters.length, 1, 'the reword should join the canonical, not start its own cluster');
    assert.equal(clusters[0].duplicates.length, 1);
  });

  it('genuinely disjoint files still form separate clusters', async () => {
    const { greedyReRaiseClusters } = await import('../scripts/lib/semantic-suppression.mjs');
    const emb = [1, 0, 0];
    const clusters = greedyReRaiseClusters([
      { id: 'a', createdAt: '2026-01-01', primaryFile: 'scripts/one.mjs', affectedFiles: ['scripts/one.mjs'], embedding: emb },
      { id: 'b', createdAt: '2026-01-02', primaryFile: 'scripts/two.mjs', affectedFiles: ['scripts/two.mjs'], embedding: emb },
    ], { threshold: 0.9, requireSameFile: true });
    assert.equal(clusters.length, 2, 'widening the key must not merge unrelated files');
  });
});

describe('affectedFilesOf is a UNION — the class fix, not another instance', () => {
  it('unions every source instead of picking one', () => {
    // Four review rounds each found the same shape: some caller chose ONE
    // source and narrowed the key. A union has nothing to choose.
    const r = affectedFilesOf({
      affectedFiles: ['scripts/a.mjs'],
      primaryFile: 'scripts/b.mjs',
      _primaryFile: 'scripts/c.mjs',
      section: 'also scripts/d.mjs',
    });
    assert.deepEqual(r, ['scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs', 'scripts/d.mjs']);
  });

  it('a stored BACKSLASH path resolves from any field', () => {
    const stored = String.raw`scripts\win\c.mjs`;
    assert.deepEqual(affectedFilesOf({ primaryFile: stored }), ['scripts/win/c.mjs']);
    assert.deepEqual(affectedFilesOf({ affectedFiles: [stored] }), ['scripts/win/c.mjs']);
  });

  it('still refuses a prose fragment as a key', () => {
    assert.deepEqual(affectedFilesOf({ _primaryFile: '§0.3', section: PROSE_SECTION }), []);
    assert.equal(primaryFileOf({ _primaryFile: '§0.3', section: PROSE_SECTION }), null);
  });

  it('a candidate with BOTH a primary and a multi-file section keeps both', () => {
    // The precedence chain that used to live in decideReRaise dropped the
    // section's files whenever a primary existed.
    const r = affectedFilesOf({ primaryFile: 'scripts/x.mjs', section: MULTI_A });
    assert.ok(r.includes('scripts/x.mjs'));
    assert.ok(r.includes('scripts/lib/audit/tiered-shadow-compare.mjs'));
  });
});
