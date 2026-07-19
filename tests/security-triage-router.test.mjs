/**
 * Phase 2 — pure router + predicates.
 * Plan: docs/plans/sast-triage-routing.md §9, §7c.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BOUND_DEFAULTS, BUCKETS, TriageReportSchema } from '../scripts/lib/security/sarif.mjs';
import {
  routeFindings,
  selectBucket,
  BUCKET_RESTRICTIVENESS,
} from '../scripts/lib/security/triage-router.mjs';
import {
  maskCommentsAndStrings,
  sanitizerWrapped,
  sinkMismatch,
  pathScope,
  resolveSinkFunction,
  outermostCallIsSanitizer,
  predicateProducerTestSignal,
  PREDICATE_KINDS,
} from '../scripts/lib/security/predicates.mjs';

const CONFIG = {
  version: 1,
  pathScope: { nonReachableGlobs: ['tests/**'] },
  sinkMismatch: { pairs: [{ ruleId: 'javascript/reDOS', sinkFunction: 'caches.match' }] },
  sanitizerWrapped: { sanitizers: ['esc', 'escapeHtml', 'DOMPurify.sanitize'] },
};

let seq = 0;
function routable(over = {}) {
  const {
    p = 'src/a.js',
    cls = 'ok',
    sinkPath = p,
    sinkCls = cls,
    ruleId = 'javascript/DOMXSS',
    source = null,
    region = { startLine: 1, startColumn: null, endLine: 1, endColumn: null },
    sinkRegion = region,
    noSink = false,
    noLocation = false,
  } = over;
  const loc = (pp, cc) => ({
    path: pp,
    region,
    canonicalPath: `/repo/${pp}`,
    repoRelativePath: pp,
    pathClassification: cc,
  });
  return {
    findingId: `f${seq++}`,
    occurrenceIndex: 0,
    ruleId,
    toolName: 'TestTool',
    location: noLocation ? null : loc(p, cls),
    sinkLocation: noSink ? null : { ...loc(sinkPath, sinkCls), region: sinkRegion },
    sinkResolution: noSink ? 'unresolved' : 'codeflow',
    rawLocation: '[]',
    message: 'm',
    messageTruncated: false,
    level: 'warning',
    diagnostics: [],
    _source: source ? source.split('\n') : null,
  };
}

/**
 * Strip the test-only `_source` carrier and hand it to the router as a
 * per-FILE lookup, mirroring how the Phase-3 adapter supplies it.
 */
function route(findings, config = CONFIG) {
  const byPath = new Map();
  const clean = findings.map((f) => {
    const { _source, ...rest } = f;
    const key = rest.sinkLocation?.repoRelativePath;
    if (_source && key) byPath.set(key, _source);
    return rest;
  });
  return routeFindings(clean, config, {
    bounds: BOUND_DEFAULTS,
    getSource: (k) => byPath.get(k) ?? null,
  });
}

/** Predicate-level ctx for the direct (non-router) predicate tests. */
function ctxFor(finding, bounds = BOUND_DEFAULTS) {
  return {
    bounds,
    getSource: (k) =>
      (k === finding.sinkLocation?.repoRelativePath ? finding._source : null),
  };
}

// ---------------------------------------------------------------------------

describe('D1 — predicates route, never delete', () => {
  test('every ingested finding appears in exactly one bucket', () => {
    const input = [
      routable(),
      routable({ p: 'tests/x.js', ruleId: 'javascript/PT/test' }),
      routable({ noLocation: true }),
      routable({ p: 'src/b.js', cls: 'sensitive' }),
    ];
    const r = route(input);
    assert.equal(r.findings.length, input.length);
    assert.equal(r.counts.A + r.counts.C + r.counts.D, input.length);
    assert.equal(new Set(r.findings.map((f) => f.findingId)).size, input.length);
  });

  // §9 item 10 — asserts the unreachable-bucket removal stays removed.
  test('no finding is ever assigned a bucket outside {A,C,D}', () => {
    const r = route([routable(), routable({ p: 'tests/x.js', ruleId: 'javascript/PT/test' })]);
    for (const f of r.findings) assert.ok(BUCKETS.includes(f.bucket), f.bucket);
  });

  // The report schema is what stops render and logic diverging, so it has to
  // actually validate the payload. As `z.array(z.any())` it was a versioned
  // contract incapable of detecting its own breach.
  test('the router output validates against the typed TriageReportSchema', () => {
    const r = route([
      routable(),
      routable({ p: 'tests/x.js', ruleId: 'javascript/PT/test' }),
      routable({ noLocation: true }),
    ]);
    const report = {
      schemaVersion: 1,
      runStatus: 'needs_review',
      exitCode: 3,
      counts: r.counts,
      findings: r.findings,
      unusedPredicates: r.unusedPredicates,
      diagnostics: r.diagnostics,
    };
    const parsed = TriageReportSchema.safeParse(report);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
  });

  test('the report schema REJECTS a finding with a bucket outside {A,C,D}', () => {
    const r = route([routable()]);
    const report = {
      schemaVersion: 1, runStatus: 'needs_review', exitCode: 3, counts: r.counts,
      findings: [{ ...r.findings[0], bucket: 'B' }],
      unusedPredicates: [], diagnostics: [],
    };
    assert.equal(TriageReportSchema.safeParse(report).success, false);
  });

  test('every finding carries a machine-readable reason for each predicate', () => {
    const r = route([routable()]);
    const kinds = r.findings[0].matches.map((m) => m.predicate);
    assert.deepEqual(kinds, [...PREDICATE_KINDS]);
    assert.ok(r.findings[0].matches.every((m) => typeof m.reason === 'string'));
  });

  test('no source content reaches the report — it is unredacted file content', () => {
    const r = route([routable({ source: 'const apiKey = "hunter2-not-a-real-key";' })]);
    const serialized = JSON.stringify(r.findings[0]);
    assert.ok(!serialized.includes('hunter2'), 'source text must not appear anywhere in the report');
    assert.equal('sourceLines' in r.findings[0], false);
    assert.equal('_source' in r.findings[0], false);
  });

  test('a finding whose shape violates the routable contract throws, never mis-routes', () => {
    const bad = routable();
    delete bad.location.pathClassification;
    assert.throws(() => route([bad]), /RoutableFindingSchema/);
  });

  /**
   * The predicate must throw DURING evaluation, after schema validation has
   * already passed. An earlier version of this test made `ruleId` throw via a
   * getter, but `safeParse` reads `ruleId` before any predicate runs — so it
   * asserted schema-parse failure while claiming to cover predicate-exception
   * handling. Vacuous in exactly the way the negative-control doctrine warns
   * about: green, and testing nothing it named.
   *
   * A getter on `nonReachableGlobs` throws only when `pathScope` reaches in.
   */
  test('a predicate that throws mid-evaluation is recorded, and demotes nothing', () => {
    const boobyTrapped = {
      ...CONFIG,
      pathScope: {
        get nonReachableGlobs() { throw new Error('boom'); },
      },
    };
    const f = routable({ p: 'tests/x.js', ruleId: 'javascript/PT/test' });
    const r = route([f], boobyTrapped);

    assert.equal(r.findings.length, 1, 'the run survives');
    assert.equal(r.findings[0].bucket, 'A', 'a thrown predicate must never demote');
    assert.ok(
      r.diagnostics.some((d) => d.startsWith('predicate-error:path-scope:') && d.includes('boom')),
      `expected a predicate-error diagnostic, got ${JSON.stringify(r.diagnostics)}`,
    );
  });

  // `sinkResolution` and `sinkLocation` are two views of ONE fact. Validated
  // independently, a finding could claim a resolved sink while carrying none —
  // and the `sink-unresolved` guard would never fire for it.
  test('sinkResolution and sinkLocation must agree, in both directions', () => {
    const claimsResolvedButHasNone = routable({ noSink: true });
    claimsResolvedButHasNone.sinkResolution = 'codeflow';
    assert.throws(() => route([claimsResolvedButHasNone]), /disagrees with sinkLocation/);

    const claimsUnresolvedButHasOne = routable();
    claimsUnresolvedButHasOne.sinkResolution = 'unresolved';
    assert.throws(() => route([claimsUnresolvedButHasOne]), /disagrees with sinkLocation/);
  });

  // The report is pasted into issues, PRs and chat, and an exception raised
  // while handling source can quote the line under review.
  test('a predicate exception message is redacted before it enters the report', () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const boobyTrapped = {
      ...CONFIG,
      pathScope: {
        get nonReachableGlobs() { throw new Error(`leaked ${secret} here`); },
      },
    };
    const r = route([routable({ p: 'tests/x.js', ruleId: 'javascript/PT/test' })], boobyTrapped);
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(secret), 'secret must not survive into the report');
    assert.ok(r.diagnostics.some((d) => d.startsWith('predicate-error:path-scope:')));
  });

  // H5 — a null collection means the adapter failed. Coercing it to empty
  // would return a clean-looking "nothing to review" for a run that reviewed
  // nothing.
  test('a non-array findings collection throws rather than reporting an empty clean run', () => {
    for (const bad of [null, undefined, {}, 'x']) {
      assert.throws(
        () => routeFindings(bad, CONFIG, { bounds: BOUND_DEFAULTS }),
        /findings must be an array/,
        String(bad),
      );
    }
  });
});

describe('D3b — ordered bucket resolution', () => {
  test('C beats D: the predicate that can be wrong dangerously never reaches the bottom', () => {
    assert.ok(BUCKET_RESTRICTIVENESS.A < BUCKET_RESTRICTIVENESS.C);
    assert.ok(BUCKET_RESTRICTIVENESS.C < BUCKET_RESTRICTIVENESS.D);
    assert.equal(
      selectBucket([
        { matched: true, bucket: 'D' },
        { matched: true, bucket: 'C' },
      ]),
      'C',
    );
  });

  test('no match at all resolves to A', () => {
    assert.equal(selectBucket([{ matched: false, reason: 'no-match' }]), 'A');
    assert.equal(selectBucket([]), 'A');
  });

  test('an end-to-end finding matching both path-scope and sanitizer-wrapped lands in C', () => {
    const f = routable({
      p: 'tests/x.js',
      ruleId: 'javascript/PT/test',
      source: 'el.innerHTML = `<b>${esc(a)}</b>`;',
    });
    const r = route([f]);
    assert.equal(r.findings[0].bucket, 'C');
  });
});

describe('SC1/SC2/G1 — sensitivity is checked BEFORE any predicate', () => {
  // §9 item 11 — the security-invariant bypass, asserted directly.
  test('a sensitive-path finding lands in A even when its path matches nonReachableGlobs', () => {
    const f = routable({ p: 'tests/.env', cls: 'sensitive', ruleId: 'javascript/PT/test' });
    const r = route([f]);
    assert.equal(r.findings[0].bucket, 'A');
    assert.ok(r.findings[0].matches.some((m) => m.reason === 'primary-path-sensitive'));
  });

  // §9 item 4 — INC-001. A symlink escaping repoRoot must not be demoted.
  test('an escaped-repo path lands in A, not D', () => {
    const f = routable({ p: 'tests/x.js', cls: 'escaped', ruleId: 'javascript/PT/test' });
    assert.equal(route([f]).findings[0].bucket, 'A');
  });

  test('an unresolved path lands in A, not D (fail-closed)', () => {
    const f = routable({ p: 'tests/x.js', cls: 'unresolved', ruleId: 'javascript/PT/test' });
    assert.equal(route([f]).findings[0].bucket, 'A');
  });

  // Checking BOTH paths is deliberate: a demotion decided from the primary
  // path while the sink lives in a credential file would hide exactly the
  // finding SC2 promises a human will read.
  test('a SENSITIVE SINK blocks demotion even when the primary path is fine', () => {
    const f = routable({
      p: 'tests/x.js',
      cls: 'ok',
      sinkPath: 'config/.env',
      sinkCls: 'sensitive',
      ruleId: 'javascript/PT/test',
    });
    const r = route([f]);
    assert.equal(r.findings[0].bucket, 'A');
    assert.ok(r.findings[0].matches.some((m) => m.reason === 'sink-path-sensitive'));
  });

  // §9 item 7 — a locationless result is counted once and routed to A.
  test('a locationless finding routes to A with a reason', () => {
    const r = route([routable({ noLocation: true })]);
    assert.equal(r.findings[0].bucket, 'A');
    assert.ok(r.findings[0].matches.some((m) => m.reason === 'location-null'));
  });

  // D3a0 rule 3, stated literally. `path-scope` reads the PRIMARY path, so
  // without this guard a finding whose claimed sink was never located could
  // still be demoted to the bottom bucket on the strength of its filename.
  test('an unresolved sink routes to A even when path-scope would demote it', () => {
    const f = routable({ p: 'tests/x.js', ruleId: 'javascript/PT/test', noSink: true });
    assert.equal(pathScope(f, CONFIG).bucket, 'D', 'sanity: path-scope alone would demote');
    const r = route([f]);
    assert.equal(r.findings[0].bucket, 'A');
    assert.ok(r.findings[0].matches.some((m) => m.reason === 'sink-unresolved'));
  });

  // The redacted snippet is a DELIBERATE report field (plan SC2); only the raw
  // prefix is barred. Pinning this stops a future reader "fixing" the wrong side.
  test('sourceContext is allowed through to the report — its redaction is Phase 3\'s job', () => {
    const f = { ...routable(), sourceContext: 'el.innerHTML = x;' };
    const r = route([f]);
    assert.equal(r.findings[0].sourceContext, 'el.innerHTML = x;');
  });
});

describe('path-scope — two signals that must agree (§2b)', () => {
  test('the producer signal is the rule-id suffix', () => {
    assert.equal(predicateProducerTestSignal('javascript/PT/test'), true);
    assert.equal(predicateProducerTestSignal('javascript/PT'), false);
    assert.equal(predicateProducerTestSignal('javascript/testing'), false);
  });

  test('both signals agree → D', () => {
    const m = pathScope(routable({ p: 'tests/x.js', ruleId: 'javascript/PT/test' }), CONFIG);
    assert.equal(m.bucket, 'D');
  });

  // The 3 measured cases where the producer was RIGHT and our glob was wrong.
  test('producer says test but the glob does not → no demotion, reason recorded', () => {
    const m = pathScope(routable({ p: 'public/js/browserTests.js', ruleId: 'javascript/PT/test' }), CONFIG);
    assert.equal(m.bucket, null);
    assert.equal(m.reason, 'path-scope:disagree-producer-only');
  });

  test('the glob says unreachable but the producer does not → no demotion', () => {
    const m = pathScope(routable({ p: 'tests/x.js', ruleId: 'javascript/Sqli' }), CONFIG);
    assert.equal(m.bucket, null);
    assert.equal(m.reason, 'path-scope:disagree-glob-only');
  });

  test('neither signal → no match', () => {
    assert.equal(pathScope(routable({ p: 'src/a.js', ruleId: 'javascript/Sqli' }), CONFIG), null);
  });

  test('an empty glob list makes the predicate inert', () => {
    const cfg = { ...CONFIG, pathScope: { nonReachableGlobs: [] } };
    assert.equal(pathScope(routable({ p: 'tests/x.js', ruleId: 'javascript/PT/test' }), cfg), null);
  });

  // §9 item 12 (Gemini G3) — the predicate must not silently degrade to a
  // no-op because the adapter handed it an ABSOLUTE realpath.
  test('the glob is matched against the repo-relative path, not the absolute canonical one', () => {
    const f = routable({ p: 'tests/x.js', ruleId: 'javascript/PT/test' });
    assert.equal(f.location.canonicalPath.startsWith('/repo/'), true);
    assert.equal(pathScope(f, CONFIG).bucket, 'D');
  });

  test('path-scope reads the PRIMARY location, not the sink', () => {
    const f = routable({ p: 'tests/x.js', sinkPath: 'src/deep.js', ruleId: 'javascript/PT/test' });
    assert.equal(pathScope(f, CONFIG).bucket, 'D');
  });
});

describe('D3a2 — comments and string literals are stripped first', () => {
  test('masking blanks comment bodies but preserves offsets and lines', () => {
    const src = 'a; // hi\nb;';
    const { masked, terminated } = maskCommentsAndStrings(src);
    assert.equal(masked.length, src.length);
    assert.equal(masked.split('\n').length, 2);
    assert.equal(terminated, true);
    assert.ok(!masked.includes('hi'));
  });

  test('masking blanks string bodies but keeps the quotes', () => {
    const { masked } = maskCommentsAndStrings('const a = "secret";');
    assert.ok(!masked.includes('secret'));
    assert.ok(masked.includes('"'));
  });

  test('template LITERAL TEXT is blanked but ${…} interpolations survive as code', () => {
    const { masked } = maskCommentsAndStrings('`<b>${esc(a)}</b>`');
    assert.ok(!masked.includes('<b>'));
    assert.ok(masked.includes('${esc(a)}'));
  });

  test('an unterminated block comment is ambiguous, not silently tolerated', () => {
    assert.equal(maskCommentsAndStrings('a; /* open').terminated, false);
  });

  test('an unterminated template is ambiguous', () => {
    assert.equal(maskCommentsAndStrings('const a = `open').terminated, false);
  });

  test('a regex literal containing a backtick cannot open a fake template', () => {
    const { masked, terminated } = maskCommentsAndStrings('if (/`/.test(x)) { y(); }');
    assert.equal(terminated, true);
    assert.ok(!masked.includes('`'));
  });

  /**
   * H4. A `/` after a KEYWORD starts a regex, but the last significant
   * character there is a letter — which reads as an identifier, i.e. division.
   * The regex body then goes unmasked, and a backtick inside it synthesises a
   * template literal that does not exist in the code. If that phantom is the
   * window's only candidate, the predicate demotes on it: the D3a2 failure
   * reached through a different door.
   */
  test('a regex after a keyword is masked, not read as division', () => {
    for (const kw of ['return', 'typeof', 'case', 'in', 'of', 'await', 'yield']) {
      const { masked, terminated } = maskCommentsAndStrings(`${kw} /\`/.test(x);`);
      assert.equal(terminated, true, kw);
      assert.ok(!masked.includes('`'), `${kw}: backtick inside the regex must be masked`);
    }
  });

  test('division after an identifier is still division, not a regex', () => {
    const { masked, terminated } = maskCommentsAndStrings('const r = total / count;');
    assert.equal(terminated, true);
    assert.ok(masked.includes('/'), 'the division operator must survive');
  });

  test('a keyword-prefixed regex cannot fabricate a sanitized template', () => {
    // The real sink is a bare identifier. The only `${esc(…)}` in the window
    // lives inside a regex following `return` — it must not demote.
    const f = routable({ source: 'el.innerHTML = someVar; return /`${esc(x)}`/.test(s);' });
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)), null);
    assert.equal(route([f]).findings[0].bucket, 'A');
  });

  test('nested templates inside interpolations are tracked, not mis-nested', () => {
    assert.equal(maskCommentsAndStrings('`a${`b${c}`}d`').terminated, true);
  });

  /**
   * The field incident, in its DANGEROUS form.
   *
   * The real sink is a bare identifier — nothing sanitized it. But a code
   * comment on the same line quotes a template whose interpolation IS wrapped
   * in a declared sanitizer. Without stripping, the predicate reads the
   * comment's template, finds every interpolation sanitized, and DEMOTES a
   * genuinely unsafe finding to `C`.
   *
   * This is the exact shape of the upstream failure: it fails open, it looks
   * like success, and the negative control passes because the detector can no
   * longer see the real site at all.
   */
  test('a sanitizer quoted inside a COMMENT cannot demote an unsanitized sink', () => {
    const source = 'el.innerHTML = someVar; // built from `${esc(x)}`';
    const f = routable({ source });
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)), null);
    assert.equal(route([f]).findings[0].bucket, 'A');
  });

  test('a comment beside a real sanitized template does not perturb the verdict', () => {
    const source = '// renders `${userInput}` — see ticket 123\nel.innerHTML = `<b>${esc(a)}</b>`;';
    const f = routable({
      source,
      region: { startLine: 2, startColumn: null, endLine: 2, endColumn: null },
    });
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)).bucket, 'C');
  });

  test('a window opening inside a block comment is judged from line 1, not the window', () => {
    // The window (line 3) looks like a live template, but it is commented out.
    const source = '/* disabled:\nel.innerHTML = `<b>${raw}</b>`;\nel.innerHTML = `<b>${esc(a)}</b>`;\n*/\nx();';
    const f = routable({
      source,
      region: { startLine: 3, startColumn: null, endLine: 3, endColumn: null },
    });
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)), null);
  });
});

describe('sanitizer-wrapped — D3a', () => {
  const at = (source, line = 1) =>
    routable({ source, region: { startLine: line, startColumn: null, endLine: line, endColumn: null } });

  test('every interpolation wrapped by a declared sanitizer → C', () => {
    const f = at('el.innerHTML = `<b>${esc(a)}</b><i>${escapeHtml(b)}</i>`;');
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)).bucket, 'C');
  });

  test('a member-expression sanitizer is matched by its declared dotted form', () => {
    const f = at('el.innerHTML = `<b>${DOMPurify.sanitize(a)}</b>`;');
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)).bucket, 'C');
  });

  /**
   * §9's named negative-control finding: one escaped field beside one raw
   * field on the SAME template. This is a real vulnerability and must land in
   * `A` — it is the case the whole routing design exists to protect.
   */
  test('one raw interpolation beside a sanitized one → NO match (the known-real finding)', () => {
    const f = at('el.innerHTML = `<b>${esc(r.wineName)}</b><i>${r.reason}</i>`;');
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)), null);
    assert.equal(route([f]).findings[0].bucket, 'A');
  });

  test('a bare identifier does not match, and neither does an undeclared call', () => {
    assert.equal(outermostCallIsSanitizer('a', CONFIG.sanitizerWrapped.sanitizers), false);
    assert.equal(outermostCallIsSanitizer('notEsc(a)', CONFIG.sanitizerWrapped.sanitizers), false);
  });

  // The predicate proves a wrapper is PRESENT; it does not chase what a name
  // might be bound to. An alias is therefore not a match.
  test('an alias of a sanitizer does not match', () => {
    assert.equal(outermostCallIsSanitizer('myEsc(a)', CONFIG.sanitizerWrapped.sanitizers), false);
  });

  test('the sanitizer must be the OUTERMOST call spanning the whole interpolation', () => {
    const sans = CONFIG.sanitizerWrapped.sanitizers;
    assert.equal(outermostCallIsSanitizer('esc(a)', sans), true);
    assert.equal(outermostCallIsSanitizer('wrap(esc(a))', sans), false);
    assert.equal(outermostCallIsSanitizer('esc(a) + b', sans), false);
    assert.equal(outermostCallIsSanitizer('esc(a) + esc(b)', sans), false);
  });

  // §7c constraint 2 — ambiguity resolves to A, never to a demotion.
  test('more than one candidate template in the window → NO match', () => {
    const f = at('const a = `${esc(x)}`; const b = `${esc(y)}`;');
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)), null);
  });

  test('nesting depth greater than 1 is unsupported → no match', () => {
    const f = at('el.innerHTML = `<b>${`${esc(a)}`}</b>`;');
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)), null);
  });

  test('a template with zero interpolations cannot explain the finding → no match', () => {
    const f = at('el.innerHTML = `<b>static</b>`;');
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)), null);
  });

  // D3a: a region EXCEEDING the clamp yields no match — silently truncating
  // would demote on the basis of source the predicate never saw.
  test('a region larger than maxSinkLines yields no match', () => {
    const source = Array.from({ length: 40 }, () => 'x();').join('\n');
    const f = routable({
      source,
      region: { startLine: 1, startColumn: null, endLine: 30, endColumn: null },
    });
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f, { ...BOUND_DEFAULTS, maxSinkLines: 12 })), null);
  });

  test('no source available → no match (never a demotion on absent evidence)', () => {
    assert.equal(sanitizerWrapped(routable(), CONFIG, { bounds: BOUND_DEFAULTS, getSource: () => null }), null);
  });

  test('an empty sanitizers list makes the predicate inert', () => {
    const cfg = { ...CONFIG, sanitizerWrapped: { sanitizers: [] } };
    const f = at('el.innerHTML = `<b>${esc(a)}</b>`;');
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)).bucket, 'C', 'sanity: matches when declared');
    assert.equal(sanitizerWrapped(f, cfg, ctxFor(f)), null);
  });

  test('sanitizer-wrapped can only ever yield C, never D', () => {
    const f = at('el.innerHTML = `<b>${esc(a)}</b>`;');
    assert.equal(sanitizerWrapped(f, CONFIG, ctxFor(f)).bucket, 'C');
  });
});

describe('sink-mismatch — §7c constraint 1, three accepted region forms', () => {
  const reDos = (source, region) =>
    routable({ ruleId: 'javascript/reDOS', source, region, sinkRegion: region });

  test('form 1: the region IS the call expression', () => {
    const src = 'const hit = caches.match(req);';
    const f = reDos(src, { startLine: 1, startColumn: 13, endLine: 1, endColumn: 30 });
    assert.equal(sinkMismatch(f, CONFIG, ctxFor(f)).bucket, 'D');
  });

  test('form 2: the region IS the callee', () => {
    const src = 'const hit = caches.match(req);';
    const f = reDos(src, { startLine: 1, startColumn: 13, endLine: 1, endColumn: 25 });
    assert.equal(sinkMismatch(f, CONFIG, ctxFor(f)).bucket, 'D');
  });

  test('form 3: the region is enclosed by the argument list', () => {
    const src = 'const hit = caches.match(req);';
    const f = reDos(src, { startLine: 1, startColumn: 26, endLine: 1, endColumn: 29 });
    assert.equal(sinkMismatch(f, CONFIG, ctxFor(f)).bucket, 'D');
  });

  test('a callee identifier NOT followed by a call is not form 2', () => {
    assert.equal(resolveSinkFunction('const x = caches.match;', 'caches.match'), null);
  });

  test('a pair for a different ruleId does not match', () => {
    const src = 'const hit = caches.match(req);';
    const f = routable({
      ruleId: 'javascript/Sqli',
      source: src,
      region: { startLine: 1, startColumn: 13, endLine: 1, endColumn: 30 },
      sinkRegion: { startLine: 1, startColumn: 13, endLine: 1, endColumn: 30 },
    });
    assert.equal(sinkMismatch(f, CONFIG, ctxFor(f)), null);
  });

  test('the last segment of a dotted chain also satisfies a declared sinkFunction', () => {
    const cfg = { ...CONFIG, sinkMismatch: { pairs: [{ ruleId: 'javascript/reDOS', sinkFunction: 'match' }] } };
    const f = reDos('const hit = caches.match(req);', { startLine: 1, startColumn: 13, endLine: 1, endColumn: 30 });
    assert.equal(sinkMismatch(f, cfg, ctxFor(f)).bucket, 'D');
  });

  test('an empty pair list makes the predicate inert', () => {
    const cfg = { ...CONFIG, sinkMismatch: { pairs: [] } };
    const f = reDos('const hit = caches.match(req);', { startLine: 1, startColumn: 13, endLine: 1, endColumn: 30 });
    assert.equal(sinkMismatch(f, cfg, ctxFor(f)), null);
  });
});

describe('unusedPredicates — reported as AMBIGUOUS, never as good news', () => {
  test('a predicate matching zero findings is listed', () => {
    const r = route([routable()]);
    assert.deepEqual(r.unusedPredicates.sort(), [...PREDICATE_KINDS].sort());
  });

  test('a predicate that matched is not listed', () => {
    const r = route([routable({ p: 'tests/x.js', ruleId: 'javascript/PT/test' })]);
    assert.ok(!r.unusedPredicates.includes('path-scope'));
  });
});
