/**
 * @fileoverview Detector-first fix protocol — the census and the anti-mimicry check, in
 * ONE artifact.
 *
 * Two failure modes motivated this, both observed on 2026-07-31:
 *
 *  - **Undercount.** An audit reported 1 non-atomic writer; a repo-wide census found 4.
 *    It reported 3 misnamed call sites; a rename surfaced 5. An LLM enumerating a class by
 *    reading is a next-token predictor doing exhaustive search — it stops at the first few.
 *  - **Author mimicry.** Two fixes reproduced the class being fixed: a read-then-write
 *    guard written for a read-then-write bug, a pure string containment check written for
 *    a symlink bypass. The buggy shape is in the context window, so attention weights it.
 *
 * Both are answered by the same object: a deterministic query. The query that enumerates
 * the class is the query that catches the author's fix rejoining it. Write it once, and
 * convergence requires it to reach zero.
 *
 * **STRUCTURED, never a shell string.** An earlier design stored an executable `cmd` in
 * the adjudication ledger. That ledger is authored by an LLM and edited by merges —
 * storing a command there and running it is an injection surface, and interpolating
 * changed-file paths into it compounds it. Here `pattern` and `globs` reach ripgrep as
 * argv, and no string is ever concatenated into a command line.
 *
 * Plan: docs/plans/green-but-unrealized.md (Cluster B, Phase 4).
 *
 * @module scripts/lib/audit/detector
 */

import { spawnSync } from 'node:child_process';
import { z } from 'zod';

/** Closed set — `regex` is the only kind v1 needs; adding one is a schema change, not a string. */
export const DetectorSchema = z.object({
  kind: z.literal('regex'),
  pattern: z.string().min(1),
  globs: z.array(z.string().min(1)).min(1),
  baseline: z.number().int().nonnegative().optional(),
  /**
   * Keyed on `<path>::<trimmed matched line>`, NEVER a line number. A line number orphans
   * the moment anything above it shifts, and an orphaned disposition then fails the build
   * for a reason unrelated to the defect. The matched text survives insertions while still
   * forcing a fresh decision if the line itself changes.
   */
  disposition: z.record(z.string(), z.string()).default({}),
});

/**
 * Stable key for a match — see `disposition` above.
 *
 * `ordinal` distinguishes IDENTICAL text in the same file. Without it, four copies of
 * `fs.writeFileSync(tmp, data);` in one module collapse to one key, so dispositioning the
 * first dispositions all four — the "fixed 1 of 4 reads clean" undercount this module
 * exists to prevent, reproduced inside its own identity function. The ordinal counts only
 * among occurrences of that exact text, so it is unaffected by edits elsewhere in the file
 * and shifts only when one of the identical occurrences is added or removed, which is
 * precisely when a fresh decision is warranted.
 */
export function matchKey(file, line, ordinal = 0) {
  const base = `${file}::${String(line).trim()}`;
  return ordinal > 0 ? `${base}::#${ordinal}` : base;
}

/**
 * Run a detector and return every match.
 *
 * Uses ripgrep via argv. A non-zero exit with no output is ripgrep's "no matches" (exit 1)
 * and is a legitimate empty result; any other failure throws, because a detector that
 * silently yields zero matches because the tool broke is a false green — precisely the
 * shape this module exists to prevent.
 *
 * @param {object} detector — DetectorSchema-shaped
 * @param {{cwd?: string, run?: Function}} [opts] — `run` injectable for tests
 * @returns {{file: string, line: string, key: string}[]}
 */
export function runDetector(detector, { cwd = process.cwd(), run = spawnSync } = {}) {
  const d = DetectorSchema.parse(detector);

  // `--hidden`: without it ripgrep skips dot-directories, so a detector scoped to
  // `.claude/skills/**` or `.github/workflows/**` — committed trees, and exactly the kind a
  // cross-cutting finding targets — silently matches nothing and the gate reads clean.
  // `.gitignore` is still respected (so `.git/` and `node_modules/` stay out); the point is
  // to search the declared scope, not to widen it.
  const args = ['--no-heading', '--with-filename', '--line-number', '--no-config', '--hidden'];
  for (const g of d.globs) args.push('--glob', g);
  args.push('--regexp', d.pattern, '.');

  const res = run('rg', args, { cwd, encoding: 'utf-8', windowsHide: true });

  if (res.error) throw new Error(`detector: ripgrep unavailable (${res.error.message})`);
  if (res.status === 1) return [];                 // ripgrep: no matches
  if (res.status !== 0) {
    throw new Error(`detector: ripgrep exited ${res.status}: ${(res.stderr || '').trim().slice(0, 200)}`);
  }

  const seen = new Map();                              // `${file}::${text}` → count so far
  return String(res.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((raw) => {
      // `path:line:text`. Anchored on the LINE NUMBER rather than "the first two colons":
      // a colon is legal in a filename on Linux and macOS, and an index-based split would
      // then land inside the path and corrupt both the file and the key derived from it.
      // The text may contain any number of colons, so only the first `:<digits>:` counts.
      const m = /^(.*?):(\d+):(.*)$/.exec(raw);
      if (!m) return null;
      const file = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
      const line = m[3].trim();
      const ordinal = seen.get(`${file}::${line}`) ?? 0;
      seen.set(`${file}::${line}`, ordinal + 1);
      return { file, line, ordinal, key: matchKey(file, line, ordinal) };
    })
    .filter(Boolean);
}

/**
 * Are all of a ledger's detectors satisfied?
 *
 * **Runs at each detector's OWN full `globs` scope — never restricted to the round's
 * changed files.** Restricting to the diff defeats the census outright: fix 1 of 4
 * occurrences and the other 3 are absent from the diff, so the detector returns 0 and
 * convergence passes clean — the audit's undercount faithfully reproduced by the tool
 * built to prevent it. Full scope covers both gaps in one run: a class member left unfixed
 * still matches, and a NEW occurrence the author just wrote also matches.
 *
 * `baseline` is retained for reporting progress only. It is never the pass condition.
 *
 * @param {object} ledger — adjudication ledger; entries may carry `.detector`
 * @param {{cwd?: string, run?: Function}} [opts]
 * @returns {{blocked: boolean, undispositioned: object[], checked: number}}
 */
export function checkDetectors(ledger, opts = {}) {
  const entries = collectDetectorEntries(ledger);
  const undispositioned = [];
  const unverifiable = [];

  for (const { id, detector } of entries) {
    // A detector whose globs match NO FILE AT ALL has not censused anything — a typo'd
    // glob, a renamed directory, or a path `.gitignore` shadows returns zero matches and
    // reads exactly like a genuinely clean class. Same shape as the overlay-destination
    // check in check-gate-poison-pills.mjs: an input nothing reads is not evidence.
    let scanned;
    try {
      scanned = countFilesInScope(detector, opts);
    } catch (err) {
      // The census call is ripgrep too. Leaving it outside the guard let an exception
      // escape `checkDetectors` entirely — the very failure mode the catch below closes,
      // reintroduced by the fix for it, two lines above.
      unverifiable.push({ findingId: id, reason: `scope census failed: ${err.message}`, globs: detector.globs });
      continue;
    }
    if (scanned <= 0) {
      // 0 = the globs reach nothing; -1 = we could not find out. Both are "no census
      // happened", and neither may read as a clean class.
      unverifiable.push({
        findingId: id,
        reason: scanned === 0 ? 'globs matched no files' : 'scope census unavailable',
        globs: detector.globs,
      });
      continue;
    }
    let matches;
    try {
      matches = runDetector(detector, opts);
    } catch (err) {
      // runDetector throws when ripgrep is missing or fails — deliberately, because a
      // broken tool must never read as zero matches. Convert it to a BLOCKING verdict here
      // rather than an exception: the caller asked "did the class reach zero", and the
      // honest answer is "unknown", which must not converge.
      unverifiable.push({ findingId: id, reason: err.message, globs: detector.globs });
      continue;
    }
    for (const m of matches) {
      if (!Object.hasOwn(detector.disposition ?? {}, m.key)) {
        undispositioned.push({ findingId: id, ...m });
      }
    }
  }
  return {
    blocked: undispositioned.length > 0 || unverifiable.length > 0,
    undispositioned,
    unverifiable,
    checked: entries.length,
  };
}

/** How many files a detector's globs actually reach. Zero ⇒ nothing was censused. */
function countFilesInScope(detector, { cwd = process.cwd(), run = spawnSync } = {}) {
  const args = ['--files', '--no-config', '--hidden'];
  for (const g of detector.globs) args.push('--glob', g);
  const res = run('rg', args, { cwd, encoding: 'utf-8', windowsHide: true });
  if (res.error || (res.status !== 0 && res.status !== 1)) return -1;   // unknown, not zero
  return String(res.stdout || '').split(/\r?\n/).filter(Boolean).length;
}

/** Pull `{id, detector}` pairs out of a ledger of any of its two shapes. */
export function collectDetectorEntries(ledger) {
  const out = [];
  const visit = (id, entry) => {
    if (entry && typeof entry === 'object' && entry.detector) {
      out.push({ id: id ?? entry.id ?? '(unknown)', detector: entry.detector });
    }
  };
  if (Array.isArray(ledger)) ledger.forEach((e) => visit(e?.id, e));
  else if (ledger && typeof ledger === 'object') {
    if (Array.isArray(ledger.entries)) ledger.entries.forEach((e) => visit(e?.id, e));
    else for (const [k, v] of Object.entries(ledger)) visit(k, v);
  }
  return out;
}

/**
 * Is this finding cross-cutting — i.e. does it require a detector?
 *
 * `affectedFiles.length > 1`, full stop. An earlier design also scanned the finding's prose
 * for plurality words; model-generated text is not a semantic authority ("three duplicated
 * writers" contains no marker, while "check all callers" may describe one file).
 * `affectedFiles` is structured data the audit already emits. A single-file finding a
 * triager believes is a class can opt in explicitly with `crossCutting: true` — the
 * automatic trigger stays mechanical and under-inclusive rather than guessing.
 */
export function isCrossCutting(finding) {
  if (finding?.crossCutting === true) return true;
  return Array.isArray(finding?.affectedFiles) && finding.affectedFiles.length > 1;
}
