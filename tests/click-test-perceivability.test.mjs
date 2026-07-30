/**
 * @fileoverview Executable home for `/click-test`'s perceivability predicate.
 *
 * WHY THIS EXISTS (plan D16/D20, `docs/plans/skill-shadow-and-capture-honesty.md`).
 * The scanner is a fenced JS block inside a Markdown reference, not a module —
 * that is the skill's progressive-disclosure design and it stays. But the
 * severity cap it now applies is exactly the kind of logic that regresses
 * silently, and "verified empirically once against a live app" is not a
 * regression test. So this suite extracts the REAL fence and runs it in a REAL
 * browser against DOM fixtures.
 *
 * **Skip-vs-fail — corrected during the cluster-B audit (H6).** The plan (D16)
 * said a missing Chromium must FAIL, never skip, on gate-honesty grounds. That
 * was wrong *in application*: `npm run check` runs this suite on every push, so
 * hard-failing on an absent **browser binary** — which lives outside
 * `node_modules` and is provisioned separately by `npx playwright install
 * chromium` — would block every push on any machine or CI runner that never had
 * it. That is the cried-wolf gate AGENTS.md warns gets `--no-verify`'d, and the
 * repo already settled this: `tests/nav-live-activation.test.mjs` and
 * `nav-live-collector.test.mjs` both skip cleanly when Chromium is unavailable.
 * This suite follows that convention.
 *
 * Gate honesty is preserved by structure, not by a hard failure:
 *   - the **drift + static** assertions need no browser and ALWAYS run;
 *   - the skip is **loud** (a stderr notice naming the provisioning command),
 *     never a silent green;
 *   - the real empirical gate is a live `/click-test` run (plan V1), which a
 *     unit suite was never going to discharge.
 *
 * Two independent things are asserted:
 *   1. **Drift** — the fence still embeds the canonical `PERCEIVABLE_SOURCE`.
 *   2. **Behaviour** — the predicate's D10 matrix, and the resulting cap.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERCEIVABLE_SOURCE, normaliseForDriftCheck } from '../scripts/lib/browser/perceivable.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCANNER_MD = path.join(repoRoot, 'skills', 'click-test', 'references', 'dom-scanner.md');

/**
 * Pull the scanner's fenced JS block out of the reference document.
 *
 * Selects by CONTENT ANCHOR (the `() => {` scanner entry, which the doc
 * instructs the operator to paste into `browser_evaluate`), not by ordinal:
 * "the first fence" would silently start testing a different block the moment
 * the reference grows another `js` example above it.
 *
 * Zero or >1 candidates is a FAILURE, never a fallback to another fence — same
 * reasoning as skip-vs-fail.
 */
function extractScannerFence(md) {
  const fences = [...md.matchAll(/```js\n([\s\S]*?)\n```/g)].map(m => m[1]);
  const candidates = fences.filter(f => /^\s*\(\s*\)\s*=>\s*\{/.test(f));
  assert.equal(
    candidates.length, 1,
    `expected exactly 1 scanner fence (a "() => {" block) in dom-scanner.md, found ${candidates.length}. ` +
    'Refusing to guess which block is the scanner — fix the reference or this extractor.',
  );
  return candidates[0];
}

const scannerSrc = extractScannerFence(fs.readFileSync(SCANNER_MD, 'utf-8'));

describe('click-test perceivability — drift', () => {
  it('the scanner fence still embeds the canonical PERCEIVABLE_SOURCE', () => {
    // Containment, not equality: the fence necessarily holds the WHOLE scanner,
    // of which the predicate is one part — equality could never pass.
    // Normalised, not raw: the fence carries the block's own indentation, and
    // .gitattributes pins LF while a checkout may hold CRLF.
    const haystack = normaliseForDriftCheck(scannerSrc);
    const needle = normaliseForDriftCheck(PERCEIVABLE_SOURCE);
    assert.ok(
      haystack.includes(needle),
      'dom-scanner.md no longer embeds scripts/lib/browser/perceivable.mjs::PERCEIVABLE_SOURCE verbatim.\n' +
      'The module is the source of truth — edit it, then mirror into the fence.\n' +
      '/nav-audit --verify injects the same predicate, so a divergence here means two ' +
      'definitions of "rendered" and is exactly the drift this assertion exists to catch.',
    );
  });

  it('push() applies the predicate and preserves the pre-cap severity', () => {
    assert.match(scannerSrc, /const perceivable = __isPerceivable\(el\)/,
      'push() must call __isPerceivable — it is the single call site that tags every kind');
    assert.match(scannerSrc, /declaredSeverity: severity/,
      'push() must preserve declaredSeverity so the cap is auditable');
  });

  it('only a DEFINITE false caps — "unknown" must never be treated as perceivable', () => {
    // Cluster-B audit H8: an earlier predicate returned `true` when it could
    // not evaluate, so a finding kept its P0 on an assertion that never ran.
    // Guard both halves of the fix: the tri-state at the source, and the
    // strict `=== false` test at the consumer.
    assert.match(PERCEIVABLE_SOURCE, /return null;/,
      'the predicate must report UNKNOWN as null, never fall back to true');
    assert.ok(
      !/catch \(e\) \{\s*return true;/.test(PERCEIVABLE_SOURCE),
      'a catch returning true would re-introduce the "unevaluated reads as perceivable" defect',
    );
    assert.match(scannerSrc, /const capped = perceivable === false/,
      'push() must cap on a strict false — a truthiness test would cap on null too, failing closed');
    assert.match(scannerSrc, /perceivabilityUnknown/,
      'an unevaluated predicate must be surfaced on the finding, not silently dropped');
  });
});

describe('click-test perceivability — behaviour (real browser)', () => {
  let browser, page, available = false;

  before(async () => {
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
      available = true;
    } catch (err) {
      // Loud, never silent — a reader must be able to tell "did not run" from
      // "ran and passed". The drift assertions above still ran.
      process.stderr.write(
        `\n[click-test-perceivability] chromium unavailable — browser behaviour tests SKIPPED ` +
        `(${err.message.split('\n')[0]}).\n` +
        `  Provision it with: npx playwright install chromium\n` +
        `  The drift/static assertions DID run. The empirical gate is a live /click-test run.\n\n`,
      );
    }
  });

  after(async () => { if (browser) await browser.close(); });

  /** Render `html`, run the real scanner, return its findings. */
  async function scan(html) {
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    // The fence is an arrow-function EXPRESSION (the paste contract for
    // browser_evaluate), so it is invoked, not referenced by name. It is
    // written as a STATEMENT in the doc (`() => {...};`), so the trailing
    // semicolon must go before it can be wrapped in call parentheses.
    const expr = scannerSrc.trim().replace(/;+$/, '');
    return page.evaluate(`(${expr})()`).then(r => r.findings ?? r);
  }

  /** Find the finding for a given kind, if any. */
  const byKind = (findings, kind) => findings.find(f => f.kind === kind);

  it('a VISIBLE unlabelled input keeps its declared P0', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const f = byKind(await scan('<input type="text">'), 'input-no-name');
    assert.ok(f, 'expected an input-no-name finding for a visible unlabelled input');
    assert.equal(f.perceivable, true);
    assert.equal(f.severity, 'P0', 'a real, visible violation must NOT be capped');
    assert.equal(f.declaredSeverity, 'P0');
  });

  it('`<input type="file" hidden>` is demoted from P0 to P3 — the reported defect', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const f = byKind(await scan('<input type="file" hidden>'), 'input-no-name');
    assert.ok(f, 'the finding must still be EMITTED — demote, never drop');
    assert.equal(f.perceivable, false);
    assert.equal(f.severity, 'P3');
    assert.equal(f.declaredSeverity, 'P0', 'the intrinsic severity must stay visible for audit');
  });

  it('an element inside a visibility:hidden subtree is not perceivable', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const f = byKind(
      await scan('<div style="visibility:hidden"><input type="text"></div>'),
      'input-no-name',
    );
    assert.ok(f);
    assert.equal(f.perceivable, false, 'ancestor visibility:hidden must propagate — a real box, so zero-size cannot catch it');
    assert.equal(f.severity, 'P3');
  });

  it('opacity:0 is not perceivable (checkOpacity)', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const f = byKind(await scan('<div style="opacity:0"><input type="text"></div>'), 'input-no-name');
    assert.ok(f);
    assert.equal(f.perceivable, false);
  });

  it('an [inert] ancestor makes a painted element non-perceivable', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    // The regression guard for the checkVisibility gap: inert elements ARE
    // painted, so checkVisibility() alone returns true here.
    const f = byKind(await scan('<div inert><input type="text"></div>'), 'input-no-name');
    assert.ok(f);
    assert.equal(f.perceivable, false, 'checkVisibility() does not evaluate [inert] — the explicit term must');
  });

  it('content-visibility:hidden is not perceivable', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const f = byKind(
      await scan('<div style="content-visibility:hidden"><input type="text"></div>'),
      'input-no-name',
    );
    assert.ok(f);
    assert.equal(f.perceivable, false);
  });

  it('a position:fixed element IS perceivable (the offsetParent regression)', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    // offsetParent is null for position:fixed even when plainly visible — the
    // reason the fallback walks ancestors instead of using that shorthand.
    const f = byKind(
      await scan('<input type="text" style="position:fixed;top:10px;left:10px;width:80px;height:30px">'),
      'input-no-name',
    );
    assert.ok(f);
    assert.equal(f.perceivable, true);
    assert.equal(f.severity, 'P0');
  });

  it('a scrolled-out element IS perceivable (rendered, not on-screen)', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const f = byKind(
      await scan('<div style="height:5000px"></div><input type="text">'),
      'input-no-name',
    );
    assert.ok(f);
    assert.equal(f.perceivable, true, 'the predicate answers "rendered", not "in viewport"');
  });

  it('template-resident content is never scanned or reported', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const findings = await scan('<template><input type="text"></template>');
    assert.equal(byKind(findings, 'input-no-name'), undefined,
      'a <template>-resident node is inert content and must not produce findings');
  });

  it('the cap applies across kinds, not just inputs', async (t) => {
    if (!available) return t.skip('chromium unavailable');
    const f = byKind(await scan('<div hidden><button></button></div>'), 'button-no-name');
    assert.ok(f, 'button-no-name must still be emitted');
    assert.equal(f.perceivable, false);
    assert.equal(f.severity, 'P3');
    assert.equal(f.declaredSeverity, 'P0', 'one push() call site ⇒ every kind is tagged uniformly');
  });
});
