#!/usr/bin/env node
/**
 * @fileoverview Drift-only gate for the `emit()` exit-code coupling
 * (docs/plans/cross-skill-command-registry.md §2b F4).
 *
 * `emit({ok:false})` sets `process.exitCode ||= 1` since 2026-08-12. The
 * opt-out — `emit(env, {softFail:true, reason})` — is legitimate but must not
 * accumulate: an exemption mechanism nobody counts becomes the default within a
 * year. This gate counts the opt-outs across the repo's CLIs and fails when the
 * count GROWS. Same shape as `cli:flags:gate` / `knip:gate` / `docs:refs:gate`:
 * a baseline that only shrinks, not a clean-tree requirement.
 *
 * It deliberately does NOT try to prove "every emitted ok:false exits non-zero"
 * by static analysis — that is a runtime property, it is enforced at the one
 * seam in `cli-io.mjs`, and `tests/emit-exit-coupling.test.mjs` owns it. A
 * second static oracle over the same invariant would be the two-oracles defect.
 * What a static scan CAN see, and what nothing else can, is the population of
 * declared exemptions.
 *
 * Usage:
 *   node scripts/check-emit-exit-agreement.mjs           # gate (exit 1 on growth)
 *   node scripts/check-emit-exit-agreement.mjs --json    # machine-readable
 *   node scripts/check-emit-exit-agreement.mjs --update  # re-baseline (deliberate)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit, hasFlag, assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

const KNOWN_FLAGS = ['--json', '--update', '--selfcheck-relocation', '--help'];

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['scripts'];
// Repo-root dotfile, matching .knip-baseline.json / .gate-contract-baseline.json.
// NOT under .audit-loop/, which holds Category-A volatile state: this baseline is a
// pure, deterministic function of committed source, so by the generated-artifact
// policy it is Category B — committed, and verified by the gate itself.
const BASELINE_PATH = path.join(REPO, '.emit-exit-baseline.json');

/**
 * `emit(<anything>, { … softFail: true … })` — the declared opt-out.
 *
 * `[^;]` bounds the match to a SINGLE STATEMENT. The first version used
 * `[\s\S]{0,400}?` and immediately counted this file's own help text, where the
 * string `'{softFail:true, reason}'` sits a few lines after an unrelated
 * `emit()` call — the same prose-contamination that has bitten three source-text
 * scans in this repo already. Stripping comments is not enough when the
 * explanation lives in a string literal; the statement bound is what fixes it.
 */
const OPT_OUT_RE = /\bemit\s*\([^;]{0,400}?softFail\s*:\s*true/g;

function listJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.claude-skills') continue;
      listJs(p, out);
    } else if (e.name.endsWith('.mjs')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Strip comments AND string literals before scanning.
 *
 * Both are necessary and the second was learned the hard way: this file's own
 * error message contains the literal `'…emit(env, {softFail:true, reason})…'`,
 * which a comment-stripping scan counted as a real opt-out — so the gate
 * baselined ITSELF at 1. A source scan that reads prose out of string literals
 * is measuring its own documentation. The `reason` string inside a genuine
 * opt-out is stripped too, harmlessly: `softFail: true` sits outside it.
 */
/** Replace a multi-line construct with its own newlines, so line numbers hold. */
const blankOut = (m) => m.replace(/[^\n]/g, '');
const STR_SQ = /'(?:\\.|[^'\\])*'/g;
const STR_DQ = /"(?:\\.|[^"\\])*"/g;
const STR_TPL = /`(?:\\.|[^`\\])*`/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/.*$/gm;

function stripStringsFirst(src) {
  return src
    .replace(BLOCK_COMMENT, blankOut)
    .replace(STR_SQ, "''")
    .replace(STR_DQ, '""')
    .replace(STR_TPL, blankOut)
    .replace(LINE_COMMENT, '');
}

/** The other ordering — comments before strings. See the union note in scanOptOuts. */
function stripCommentsFirst(src) {
  return src
    .replace(BLOCK_COMMENT, blankOut)
    .replace(LINE_COMMENT, '')
    .replace(STR_SQ, "''")
    .replace(STR_DQ, '""')
    .replace(STR_TPL, blankOut);
}

export function scanOptOuts(repoRoot = REPO) {
  const hits = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(repoRoot, d);
    if (!fs.existsSync(abs)) continue;
    for (const file of listJs(abs)) {
      const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
      // The two files that DEFINE and DOCUMENT the mechanism are not instances
      // of it. cli-io.mjs implements the opt-out; this gate explains it in an
      // operator message built from a template literal, which no amount of
      // string-stripping reliably reaches (a `+` chain of mixed template and
      // quoted fragments). Excluding the two authors of the mechanism is a
      // narrower and more honest rule than trying to parse JavaScript with a
      // regex — and a genuine opt-out could never live in either file.
      if (rel === 'scripts/lib/cli-io.mjs' || rel === 'scripts/check-emit-exit-agreement.mjs') continue;
      // Scanned under BOTH strip orderings, and the UNION is taken. A regex
      // cannot lex JavaScript: strings-then-comments mis-handles an apostrophe
      // in a line comment, comments-then-strings mis-handles a `//` inside a
      // string. Either ordering alone can therefore MISS a real opt-out, and a
      // false negative is the silent direction — the gate would under-report
      // growth it exists to catch. A false positive is a loud DRIFT message
      // someone corrects in a minute, so the union is the right trade.
      const raw = fs.readFileSync(file, 'utf8');
      const seen = new Map();
      for (const src of [stripStringsFirst(raw), stripCommentsFirst(raw)]) {
        for (const m of src.matchAll(OPT_OUT_RE)) {
          const line = src.slice(0, m.index).split('\n').length;
          // Keyed on line + COLUMN, not line alone. Two opt-outs on one line is
          // pathological, but the failure direction is what decides it: keying
          // on the line collapses them to one, and a ratchet that UNDER-counts
          // silently admits the growth it exists to refuse.
          const col = m.index - (src.lastIndexOf('\n', m.index) + 1);
          const key = `${line}:${col}`;
          if (!seen.has(key)) seen.set(key, { file: rel, line });
        }
      }
      hits.push(...seen.values());
    }
  }
  return hits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

/**
 * Read the baseline, FAILING CLOSED on anything that is not a well-formed one.
 *
 * It was a bare `JSON.parse`, and the consequence was measured: a baseline of
 * `{}` or `[]` yields `base.count === undefined`, and `hits.length > undefined`
 * is FALSE — so a corrupted or emptied baseline made the gate pass with real
 * opt-outs live. A gate that goes green on a damaged input is worse than no
 * gate, because it reports coverage it does not have. Treating a malformed
 * baseline as `count: 0` makes any opt-out at all read as growth, which is the
 * safe direction: loud and fixable rather than silent.
 */
function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { count: 0, files: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    process.stderr.write(`  [emit-exit] baseline is not valid JSON (${err.message}) — treating it as 0\n`);
    return { count: 0, files: {} };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !Number.isInteger(parsed.count) || parsed.count < 0) {
    process.stderr.write('  [emit-exit] baseline is malformed (expected {count:<int>, files:{}}) — treating it as 0\n');
    return { count: 0, files: {} };
  }
  return { count: parsed.count, files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {} };
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    // `process.argv` whole, and the options as an OBJECT. Both were wrong on the
    // first pass and they compounded: a pre-sliced array with the default
    // `from: 2` skips the first two real flags, and a bare string third argument
    // is not `{cli}` so it was ignored entirely. Net effect —
    // `check-emit-exit-agreement --bogus-flag` ran happily at exit 0, which is
    // precisely the accepted-and-inert defect `cli:flags:gate` exists to stop,
    // reintroduced inside a gate. Verified by executing it, not by reading.
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-emit-exit-agreement' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }

  const hits = scanOptOuts();
  const byFile = {};
  for (const h of hits) byFile[h.file] = (byFile[h.file] || 0) + 1;

  // `hasFlag`, not `.includes` — assertKnownFlags accepts `--update=true`, so a
  // bare includes() check would let the equals form pass validation and then
  // silently run the GATING path instead of re-baselining. That is the same
  // accepted-and-inert defect this gate's sibling fix closed in cli-io.mjs,
  // reproduced inside a gate (consolidated Gemini gate, round 2).
  if (hasFlag('update')) {
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify({ count: hits.length, files: byFile }, null, 2)}\n`);
    process.stderr.write(`  [emit-exit] baseline re-written: ${hits.length} declared opt-out(s)\n`);
    return;
  }

  const base = readBaseline();
  const grew = hits.length > base.count;
  const shrank = hits.length < base.count;

  if (hasFlag('json')) {
    emit({ ok: !grew, count: hits.length, baseline: base.count, grew, shrank, files: byFile });
    return;
  }

  if (grew) {
    const added = hits.filter((h) => (byFile[h.file] || 0) > (base.files?.[h.file] || 0));
    process.stderr.write(
      `  [emit-exit] DRIFT: ${hits.length} declared emit() exit-code opt-out(s), baseline ${base.count}.\n`
      + `${added.map((h) => `    ${h.file}:${h.line}\n`).join('')}`
      + '  An `emit(env, {softFail:true, reason})` says "this ok:false is not a process failure".\n'
      + '  If that is genuinely true here, re-baseline deliberately:\n'
      + '    node scripts/check-emit-exit-agreement.mjs --update\n',
    );
    process.exit(1);
  }
  if (shrank) {
    process.stderr.write(
      `  [emit-exit] ${hits.length} opt-out(s), down from ${base.count} — ratchet DOWN with:\n`
      + '    node scripts/check-emit-exit-agreement.mjs --update\n',
    );
    process.exit(1);
  }
  process.stderr.write(`  [emit-exit] ${hits.length} declared opt-out(s), at baseline\n`);
}

// `process.argv[1]` is undefined under `node --input-type=module -e`, which is
// how a test or a probe imports this module for its `scanOptOuts` export —
// guard it, or importing the module throws before the export is reachable.
if (process.argv[1]?.endsWith('check-emit-exit-agreement.mjs')) {
  main();
}
