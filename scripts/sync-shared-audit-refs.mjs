#!/usr/bin/env node
/**
 * @fileoverview Sync shared audit-loop reference files from a single
 * canonical source under `docs/audit/shared-references/` to each consuming
 * skill's `references/` directory.
 *
 * Why: Phase 1 of audit-loop-skill-split ships two reference files
 * (ledger-format.md, gemini-gate.md) that are SHARED between /audit-plan
 * and /audit-code. Without a single source of truth, edits to one would
 * silently drift from the other. This script enforces byte-equality.
 *
 * Discovery is automatic: each consumer skill that wants a shared ref simply
 * has a file at `skills/<name>/references/<canonical-basename>`. The script
 * walks `skills/*\/references/` and overwrites any matching file from the
 * canonical. Skills that don't have the file are unaffected.
 *
 * Usage:
 *   node scripts/sync-shared-audit-refs.mjs              # sync canonical → targets
 *   node scripts/sync-shared-audit-refs.mjs --check      # exit 1 on any drift
 *   node scripts/sync-shared-audit-refs.mjs --dry-run    # report, no writes
 *
 * Exit codes:
 *   0  success (sync mode) OR no drift (check mode)
 *   1  drift detected (check mode)
 *   2  canonical source missing or unreadable
 *
 * @module scripts/sync-shared-audit-refs
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha, assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CANONICAL_DIR = path.join(ROOT, 'docs', 'audit', 'shared-references');
const SKILLS_DIR = path.join(ROOT, 'skills');

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m';


/**
 * Expected consumers per canonical file. Skills listed here MUST have the
 * canonical reference at `skills/<skill>/references/<basename>`; --check mode
 * fails if any expected target is missing. Other skills that happen to have
 * the file are also auto-discovered and synced (so unregistered consumers
 * stay current without registry edits).
 *
 * Update this map when a new skill needs a shared audit reference; the
 * sync will then bootstrap the file on first run rather than silently
 * skipping (this closes the gap raised by Gemini final review).
 */
export const EXPECTED_CONSUMERS = Object.freeze({
  'ledger-format.md': ['audit-plan', 'audit-code'],
  'gemini-gate.md': ['audit-plan', 'audit-code'],
  'prerequisite-ladder.md': ['audit-plan', 'audit-code'],
  'verification-discipline.md': [
    'investigate', 'audit-code', 'ux-lock', 'ship', 'explain', 'plan', 'audit-plan',
    'nav-audit',
  ],
});

/**
 * For each canonical file, return the (canonical, target) pairs to sync.
 *
 * Two sources combined:
 *   1. EXPECTED_CONSUMERS — skills that must have the file. Always returned,
 *      even when the target file does not yet exist (bootstrap case).
 *   2. Auto-discovery — any other `skills/<skill>/references/<basename>`
 *      already on disk. Keeps unregistered consumers in sync.
 *
 * Each pair carries `expected: true|false` so callers can distinguish the
 * bootstrap targets from the opportunistic ones.
 */
export function findSyncTargets(rootDir = ROOT) {
  const canonicalDir = path.join(rootDir, 'docs', 'audit', 'shared-references');
  const skillsDir = path.join(rootDir, 'skills');
  if (!fs.existsSync(canonicalDir)) return [];

  // Sort for deterministic output across runs / OSes.
  const canonicals = fs.readdirSync(canonicalDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => ({ basename: f, abs: path.join(canonicalDir, f) }));

  const pairs = [];
  const seen = new Set();

  // Step 1: registry-driven targets (always emit, even if missing on disk)
  for (const c of canonicals) {
    const expectedSkills = EXPECTED_CONSUMERS[c.basename] || [];
    for (const skill of expectedSkills) {
      const target = path.join(skillsDir, skill, 'references', c.basename);
      pairs.push({ canonical: c.abs, target, skill, basename: c.basename, expected: true });
      seen.add(target);
    }
  }

  // Step 2: auto-discover other consumers (existing files only)
  if (fs.existsSync(skillsDir)) {
    const allSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
    for (const skill of allSkills) {
      const refsDir = path.join(skillsDir, skill, 'references');
      if (!fs.existsSync(refsDir)) continue;
      for (const c of canonicals) {
        const target = path.join(refsDir, c.basename);
        if (seen.has(target)) continue;
        if (fs.existsSync(target)) {
          pairs.push({ canonical: c.abs, target, skill, basename: c.basename, expected: false });
        }
      }
    }
  }

  return pairs;
}

/**
 * Every flag this CLI reads. Declared beside `main()` and asserted inside it —
 * this module is imported by `tests/sync-shared-audit-refs.test.mjs` for its
 * exports, so throwing at module scope would break that import.
 *
 * Neither flag takes a value; both are booleans.
 */
const KNOWN_FLAGS = ['--check', '--dry-run', '--selfcheck-relocation'];

/**
 * Apply (or report on) a set of canonical→target pairs.
 *
 * Split out of `main()` so the BOOTSTRAP path is directly testable against a
 * temp repo: `main()` resolves pairs from the module-level `ROOT`, which is
 * pinned to this checkout, so nothing could previously exercise a first-run
 * write. That is precisely how the bug below shipped undetected.
 *
 * **The bug this encodes a fix for.** `findSyncTargets` emits registry-driven
 * pairs "even if missing on disk" — that is what makes registering a new
 * consumer bootstrap its file, exactly as this module's header promises. But
 * the old loop called `fs.readFileSync(target)` unconditionally, so the first
 * missing target threw ENOENT and killed the run before anything was written.
 * The documented bootstrap had never once executed, and `--check` crashed
 * rather than reporting DRIFT. A missing target is now an EMPTY buffer — i.e.
 * drift, which every branch already handled correctly.
 *
 * @param {Array<{canonical:string,target:string,skill:string,basename:string}>} pairs
 * @param {{check?:boolean, dry?:boolean}} [opts]
 * @returns {{writes:number, unchanged:number, drift:number, bootstrapped:number, lines:string[]}}
 */
/**
 * Re-express a canonical document for ONE target location.
 *
 * PURE, and the reason the sync is no longer a byte copy. Two defects came
 * from copying bytes verbatim (raised by the consolidated audit as M1/M3 and
 * pre-existing across all 11 pairs):
 *
 *  1. **Relative links resolved only from the canonical's own directory.**
 *     `](../../plans/foo.md)` is correct from `docs/audit/shared-references/`
 *     and points at a non-existent `skills/plans/` from a skill's
 *     `references/`. No single byte string can be right in both places, so the
 *     link has to be RECOMPUTED per target rather than copied.
 *  2. **Every copy asserted it was the canonical**, including the instruction
 *     "Edit this file, never a copy" — advice that is exactly backwards when
 *     read in the copy it is telling you to edit.
 *
 * Both are fixed here rather than by editing the canonical, because the
 * canonical is CORRECT about itself; it is the copy that needs different text.
 *
 * Only `./`- and `../`-prefixed link targets are touched. Absolute paths,
 * URLs, anchors and reference-style links are left exactly as written.
 *
 * @param {string} srcText - canonical file contents
 * @param {string} canonicalPath - absolute path of the canonical
 * @param {string} targetPath - absolute path this copy will be written to
 * @param {string} repoRoot - absolute repo root, for the banner's pointer
 * @returns {string}
 */
export function renderForTarget(srcText, canonicalPath, targetPath, repoRoot) {
  const fromDir = path.dirname(canonicalPath);
  const toDir = path.dirname(targetPath);
  const canonRel = path.relative(repoRoot, canonicalPath).replaceAll('\\', '/');

  // Markdown inline links: `](target)` — the `(` group stops at the first
  // whitespace so an optional `"title"` survives untouched.
  const rewritten = srcText.replaceAll(
    /\]\((\.\.?\/[^)\s]+)([^)]*)\)/g,
    (whole, link, rest) => {
      const abs = path.resolve(fromDir, link);
      const rel = path.relative(toDir, abs).replaceAll('\\', '/');
      // path.relative drops the leading `./` for a sibling; markdown is happier
      // with it present and it keeps the link visibly relative.
      const prefixed = rel.startsWith('.') ? rel : `./${rel}`;
      return `](${prefixed}${rest})`;
    },
  );

  // Replace the canonical's self-description with a provenance banner. Matched
  // on the sentence, not a line number, so an edit to the surrounding prose
  // does not silently stop the substitution — it would show up as drift.
  const SELF_DESC = /This is the canonical copy\.[\s\S]*?\*\*Edit this file, never a copy\.\*\*/;
  const banner = `> **GENERATED COPY — do not edit.** The canonical is\n`
    + `> [\`${canonRel}\`](${path.relative(toDir, canonicalPath).replaceAll('\\', '/')}).\n`
    + `> Regenerate with \`node scripts/sync-shared-audit-refs.mjs\`; \`npm run check\`\n`
    + `> fails on drift. Relative links above were rewritten for this location,\n`
    + `> so this file is NOT byte-identical to the canonical by design.`;

  // Pure transform: substitute when the sentence is there, otherwise leave the
  // text alone. It deliberately does NOT refuse a canonical that lacks the
  // sentence — this function is also the link-rewriter unit under test, and it
  // must stay IDEMPOTENT on an already-rendered copy (which carries the banner,
  // not the sentence). The provenance invariant is enforced one level up, in
  // `syncPairs`, which is the caller that actually knows it is producing a copy
  // FROM a canonical. See the round-6 audit M5 note there.
  return SELF_DESC.test(rewritten) ? rewritten.replace(SELF_DESC, banner) : rewritten;
}

/** The sentence `renderForTarget` substitutes for the generated-copy banner. */
export const CANONICAL_SELF_DESCRIPTION = /This is the canonical copy./;

export function syncPairs(pairs, { check = false, dry = false } = {}) {
  let writes = 0, unchanged = 0, drift = 0, bootstrapped = 0;
  const lines = [];

  for (const { canonical, target, skill, basename } of pairs) {
    // Rendered per target, not copied: relative links must resolve from the
    // COPY's directory, and the copy must not claim to be the canonical.
    //
    // **A canonical with no self-description is REFUSED here** (round-6 audit
    // M5). `renderForTarget` substitutes that sentence for the GENERATED COPY
    // banner, and when it is absent the substitution is a silent no-op: sync
    // reported success and the copy sat in `skills/*/references/` claiming
    // nothing about being generated. That is how `gemini-gate.md` and
    // `ledger-format.md` shipped unmarked copies for their whole life — a
    // success path that returned green having done nothing. Checked on the
    // canonical's own bytes, before rendering, because after rendering the
    // sentence is gone by design.
    const canonicalText = fs.readFileSync(canonical, 'utf-8');
    if (!CANONICAL_SELF_DESCRIPTION.test(canonicalText)) {
      throw new Error(
        `sync-shared-audit-refs: ${basename} carries no canonical self-description, so its `
        + 'generated copies would claim nothing about being generated. Add '
        + '"This is the canonical copy. … **Edit this file, never a copy.**" to '
        + `${canonical} — renderForTarget substitutes it for the GENERATED COPY banner.`,
      );
    }
    const srcBuf = Buffer.from(
      renderForTarget(canonicalText, canonical, target, ROOT),
      'utf-8',
    );
    const exists = fs.existsSync(target);
    const dstBuf = exists ? fs.readFileSync(target) : Buffer.alloc(0);
    if (exists && sha(srcBuf) === sha(dstBuf)) {
      unchanged++;
      continue;
    }
    drift++;
    if (!exists) bootstrapped++;
    if (check) {
      lines.push(`${R}~${X} skills/${skill}/references/${basename} ${D}${
        exists ? 'drifted from canonical' : 'MISSING — never bootstrapped'}${X}\n`);
    } else if (dry) {
      lines.push(`${Y}~${X} skills/${skill}/references/${basename} ${D}(would ${
        exists ? 'update from canonical' : 'bootstrap'})${X}\n`);
    } else {
      // `skills/<skill>/references/` may not exist at all when this is a
      // skill's FIRST shared reference (true for explain and audit-plan).
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, srcBuf);
      writes++;
      // A first write and a re-sync are different events; say which.
      lines.push(`${G}+${X} skills/${skill}/references/${basename} ${D}(${
        exists ? 'synced from canonical' : 'bootstrapped'})${X}\n`);
    }
  }

  return { writes, unchanged, drift, bootstrapped, lines };
}

function main() {
  // The default path OVERWRITES each consumer skill's reference file from the
  // canonical, so `--check`/`--dry-run` are safety flags over a mutating
  // default: a dropped `--chek` performs the real sync. Guard first.
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'sync-shared-audit-refs' });

  // AGENTS.md CLI smoke contract (Step 7.1 of the 2026-08-27 audit, accepting
  // Gemini's wrongly_dismissed on M6): this script IS synced to consumers
  // (scripts/lib/sync-path-map.mjs maps it into scripts/.claude-skills/), so
  // it needs to prove its imports survive relocation — the condition the
  // contract is scoped to. Handled before any mutating path runs.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const DRY = process.argv.includes('--dry-run');
  const CHECK = process.argv.includes('--check');

  if (!fs.existsSync(CANONICAL_DIR)) {
    process.stderr.write(`${R}canonical dir missing: ${CANONICAL_DIR}${X}\n`);
    process.exit(2);
  }

  const pairs = findSyncTargets(ROOT);
  const { writes, unchanged, drift, lines } = syncPairs(pairs, { check: CHECK, dry: DRY });
  for (const line of lines) process.stdout.write(line);

  const verdict = drift === 0 ? 'IN SYNC' : (CHECK ? 'DRIFT' : 'CHANGES');
  process.stdout.write(
    `\n${B}sync-shared-audit-refs:${X} ${pairs.length} pair(s), ${writes} write, ${unchanged} unchanged, ${drift} drifted — ${verdict}\n`,
  );

  if (CHECK && drift > 0) {
    process.stderr.write(
      `${R}Shared reference drift detected. Run: node scripts/sync-shared-audit-refs.mjs${X}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const invokedDirectly = (() => {
  try {
    const metaPath = new URL(import.meta.url).pathname.toLowerCase();
    const argvPath = process.argv[1] ? new URL(`file://${process.argv[1].replaceAll(/\\/g, '/')}`).pathname.toLowerCase() : '';
    return metaPath.endsWith('/sync-shared-audit-refs.mjs') && argvPath.endsWith('/sync-shared-audit-refs.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    // A usage mistake is not a crash: print the flag diagnostic alone (no
    // stack) and exit 2, matching the other guarded CLIs.
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}
