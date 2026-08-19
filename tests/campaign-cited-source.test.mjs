/**
 * @fileoverview Cited-source window resolution — centred windowing, anchor
 * fallback, and failure normalisation (campaign/cited-source).
 *
 * Split out of `tests/campaign-adjudication.test.mjs` (Phase 4, plan:
 * comparison-tooling-consolidation.md, D3) — assertions moved verbatim.
 *
 * @module tests/campaign-cited-source
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  centredWindow, citedLineOf, resolveCitedSources, detailAnchors, anchorLine,
  sectionAnchors, planDocumentCandidates, anchorHits, clusterAnchorHits, planWindows,
  CITED_SOURCE_MAX_CHARS, CITED_SOURCE_MAX_WINDOWS, CITED_SOURCE_WINDOW_LINES,
} from '../scripts/lib/campaign/cited-source.mjs';
import { ADJUDICATION_SYSTEM_PROMPT } from '../scripts/lib/campaign/adjudicate.mjs';

// ── cited sources ───────────────────────────────────────────────────────────

describe('cited sources', () => {
  const content = Array.from({ length: 1000 }, (_, i) => `line${i + 1}`).join('\n');

  it('the window is CENTRED on the cited line, not taken from the top', () => {
    // The failure this prevents: an arm correctly finds a defect at line 800 of
    // a file truncated at 500, the adjudicator sees a file without it, and the
    // arm is penalised for being right.
    const win = centredWindow(content, 800, 240);
    assert.ok(win.startLine < 800 && win.endLine > 800, `line 800 must be inside [${win.startLine}, ${win.endLine}]`);
    assert.equal(win.startLine, 680);
    assert.match(win.text, /^line680\n/);
    assert.equal(win.truncated, true);
  });

  it('a SINGLE line longer than the whole budget is CUT — the bound is a bound', () => {
    // The first version kept an oversized first line whole (`&& kept.length > 0`
    // on the break), so one minified line bypassed the ceiling entirely:
    // measured at 500,000 characters through a 24,000 budget. A limit with an
    // exception for the common bad case is not a limit.
    const one = 'x'.repeat(500000);
    const win = centredWindow(one, 1, 240, 24000);
    // `<= 24000` exactly, with no tolerance. An earlier version of this
    // assertion allowed `+ 120` to accommodate the truncation marker — a test
    // written around the bug rather than against it. The marker is paid for out
    // of the budget, so the ceiling holds for the WHOLE returned string.
    assert.ok(win.text.length <= 24000, `single line escaped the budget at ${win.text.length} chars`);
    assert.equal(win.truncated, true);
    assert.match(win.text, /truncated: single line exceeds/, 'and it says so, rather than silently losing the tail');

    // The ceiling holds at EVERY budget, including ones smaller than the
    // truncation marker itself — where reserving room for the marker still
    // overflows, because `room` clamps to 0 and the marker is appended anyway.
    // An exported function has to survive the degenerate arguments it is handed.
    for (const budget of [80, 40, 10, 1]) {
      const win2 = centredWindow(one, 1, 240, budget);
      assert.ok(win2.text.length <= budget, `budget ${budget} produced ${win2.text.length} chars`);
    }

    // A budget that merely LOOKS numeric must not disable the bound. `NaN`
    // defeats every comparison silently (`len <= NaN` is false), so an
    // unvalidated parameter is a bound a caller can switch off by accident.
    for (const bogus of [NaN, Infinity, -1, 0, undefined, null]) {
      const win3 = centredWindow(one, 1, 240, bogus);
      assert.ok(win3.text.length <= 24000, `budget ${String(bogus)} produced ${win3.text.length} chars`);
    }
  });

  it('the window is bounded by CHARACTERS as well as lines', () => {
    // 240 lines of a minified file is megabytes, and every character is paid
    // for on a spend-bearing call. A line budget is not a byte budget.
    const wide = Array.from({ length: 50 }, () => 'x'.repeat(5000)).join('\n');
    const win = centredWindow(wide, 1, 240, 24000);
    assert.ok(win.text.length <= 24000, `excerpt was ${win.text.length} chars`);
    assert.equal(win.truncated, true, 'a char-clamped excerpt is truncated, whatever the line count says');
    assert.ok(win.endLine < 50, 'endLine must follow the clamp, not the pre-clamp window');
  });

  it('recovers an anchor from the finding prose — the cited line is absent on EVERY real row', () => {
    // Measured 2026-08-10 against the live store: primary_file carries a :line
    // in 0 of 3993 rows, because recordFindings stores `_primaryFile || section`
    // and the resolved bare path wins. Without a prose anchor the centring
    // mitigation is inert in production while its test passes on a synthetic
    // section — a mitigation that reads as covered and never fires.
    const anchors = detailAnchors('The `resolveNextAttempt` helper wedges when store.maxArmRunAttempt returns 0.');
    assert.ok(anchors.includes('resolveNextAttempt'), `got ${JSON.stringify(anchors)}`);
    assert.ok(anchors.includes('store.maxArmRunAttempt'));
    assert.ok(!anchors.includes('The'), 'ordinary words are not anchors');

    const content = `${'filler\n'.repeat(600)}function resolveNextAttempt() {}\n${'more\n'.repeat(600)}`;
    const hit = anchorLine(content, anchors);
    assert.equal(hit.anchor, 'resolveNextAttempt');
    assert.equal(hit.line, 601);
  });

  it('an anchor is matched LITERALLY — model prose never becomes a regex', () => {
    // The detail is model-authored and arrives unvalidated; compiling it would
    // be an injection surface and a catastrophic-backtracking one.
    assert.equal(anchorLine('a.b.c', ['a.b.c']).line, 1);
    assert.equal(anchorLine('axbxc', ['a.b.c']), null, 'the dot must not match any character');
  });

  it('each cited path gets its OWN line — one path\'s line is never applied to another', () => {
    const seen = [];
    const res = resolveCitedSources({
      section: 'scripts/a.mjs:800 and scripts/b.mjs:5',
      detail: '', auditedSha: 'HEAD',
      show: (_root, _sha, p) => { seen.push(p); return { ok: true, content: Array.from({ length: 1000 }, (_, i) => `${p}-line${i + 1}`).join('\n') }; },
    });
    const a = res.sources.find((s) => s.path === 'scripts/a.mjs');
    const b = res.sources.find((s) => s.path === 'scripts/b.mjs');
    assert.ok(a.startLine < 800 && a.endLine > 800, `a centred on ${a.startLine}-${a.endLine}, not on 800`);
    assert.ok(b.startLine <= 5 && b.endLine > 5, `b centred on ${b.startLine}-${b.endLine}, not on 5`);
    assert.equal(a.anchorKind, 'cited-line');
    assert.equal(b.anchorKind, 'cited-line');
  });

  it('names WHICH anchor produced the window, so a head window is never ambiguous', () => {
    const long = Array.from({ length: 1000 }, (_, i) => (i === 700 ? 'const targetSymbol = 1;' : `pad${i}`)).join('\n');
    const viaDetail = resolveCitedSources({
      section: 'scripts/a.mjs', detail: 'the `targetSymbol` constant is wrong', auditedSha: 'HEAD',
      show: () => ({ ok: true, content: long }),
    });
    assert.equal(viaDetail.sources[0].anchorKind, 'detail-anchor');
    assert.equal(viaDetail.sources[0].anchor, 'targetSymbol');
    assert.ok(viaDetail.sources[0].startLine <= 701 && viaDetail.sources[0].endLine >= 701);

    const viaHead = resolveCitedSources({
      section: 'scripts/a.mjs', detail: 'nothing nameable here', auditedSha: 'HEAD',
      show: () => ({ ok: true, content: long }),
    });
    assert.equal(viaHead.sources[0].anchorKind, 'head', '"found nothing" must be distinguishable from "small file"');
    assert.equal(viaHead.sources[0].truncated, true, 'and a head window on a long file is honestly truncated');
  });

  it('a file that fits is not marked truncated', () => {
    const win = centredWindow('a\nb\nc', null, 240);
    assert.equal(win.truncated, false);
    assert.equal(win.endLine, 3);
  });

  it('reads the cited line out of a section reference', () => {
    assert.equal(citedLineOf('scripts/a.mjs:120'), 120);
    assert.equal(citedLineOf('scripts/a.mjs'), null);
    assert.equal(citedLineOf(null), null);
  });

  it('resolves a real file at a real revision, and reports resolvedAny honestly', () => {
    const fake = () => ({ ok: false, error: { code: 'BAD_REVISION' } });
    const none = resolveCitedSources({ section: 'scripts/campaign.mjs:10', auditedSha: 'deadbeef', show: fake });
    assert.equal(none.resolvedAny, false, 'an all-fail row must be forced to unverifiable BEFORE any provider call');
    assert.equal(none.sources[0].resolved, false);

    const ok = resolveCitedSources({
      section: 'scripts/campaign.mjs:10', auditedSha: 'HEAD',
      show: () => ({ ok: true, content: 'a\nb\nc' }),
    });
    assert.equal(ok.resolvedAny, true);
    assert.equal(ok.sources[0].path, 'scripts/campaign.mjs');
  });

  it('a sensitive path is refused and MARKED, never read', () => {
    let read = 0;
    const res = resolveCitedSources({
      section: 'secrets/config.mjs:3', auditedSha: 'HEAD', show: () => { read += 1; return { ok: true, content: 'SECRET=1' }; },
    });
    assert.equal(read, 0, 'the egress seam must not even fetch it');
    assert.equal(res.resolvedAny, false);
    assert.equal(res.sources[0]?.reason, 'sensitive-path');
  });
});

// -- the plan-document fallback ---------------------------------------------
//
// Measured over cohort `e52eec728688fcab` on 2026-08-19: 107 of 201 findings
// resolved NO source, so they were forced `unverifiable` and handed to a human
// having never reached the adjudicator -- 60% of that campaign's human queue.
// 171 of the 201 are plan-mode findings, whose `primary_file` is a
// `§`-section rather than a path, so `affectedFilesOf` has nothing to return.
// The document was retrievable the whole time: `audit_runs.plan_file` at the
// snapshot's own sha read cleanly for 89/89 of them.

describe('plan-document fallback', () => {
  const planText = Array.from({ length: 900 }, (_, i) => {
    if (i === 400) return '## §2 Envelope budget';
    if (i === 600) return 'the `computeRowFingerprint` helper is described here';
    return `plan line ${i + 1}`;
  }).join('\n');

  it('a §-section finding now reaches the adjudicator with the plan it reviews', () => {
    const res = resolveCitedSources({
      section: '§2 Envelope budget (deterministic truncation order) vs. §2 KD-3',
      detail: 'The plan defers five files with no owner named.',
      auditedSha: 'abc123',
      planFile: 'docs/plans/final-review-scoped-second-reviewer.md',
      show: (_r, _sha, p) => (p === 'docs/plans/final-review-scoped-second-reviewer.md' ? { ok: true, content: planText } : { ok: false, error: { code: 'BAD_PATH' } }),
    });
    assert.equal(res.resolvedAny, true, 'this is the whole point: the row must not be forced unverifiable');
    const src = res.sources.find((x) => x.kind === 'plan-document');
    assert.ok(src, 'and it must be LABELLED, so the adjudicator knows it is reading a plan, not code');
    assert.equal(src.path, 'docs/plans/final-review-scoped-second-reviewer.md');
    assert.equal(src.sha, 'abc123', 'at the snapshot revision, never the working tree');
    assert.equal(src.anchorKind, 'section-anchor');
    assert.ok(src.startLine <= 401 && src.endLine >= 401, `window ${src.startLine}-${src.endLine} missed the cited section`);
  });

  it('prose anchors win over the section reference — they are the more specific citation', () => {
    const res = resolveCitedSources({
      section: '§2 Envelope budget',
      detail: 'The `computeRowFingerprint` helper is never called.',
      auditedSha: 'abc123', planFile: 'docs/plans/x.md',
      show: () => ({ ok: true, content: planText }),
    });
    const src = res.sources[0];
    assert.equal(src.anchorKind, 'detail-anchor');
    assert.equal(src.anchor, 'computeRowFingerprint');
    assert.ok(src.startLine <= 601 && src.endLine >= 601);
  });

  it('NEGATIVE CONTROL: a finding that resolves its own source does NOT also drag in the plan', () => {
    // A fallback, not an addition. Dragging a 1668-line plan document into
    // every row that already has its evidence is spend and noise, and it would
    // change the behaviour of the 94 rows that were fine.
    const reads = [];
    const res = resolveCitedSources({
      section: 'scripts/a.mjs:10', detail: 'x', auditedSha: 'abc123', planFile: 'docs/plans/x.md',
      show: (_r, _sha, p) => { reads.push(p); return { ok: true, content: 'a\nb\nc' }; },
    });
    assert.equal(res.resolvedAny, true);
    assert.deepEqual(reads, ['scripts/a.mjs'], 'the plan document must never be fetched for a row that resolved');
    assert.equal(res.sources.some((x) => x.kind === 'plan-document'), false);
  });

  it('a bare basename resolves under docs/plans/, and only the LAST refusal is reported', () => {
    // This cohort holds both spellings: `docs/plans/comparison-tooling-
    // consolidation.md` and a bare `event-wiring-symmetry.md` (11 rows).
    assert.deepEqual(planDocumentCandidates('event-wiring-symmetry.md'), ['event-wiring-symmetry.md', 'docs/plans/event-wiring-symmetry.md']);
    assert.deepEqual(planDocumentCandidates('docs/plans/x.md'), ['docs/plans/x.md']);
    assert.deepEqual(planDocumentCandidates('not-a-doc.txt'), [], 'only markdown is a plan document');
    assert.deepEqual(planDocumentCandidates(null), []);

    const res = resolveCitedSources({
      section: '§4 something', detail: '', auditedSha: 'abc123', planFile: 'event-wiring-symmetry.md',
      show: (_r, _sha, p) => (p.startsWith('docs/plans/') ? { ok: true, content: planText } : { ok: false, error: { code: 'BAD_PATH' } }),
    });
    assert.equal(res.resolvedAny, true);
    assert.equal(res.sources.filter((x) => x.kind === 'plan-document').length, 1, 'the intermediate miss is how the spelling gets found — not a fault to report');
    assert.equal(res.sources[0].path, 'docs/plans/event-wiring-symmetry.md');

    const gone = resolveCitedSources({
      section: '§4 something', detail: '', auditedSha: 'abc123', planFile: 'event-wiring-symmetry.md',
      show: () => ({ ok: false, error: { code: 'BAD_PATH' } }),
    });
    assert.equal(gone.resolvedAny, false, 'an unreadable plan is still an honest hand-off');
    assert.equal(gone.sources.length, 1, 'one refusal, naming the last candidate tried');
    assert.equal(gone.sources[0].path, 'docs/plans/event-wiring-symmetry.md');
  });

  it('the plan path goes through the SAME admission and byte ceiling as any citation', () => {
    // The fallback must not become a second read path with its own idea of what
    // is admissible: a plan-shaped path into a credential store is still an
    // egress refusal, and the byte ceiling still binds.
    let read = 0;
    const sensitive = resolveCitedSources({
      section: '§1 x', detail: '', auditedSha: 'abc123', planFile: '.ssh/notes.md',
      show: () => { read += 1; return { ok: true, content: 'SECRET' }; },
    });
    assert.equal(read, 0, 'not even fetched');
    assert.equal(sensitive.resolvedAny, false);
    assert.equal(sensitive.sources[0].reason, 'sensitive-path');

    const huge = resolveCitedSources({
      section: '§1 x', detail: '', auditedSha: 'abc123', planFile: 'docs/plans/x.md',
      blobSize: () => ({ ok: true, bytes: 50 * 1024 * 1024 }),
      show: () => { read += 1; return { ok: true, content: planText }; },
    });
    assert.equal(read, 0, 'the oversized blob is refused on its header, never materialised');
    assert.equal(huge.sources[0].reason, 'oversized');
  });

  it('the prompt and the payload agree on the literal `plan-document`', () => {
    // A prose-to-code contract with no compiler: the system prompt tells the
    // model what `kind: "plan-document"` means, and this is the only thing that
    // fails if the resolver ever emits a different spelling.
    const res = resolveCitedSources({
      section: '§1 x', detail: '', auditedSha: 'abc123', planFile: 'docs/plans/x.md',
      show: () => ({ ok: true, content: planText }),
    });
    assert.equal(res.sources[0].kind, 'plan-document');
    assert.ok(ADJUDICATION_SYSTEM_PROMPT.includes('kind: "plan-document"'), 'the prompt must name the exact literal the resolver emits');
  });
});

describe('sectionAnchors', () => {
  it('recovers a backticked span and the title phrase after the § marker', () => {
    const a = sectionAnchors('§2 Envelope budget (`truncation order`) vs. §2 KD-3');
    assert.ok(a.includes('truncation order'), 'a backticked span is the most deliberate citation');
    assert.ok(a.some((x) => x.startsWith('Envelope budget')), 'and the title phrase lands on the real heading');
  });

  it('the bare §N marker is NOT an anchor — it would preempt the title phrase', () => {
    // Measured over the 89 plan-fallback rows: `§2` matches in 80 of them, but
    // a plan cross-references its own sections constantly, so it lands on a
    // REFERENCE rather than the section — and being tried first it would
    // displace the title phrase, which lands on the heading itself.
    const a = sectionAnchors('§2 Envelope budget');
    assert.equal(a.includes('§2'), false);
    assert.equal(a[0], 'Envelope budget', 'the title phrase is what anchors');
  });

  it('does NOT split prose on apostrophes — a wrong anchor beats no anchor only in appearance', () => {
    // Single-quoted spans were tried and rejected: they moved exactly ONE row
    // of 201 while an apostrophe in ordinary prose yields a span that anchors
    // the window on an unrelated line. A head window is honestly truncated and
    // the prompt turns it into `unverifiable`; a wrong anchor is not caught by
    // anything.
    const a = sectionAnchors("§2 the plan's rule, and the reviewer's answer");
    assert.equal(a.some((x) => x.startsWith('s ')), false, 'no anchor may begin mid-word after an apostrophe');
  });

  it('is bounded and de-duplicated', () => {
    const many = sectionAnchors(Array.from({ length: 40 }, (_, i) => `§${i} Section ${i}`).join('; '));
    assert.ok(many.length <= 8);
    assert.equal(new Set(many).size, many.length);
  });

  it('returns nothing for a plain path — this is the plan-citation shape only', () => {
    assert.deepEqual(sectionAnchors('scripts/a.mjs:10'), []);
    assert.deepEqual(sectionAnchors(null), []);
  });
});

// -- more than one span of one file ------------------------------------------
//
// A finding can name two places at once: "§1 D1b vs §8 promotion matrix", or a
// claim about a REPEATED span. One centred window answers only the first of
// them. The case that exposed it, live on 2026-08-19: a finding about a
// duplicated `#### D7e` heading, whose occurrences sit at lines 1755 and 1875
// of the plan. The window centred on the first covered 1635-1874 and missed the
// second by ONE line, and the adjudicator reported exactly that -- "Only ONE
// '#### D7e' heading is visible in the cited span."

describe('multi-window citations', () => {
  // 2000 lines with the same heading twice, 120 apart, as in the field case.
  const dupDoc = Array.from({ length: 2000 }, (_, i) => {
    if (i === 1754 || i === 1874) return '#### D7e Role and MODE are orthogonal';
    return `plan line ${i + 1}`;
  }).join('\n');

  it('THE field case: two occurrences 120 lines apart land in ONE window, at the same cost', () => {
    const res = resolveCitedSources({
      section: '#### D7e', detail: 'The `#### D7e` heading appears twice.',
      auditedSha: 'abc123', planFile: 'docs/plans/x.md',
      show: () => ({ ok: true, content: dupDoc }),
    });
    const wins = res.sources.filter((x) => x.resolved);
    assert.equal(wins.length, 1, 'clustering, not a second window: they fit in one span');
    const w = wins[0];
    assert.ok(w.startLine <= 1755 && w.endLine >= 1875, `window ${w.startLine}-${w.endLine} must contain BOTH occurrences`);
  });

  it('two regions too far apart become two windows, and the budget is DIVIDED not multiplied', () => {
    const farDoc = Array.from({ length: 3000 }, (_, i) => {
      if (i === 200) return 'the alpha marker lives here';
      if (i === 2500) return 'the omega marker lives here';
      return `filler line ${i + 1} with enough text to make the character budget bite somewhat`;
    }).join('\n');
    const res = resolveCitedSources({
      section: 'scripts/a.mjs', detail: 'compare `alpha marker` against `omega marker`',
      auditedSha: 'abc123',
      show: () => ({ ok: true, content: farDoc }),
    });
    const wins = res.sources.filter((x) => x.resolved);
    assert.equal(wins.length, 2);
    assert.ok(wins.some((w) => w.startLine <= 201 && w.endLine >= 201), 'the first region is shown');
    assert.ok(wins.some((w) => w.startLine <= 2501 && w.endLine >= 2501), 'and so is the second');

    // The property that makes this safe on a spend-bearing call: one file's
    // whole excerpt costs the same whether it is one span or three.
    const total = wins.reduce((n, w) => n + w.content.length, 0);
    assert.ok(total <= CITED_SOURCE_MAX_CHARS, `${total} chars for one file exceeds the ${CITED_SOURCE_MAX_CHARS} budget`);
  });

  it('says which span it is showing, so two entries are never read as two files', () => {
    const farDoc = Array.from({ length: 3000 }, (_, i) => (i === 200 ? 'alpha marker' : (i === 2500 ? 'omega marker' : `line ${i + 1}`))).join('\n');
    const res = resolveCitedSources({
      section: 'scripts/a.mjs', detail: '`alpha marker` and `omega marker`', auditedSha: 'abc123',
      show: () => ({ ok: true, content: farDoc }),
    });
    const wins = res.sources.filter((x) => x.resolved);
    assert.deepEqual(wins.map((w) => w.windowIndex), [1, 2]);
    assert.deepEqual(wins.map((w) => w.windowCount), [2, 2]);
    assert.equal(new Set(wins.map((w) => w.path)).size, 1, 'both are the same file');
    assert.ok(ADJUDICATION_SYSTEM_PROMPT.includes('`windowIndex` of `windowCount`'), 'and the prompt explains what that means');
  });

  it('never exceeds the window cap however many regions the finding names', () => {
    const many = Array.from({ length: 6000 }, (_, i) => (i % 700 === 0 ? `marker${Math.floor(i / 700)} here` : `line ${i + 1}`)).join('\n');
    const detail = Array.from({ length: 8 }, (_, k) => `\`marker${k} here\``).join(' and ');
    const res = resolveCitedSources({
      section: 'scripts/a.mjs', detail, auditedSha: 'abc123', show: () => ({ ok: true, content: many }),
    });
    const wins = res.sources.filter((x) => x.resolved);
    assert.equal(wins.length, CITED_SOURCE_MAX_WINDOWS);
    assert.ok(wins.reduce((n, w) => n + w.content.length, 0) <= CITED_SOURCE_MAX_CHARS);
  });

  it('NEGATIVE CONTROL: a single-region finding is still ONE full-size window', () => {
    // The 115 rows that name one region must not be split, narrowed, or
    // otherwise disturbed by a feature meant for the other 86.
    const doc = Array.from({ length: 1000 }, (_, i) => (i === 700 ? 'const targetSymbol = 1;' : `pad${i}`)).join('\n');
    const res = resolveCitedSources({
      section: 'scripts/a.mjs', detail: 'the `targetSymbol` constant is wrong', auditedSha: 'abc123',
      show: () => ({ ok: true, content: doc }),
    });
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].windowCount, 1);
    assert.equal(res.sources[0].endLine - res.sources[0].startLine + 1, CITED_SOURCE_WINDOW_LINES, 'full width, undivided');
  });

  it('an explicit path:line citation stays ONE window — it is an instruction, not a guess', () => {
    const doc = Array.from({ length: 3000 }, (_, i) => (i === 200 ? 'alpha marker' : (i === 2500 ? 'omega marker' : `line ${i + 1}`))).join('\n');
    const res = resolveCitedSources({
      section: 'scripts/a.mjs:2501', detail: '`alpha marker` and `omega marker`', auditedSha: 'abc123',
      show: () => ({ ok: true, content: doc }),
    });
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].anchorKind, 'cited-line');
    assert.ok(res.sources[0].startLine <= 2501 && res.sources[0].endLine >= 2501);
  });
});

describe('anchorHits / clusterAnchorHits / planWindows', () => {
  const doc = Array.from({ length: 1000 }, (_, i) => ((i === 99 || i === 149 || i === 899) ? 'needle' : `line ${i + 1}`)).join('\n');

  it('collects repeated occurrences, bounded per term', () => {
    assert.deepEqual(anchorHits(doc, ['needle'], 2).map((h) => h.line), [100, 150]);
    assert.deepEqual(anchorHits(doc, ['needle'], 3).map((h) => h.line), [100, 150, 900]);
    assert.deepEqual(anchorHits(doc, ['needle'], 1).map((h) => h.line), [100]);
  });

  it('one line is one candidate however many anchors name it', () => {
    // Otherwise two anchors on the same line claim two windows and halve the
    // budget for a span already covered once.
    assert.deepEqual(anchorHits('alpha beta\nx', ['alpha', 'beta'], 2).map((h) => h.line), [1]);
  });

  it('anchorLine still answers the single-best question, unchanged', () => {
    assert.deepEqual(anchorLine(doc, ['needle']), { line: 100, anchor: 'needle' });
    assert.equal(anchorLine(doc, ['absent']), null);
  });

  it('ranks by anchor PRIORITY, not by position in the file', () => {
    // Hit order IS priority (anchors are tried most-specific first), so the
    // cluster holding the array-first anchor must lead even though it sits
    // LATER in the file. When the window cap bites, the cluster that gets
    // dropped has to be the least deliberate citation, not the bottom one.
    const hits = [{ line: 900, anchor: 'quoted' }, { line: 100, anchor: 'weak' }, { line: 150, anchor: 'weak' }];
    const clusters = clusterAnchorHits(hits, 240);
    assert.equal(clusters.length, 2);
    assert.deepEqual(clusters[0].lines, [900]);
    assert.equal(clusters[0].anchor, 'quoted');
    assert.deepEqual(clusters[1].lines, [100, 150], 'and the weaker cluster still groups what fits together');
  });

  it('a cluster reports its BEST anchor, not its topmost one', () => {
    // A window covering a section heading and the quoted symbol below it is
    // there because of the quotation; naming the heading would make
    // `anchorKind` claim "section-anchor" for a window a prose anchor earned.
    const hits = [{ line: 150, anchor: 'quoted' }, { line: 100, anchor: 'heading' }];
    assert.equal(clusterAnchorHits(hits, 240)[0].anchor, 'quoted');
  });

  it('a cluster is bounded by its SPAN, not by neighbour gaps', () => {
    // A chain of hits 100 apart must not grow into a 900-line "cluster" whose
    // centred window contains neither end.
    const hits = [0, 100, 200, 300, 400, 500].map((n) => ({ line: n + 1, anchor: `a${n}` }));
    const clusters = clusterAnchorHits(hits, 240);
    for (const c of clusters) assert.ok(c.max - c.min < 240, `cluster ${c.min}-${c.max} is wider than one window`);
  });

  it('divides both budgets by the window count, and never returns zero windows', () => {
    const three = planWindows(doc, ['needle'], { maxWindows: 3, perTerm: 3 });
    assert.ok(three.count >= 2);
    assert.equal(three.windowLines, Math.floor(CITED_SOURCE_WINDOW_LINES / three.count));
    assert.equal(three.maxChars, Math.floor(CITED_SOURCE_MAX_CHARS / three.count));

    const none = planWindows(doc, ['nothing here'], {});
    assert.equal(none.count, 1);
    assert.equal(none.centres[0].line, null, 'no anchor means an honest head window, not zero windows');
    assert.equal(none.windowLines, CITED_SOURCE_WINDOW_LINES, 'and it keeps the full budget');
  });
});
