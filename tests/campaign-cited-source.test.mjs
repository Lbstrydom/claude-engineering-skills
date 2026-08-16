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
} from '../scripts/lib/campaign/cited-source.mjs';

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