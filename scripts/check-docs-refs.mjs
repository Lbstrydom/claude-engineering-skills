#!/usr/bin/env node
/**
 * @fileoverview Reference-integrity gate — every cited repo path must resolve.
 *
 * Contract: docs/reference/reference-integrity.md (the grammar, the classes,
 * the exclusions). Plan: docs/plans/reference-integrity-gate.md.
 *
 * Why this exists: /ship's archive step moves a completed plan from `docs/plans/`
 * to `docs/completed/`, silently invalidating every reference to it. Nothing
 * verifies. The directory is a denormalized cache of the `Status:` line, and
 * nothing invalidates it.
 *
 * STATE OF PLAY (present tense on purpose — the archiver still exists today):
 * this module is Cluster A of the plan, and ships FIRST and ALONE because it is
 * the measurement instrument the rest is checked against. Consolidating to one
 * `docs/plans/` (Cluster B) is what removes the failure class by construction;
 * deleting the archiver is Cluster C. Until those land, this gate reports the
 * breakage rather than preventing it. It permanently catches what consolidation
 * cannot — typos, deleted targets, and refs to files that never existed.
 *
 * Deliberately narrow (mirroring check-docs-placement.mjs's doctrine): it
 * checks whether a cited path RESOLVES, not whether the citation is apt. That
 * judgement isn't mechanical, and a lint that guesses it would be noise —
 * noisy gates get bypassed, which is how the stale refs accumulated. So
 * placeholders are MARKED, never guessed.
 *
 * Usage:
 *   node scripts/check-docs-refs.mjs                 # human output
 *   node scripts/check-docs-refs.mjs --format json
 *   node scripts/check-docs-refs.mjs --gating        # findings also fail the run
 *
 * Exit codes:
 *   0 = scan completed (report-only: findings do not fail; --gating: they do)
 *   1 = scanner failure, or a finding under --gating
 *   2 = bad CLI input
 *
 * @module scripts/check-docs-refs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Bump when the grammar changes shape; the contract doc records the semantics. */
export const REFS_GRAMMAR_VERSION = 1;

// ── Grammar (docs/reference/reference-integrity.md §1) ─────────────────────
//
// Two mutually-exclusive alternatives. Directory segments are ALWAYS concrete;
// only the FINAL stem may be a bracketed placeholder or a glob.
//
// The regex IS the extractor: it terminates at `.md`, so trailing punctuation
// is never consumed. There is no extract-a-blob-then-validate step and no
// punctuation-stripping pass — an earlier draft put `.` in the trailing
// boundary class (extensions need it), which made `See docs/plans/x.md.`
// extract as `x.md.`, fail the `.md`-terminated rule, and fall SILENTLY into
// "not a citation". Every prose citation ending a sentence would have been
// dropped by the gate meant to catch them.
const SEG    = '[A-Za-z0-9._-]+';
const STEM   = '[A-Za-z0-9._-]+';
const PHSTEM = '(?:<[A-Za-z0-9._-]+>|[A-Za-z0-9._*-]*\\*[A-Za-z0-9._*-]*)';
const TOKEN  = `docs/(?:${SEG}/)*(?:${PHSTEM}|${STEM})\\.md`;

// Leading class includes `<>*` so a placeholder isn't truncated at `<`, and
// `/` so a cross-repo path (`wine-cellar-app/docs/plans/a.md`) is structurally
// invisible — no exclusion rule needed for it.
// Trailing is a negative LOOKAHEAD, not a boundary-class member, so `.mdx`
// correctly does not match.
const REF_RE = new RegExp(`(?<![A-Za-z0-9._/<>*-])(${TOKEN})(?![A-Za-z0-9_-])`, 'g');

// `(planned)` binds to its OWN token only: immediately following, separated by
// at most one space, or by a single closing backtick/paren then one space.
// Nothing else on the line, in the sentence, or in an enclosing block confers
// it — placeholder-ness and planned-ness are properties of the TOKEN.
//
// The separator is a LITERAL SPACE, not `\s`. `\s` also matches tab, CR and LF,
// which let a `(planned)` on the FOLLOWING LINE bind to this token and silently
// suppress a real GONE finding — exactly the "a loose implementation can
// suppress a real typo" failure the contract's attachment rule exists to
// prevent. Verified: with `\s?`, both `a.md\t(planned)` and `a.md\n(planned)`
// wrongly bound.
const PLANNED_RE = /^[`)]?[ ]?\(planned\)/;

/**
 * Extract every citation site from a chunk of text.
 * @param {string} text
 * @returns {Array<{target:string, kind:'concrete'|'placeholder', offset:number, planned:boolean, traversal:boolean}>}
 *   `offset` is a JS string index (UTF-16 code units) locating the token in the
 *   line — for traceability only, never used as a byte position.
 */
export function extractRefs(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(text)) !== null) {
    const target = m[1];
    const stem = target.slice(0, -'.md'.length).split('/').pop();
    out.push({
      target,
      kind: (stem.includes('<') || stem.includes('*')) ? 'placeholder' : 'concrete',
      offset: m.index,
      planned: PLANNED_RE.test(text.slice(m.index + target.length)),
      traversal: target.split('/').includes('..'),
    });
  }
  return out;
}

/**
 * Classify one extracted site against the git index.
 *
 * NOTE the vocabulary deliberately has NO `MOVED` class. `MOVED` is a claim
 * about relocation HISTORY, and this gate has no relocation map: before a move
 * the token simply resolves; after it, the token is indistinguishable from a
 * deletion. Inferring a move from a sibling directory would be exactly the
 * guessing this contract forbids. Relocation is a one-time migration concern
 * and belongs to the tool that owns the manifest.
 *
 * @param {object} ref - a site from extractRefs
 * @param {Set<string>} index - git-index paths (case-EXACT; see below)
 */
export function classifyRef(ref, index) {
  if (ref.traversal) return { class: 'traversal', target: ref.target, offset: ref.offset };
  if (ref.kind === 'placeholder') return { class: 'PLACEHOLDER', target: ref.target, offset: ref.offset };

  // Resolve against the GIT INDEX, not fs.existsSync: the index is case-exact,
  // so `docs/plans/Foo.md` for `foo.md` is a finding on case-insensitive
  // Windows AND on case-sensitive CI. fs.existsSync would disagree across
  // platforms and let a broken ref through locally.
  const resolved = index.has(ref.target);

  if (ref.planned) {
    // A marker cannot outlive its reason.
    return resolved
      ? { class: 'stale-planned-marker', target: ref.target, offset: ref.offset, resolved }
      : { class: 'PLANNED', target: ref.target, offset: ref.offset, resolved };
  }
  return { class: resolved ? 'RESOLVES' : 'GONE', target: ref.target, offset: ref.offset, resolved };
}

/** Classes that are findings (everything else is informational). */
const FINDING_CLASSES = new Set(['GONE', 'traversal', 'stale-planned-marker']);

// ── Scan policy ────────────────────────────────────────────────────────────
//
// "Walks every tracked file" and "skips unknown extensions" are in tension: an
// unlisted-but-text file would be SILENTLY omitted, yielding a green "0 refs"
// that never checked the changed citation. So there is no silent third state —
// an unknown kind is reported and fails the run.
// Every entry below was DERIVED from the real tracked inventory, not guessed —
// `tests/check-docs-refs.test.mjs` re-derives it from `git ls-files` on every
// run, so the policy cannot silently fall behind the repo. The first run of
// this gate surfaced 10 unclassified tracked files (.py/.jsx/.toml/.example
// fixtures, LICENSE, CODEOWNERS, .npmignore, .audit-loop/repo-id); each got an
// explicit decision here rather than a silent skip.
const TEXT_EXT = new Set([
  '.md', '.mjs', '.js', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.sql', '.sh',
  '.yml', '.yaml', '.html', '.css', '.txt', '.py', '.toml', '.example',
]);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2',
  '.ttf', '.eot', '.pdf', '.zip', '.gz', '.webp', '.mp4',
]);
// Extensionless files. `.gitignore` and `.githooks/*` carry real citations
// today; the rest are text that must be classified rather than skipped.
const TEXT_BASENAMES = new Set([
  '.gitignore', '.gitattributes', '.npmrc', '.nvmrc', '.npmignore',
  'Dockerfile', 'Makefile', 'LICENSE', 'CODEOWNERS', 'repo-id',
]);
const TEXT_DIR_PREFIXES = ['.githooks/'];

/**
 * @param {string} rel - repo-relative path (posix)
 * @returns {'text'|'binary'|'unclassified'}
 */
export function scanPolicy(rel) {
  const norm = String(rel).replace(/\\/g, '/');
  const base = norm.split('/').pop();
  const ext = path.extname(base).toLowerCase();
  if (ext && TEXT_EXT.has(ext)) return 'text';
  if (ext && BINARY_EXT.has(ext)) return 'binary';
  if (TEXT_BASENAMES.has(base)) return 'text';
  if (TEXT_DIR_PREFIXES.some(p => norm.startsWith(p))) return 'text';
  return 'unclassified';
}

// ── Exclusions ─────────────────────────────────────────────────────────────
//
// Each entry names WHY, so a stale exclusion is self-evident on read (the
// ROOT_ALLOWLIST convention from check-docs-placement.mjs). Add an entry only
// for a surface that genuinely cannot or must not be corrected — never to
// silence a real finding.
export const EXCLUSIONS = [
  {
    id: 'FROZEN',
    reason:
      'sha256-pinned migrations — setup-postgres.mjs pins a per-file hash over the WHOLE file, ' +
      'comments included, and refuses to re-apply on a mismatch. Editing a `-- Plan: …` banner in ' +
      'an applied migration breaks the migration ledger for every consumer repo. A stale citation ' +
      'here is permanent by design.',
    test: rel => rel.startsWith('supabase/migrations/'),
  },
  {
    id: 'CORPUS',
    reason:
      'the curated evidence corpus holds OTHER repos\' plan paths, mined from commits across three ' +
      'repos. They are not citations at all — they are data.',
    test: rel => /^docs\/experiments\/.*known-defects.*\.json$/.test(rel),
  },
  {
    id: 'VENDORED',
    reason:
      'a portable security kit whose files are path-mirrored to their destination on purpose; its ' +
      'paths describe the CONSUMER repo, not this one.',
    test: rel => rel.startsWith('docs/plans/security/files/'),
  },
  {
    id: 'HISTORICAL',
    reason:
      'an append-only session log. A past entry was true when it was written; rewriting it to keep ' +
      'a link green would falsify the record.',
    test: rel => rel === 'status.md',
  },
  {
    id: 'SPEC',
    reason:
      'the specification OF this grammar. A document that defines the citation notation must SHOW ' +
      'the notation — `docs/plans/a.md` as an example of a concrete token, `docs/plans/../x.md` as ' +
      'an example of traversal. Those are mentions, not claims (use vs mention), and they cannot be ' +
      'marked away: rewriting the concrete example as `docs/plans/<name>.md` would turn it into a ' +
      'PLACEHOLDER example and destroy the thing being illustrated. Precedent, same class, same repo: ' +
      'scripts/lib/model-eval/egress-path-scan.mjs documents its own security tooling self-tripping ' +
      'its own gate on its own pattern literals (2026-07-12), and carved the class out for exactly ' +
      'this reason. ACCEPTED TRADE-OFF, stated plainly: a REAL citation inside these two files goes ' +
      'unchecked. That is tolerable because they are specs (few real citations, and both are read ' +
      'end-to-end by anyone changing the grammar), and because the alternative — ~20 permanent ' +
      'un-fixable findings — is the noise-then-bypass spiral this gate exists to avoid. Deliberately ' +
      'a 4-file allowlist, NOT a `docs/reference/**` / `docs/plans/**` / `**/*refs*` glob: any wider ' +
      'and it would start hiding real breakage. The gate\'s own module and test file are in the set ' +
      'for the same reason and on the same precedent — egress-path-scan.mjs names "sensitive-paths.mjs, ' +
      'secret-patterns.mjs, THEIR TESTS" as the self-tripping set. A grammar\'s test fixtures are ' +
      'necessarily made of the tokens it parses.',
    test: rel => (
      rel === 'docs/reference/reference-integrity.md' ||
      rel === 'docs/plans/reference-integrity-gate.md' ||
      rel === 'scripts/check-docs-refs.mjs' ||
      rel === 'tests/check-docs-refs.test.mjs'
    ),
  },
];

/** @returns {{id:string, reason:string}|null} */
export function isExcluded(rel) {
  const norm = String(rel).replace(/\\/g, '/');
  return EXCLUSIONS.find(e => e.test(norm)) ?? null;
}

// ── Scanner ────────────────────────────────────────────────────────────────

/**
 * Lint one file. Symlink-safety is the caller's (runCheck's) job — this is the
 * text pass.
 */
export function lintFile(abs, { repoRoot, index, rel } = {}) {
  const relPath = (rel ?? path.relative(repoRoot ?? process.cwd(), abs)).replace(/\\/g, '/');
  const excluded = isExcluded(relPath);
  if (excluded) return { file: relPath, sites: [], excluded };

  const text = fs.readFileSync(abs, 'utf-8');
  const lines = text.split('\n');
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    for (const ref of extractRefs(lines[i])) {
      sites.push({ ...classifyRef(ref, index ?? new Set()), file: relPath, line: i + 1 });
    }
  }
  return { file: relPath, sites };
}

/**
 * Scan a set of repo-relative files.
 *
 * Fail-closed throughout (INC-001's lesson: canonicalise before deciding; never
 * "I couldn't classify it, so I'll allow it"). `ok` reflects SCANNER health, not
 * findings — Phase 1 ships report-only; `gating` makes findings fail too.
 */
export function runCheck({ repoRoot, files, index, gating = false } = {}) {
  const failures = [];
  const sites = [];
  const scanned = [];

  // "Audit your success paths": can this return 0 findings without having
  // checked anything? An empty scan set is not a green — it means the file
  // discovery broke.
  if (!files || files.length === 0) {
    failures.push({ rule: 'scan/empty-scan-set', message: 'no files to scan — discovery returned nothing; refusing to report a green' });
    return { ok: false, failures, findings: [], sites, scanned };
  }

  const rootReal = (() => {
    try { return fs.realpathSync(repoRoot); } catch { return path.resolve(repoRoot); }
  })();

  for (const rel of files) {
    const abs = path.join(repoRoot, rel);

    // 1. lstat FIRST — a symlink is refused outright, never opened. An
    //    ordinary fs.readFileSync FOLLOWS symlinks, and `git ls-files` can
    //    list a tracked symlink, so a lexically innocent name could resolve
    //    into ~/.ssh. That is INC-001's exact class. An extension allowlist is
    //    NOT a symlink defense.
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      failures.push({ rule: 'scanner/stat-failed', file: rel, message: err.message });
      continue;
    }
    if (st.isSymbolicLink()) {
      failures.push({ rule: 'scanner/symlink-refused', file: rel, message: 'symlink refused — not followed, not read' });
      continue;
    }
    if (!st.isFile()) continue;

    // 2. Canonicalise, then assert containment on the REAL root.
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch (err) {
      failures.push({ rule: 'scanner/realpath-failed', file: rel, message: err.message });
      continue;
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      failures.push({ rule: 'scanner/escaped-repo', file: rel, message: 'canonical path escapes repoRoot' });
      continue;
    }

    if (isExcluded(rel)) continue;

    // 3. Policy AFTER lstat, BEFORE read.
    const policy = scanPolicy(rel);
    if (policy === 'binary') continue;
    if (policy === 'unclassified') {
      failures.push({
        rule: 'scan/unclassified-input',
        file: rel,
        message: 'unclassified file kind — add it to TEXT_EXT/BINARY_EXT in scanPolicy() with an explicit decision. Refusing to skip silently.',
      });
      continue;
    }

    try {
      const r = lintFile(abs, { repoRoot, index, rel });
      sites.push(...r.sites);
      scanned.push(rel);
    } catch (err) {
      failures.push({ rule: 'scanner/read-failed', file: rel, message: err.message });
    }
  }

  const findings = sites.filter(s => FINDING_CLASSES.has(s.class));
  return {
    ok: failures.length === 0 && (!gating || findings.length === 0),
    failures,
    findings,
    sites,
    scanned,
  };
}

/** Tracked files, via the git index (inherits .gitignore for free). */
export function gitIndexFiles(repoRoot) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

// ── CLI ────────────────────────────────────────────────────────────────────

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

function main() {
  // Relocation smoke contract (AGENTS.md): proves imports survive relocation
  // into a consumer's scripts/.claude-skills/.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const argv = process.argv.slice(2);
  const jsonOut = argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'json';
  const gating = argv.includes('--gating');
  const repoRoot = process.cwd();

  let files;
  try {
    files = gitIndexFiles(repoRoot);
  } catch (err) {
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: `git ls-files failed: ${err.message}` }));
    else console.error(`${R}git ls-files failed: ${err.message}${X}`);
    process.exit(2);
  }

  const index = new Set(files.map(f => f.replace(/\\/g, '/')));
  const r = runCheck({ repoRoot, files, index, gating });

  const byClass = {};
  for (const s of r.sites) byClass[s.class] = (byClass[s.class] || 0) + 1;

  if (jsonOut) {
    console.log(JSON.stringify({
      ok: r.ok,
      grammarVersion: REFS_GRAMMAR_VERSION,
      gating,
      filesScanned: r.scanned.length,
      sites: r.sites.length,
      byClass,
      failures: r.failures,
      findings: r.findings,
    }, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  console.log(`${B}docs:refs${X} — ${r.scanned.length} file(s), ${r.sites.length} citation site(s), grammar v${REFS_GRAMMAR_VERSION}`);
  const order = ['RESOLVES', 'PLACEHOLDER', 'PLANNED', 'GONE', 'traversal', 'stale-planned-marker'];
  for (const c of order) {
    if (!byClass[c]) continue;
    const colour = FINDING_CLASSES.has(c) ? R : D;
    console.log(`  ${colour}${String(byClass[c]).padStart(4)} ${c}${X}`);
  }

  if (r.findings.length > 0) {
    console.log(`\n${R}${B}Findings${X} (${r.findings.length}):`);
    for (const f of r.findings.slice(0, 40)) {
      console.log(`  ${f.file}:${f.line}  ${R}${f.class}${X}  ${f.target}`);
    }
    if (r.findings.length > 40) console.log(`  ${D}… and ${r.findings.length - 40} more${X}`);
    console.log(`\n${D}How to fix each class: docs/reference/reference-integrity.md §5${X}`);
  }

  if (r.failures.length > 0) {
    console.error(`\n${R}${B}Scanner failures${X} (${r.failures.length}) — the scan is NOT trustworthy:`);
    for (const f of r.failures) console.error(`  ${R}${f.rule}${X} ${f.file ?? ''} — ${f.message}`);
  }

  if (!gating && r.findings.length > 0) {
    console.log(`\n${Y}report-only${X} — findings do not fail the run yet (see the plan's Phase 6).`);
  }
  process.exit(r.ok ? 0 : 1);
}

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) main();
