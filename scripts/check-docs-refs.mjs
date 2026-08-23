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
 *   node scripts/check-docs-refs.mjs                 # human census (report-only)
 *   node scripts/check-docs-refs.mjs --format json
 *   node scripts/check-docs-refs.mjs --gating        # DRIFT-gate: fail on a ref
 *                                                    # NOT in BASELINE (net-new).
 *                                                    # Wired into `npm run check`
 *                                                    # as `docs:refs:gate`.
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

// Leading lookbehind excludes `/` so a cross-repo path
// (`wine-cellar-app/docs/plans/a.md`) is structurally invisible, and alnum/`.`/`-`
// so a token that is the SUFFIX of a longer path-word (`worddocs/…`) doesn't
// match mid-word. It does NOT exclude `*` or `_`: those are Markdown emphasis
// markers, and excluding them made a bold/italic-wrapped citation
// (`**docs/plans/a.md**`, `_docs/plans/a.md_`) invisible — a false NEGATIVE
// (consolidated Gemini gate G1). It does NOT exclude `<` either: a CommonMark
// angle-bracket link destination `[x](<docs/plans/a.md>)` is a real citation.
// The placeholder `<`/glob `*` live INSIDE the token (after `docs/plans/`),
// consumed by PHSTEM, so neither belongs in the leading class.
//
// Trailing is TWO negative lookaheads, not a boundary-class member:
//   (?![A-Za-z0-9_-])   — `.mdx`, `real.md-foo` are not this token
//   (?![./][A-Za-z0-9._-]) — a `.` or `/` that CONTINUES into a longer token is
//                          not a terminator: `docs/plans/real.md.bak` and
//                          `docs/plans/real.md/obsolete` must NOT yield
//                          `real.md`. The continuation class is `[A-Za-z0-9._-]`
//                          — it MUST equal SEG/STEM, because those permit `.`
//                          and `-` at every position, so `a.md.-foo` and
//                          `a.md..x` are continuations too (an earlier draft
//                          used `[A-Za-z0-9_]` and leaked both). But a `.`
//                          followed by end/space/punct IS a sentence period
//                          (`See docs/plans/a.md.`) and still terminates — the
//                          char after `.`/`/` must be a SEG char for the guard
//                          to fire. (A real longer `.md` file like
//                          `a.md.v2.md` still matches whole — it is a valid
//                          STEM + `.md`.)
const REF_RE = new RegExp(`(?<![A-Za-z0-9./-])(${TOKEN})(?![A-Za-z0-9_-])(?![./][A-Za-z0-9._-])`, 'g');

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
//
// Three accepted forms, and NOTHING else: `(planned)` immediately (no
// separator), one space then `(planned)`, or a single closing `` ` ``/`)` THEN
// ONE SPACE then `(planned)`. The closing char REQUIRES its following space —
// an earlier `[`)]?[ ]?` let `docs/plans/missing.md)(planned)` (a link's close
// paren immediately abutting the marker) bind and suppress a real GONE. That is
// the gate's cardinal sin (suppressing a real finding), so the space is
// mandatory after a closing char.
//
// The marker check skips, in order, the bits REF_RE leaves in the tail before a
// legitimately-adjacent `(planned)`:
//   (?:[#?][^\s`)]*)?  — an optional URL fragment/query. REF_RE stops at `.md`,
//                        so `[x](docs/plans/a.md#phase-1) (planned)` leaves
//                        `#phase-1) (planned)`; without this the check hits `#`
//                        and wrongly strips the marker (false POSITIVE).
//   (?:\]\([^)]+\))?   — a Markdown link DESTINATION following a label token. A
//                        self-linking label `[docs/plans/a.md](docs/plans/a.md)
//                        (planned)` yields two sites (contract §Contexts); the
//                        LABEL token's tail is `](docs/plans/a.md) (planned)`,
//                        so without this the label alone would be an
//                        un-suppressible GONE while the destination is planned —
//                        breaking the contract's "both resolve identically".
//   (?:[ \t]+"[^"]*")?  — an optional Markdown link TITLE after a destination
//                        (`[x](docs/plans/a.md "Title") (planned)`); without it
//                        the ` "Title"` blocked the marker (consolidated Gemini
//                        gate G2).
const PLANNED_RE = /^(?:[#?][^\s`)]*)?(?:[ \t]+"[^"]*")?(?:\]\([^)]+\))?(?:[`)] |[ ])?\(planned\)/;

// ── Code-path citations (live operational surfaces only) ───────────────────
//
// The `docs/**.md` grammar above cannot see a citation to `scripts/lib/foo.mjs`,
// `supabase/migrations/x.sql` or `.github/workflows/y.yml`. Measured 2026-07-31:
// 8,510 such citations across tracked markdown, 49 of them dangling on LIVE
// surfaces — including AGENTS.md pointing at a `supabase/migrations/…` timestamp
// that never existed. A gate whose banner says it verifies "cited repository
// paths" while 8,510 of them are structurally invisible is the success-path
// dishonesty this repo treats as HIGH.
//
// SCOPED TO LIVE SURFACES ON PURPOSE — this is semantics, not convenience. A
// plan, session transcript or research doc is a POINT-IN-TIME record: it citing a
// file that was renamed three weeks later is accurate history, and forcing it to
// track today's tree would corrupt the record. AGENTS.md, README, the runbooks,
// the references and the skills are different — they are read as instructions for
// the tree as it is NOW, so a dangling path there is a lie. (401 of the 547 raw
// dangles live in historical docs; baselining them would have buried the 49 that
// matter, which is how a gate gets --no-verify'd.)
const CODE_ROOT = '(?:scripts|tests|supabase|defaults|dashboard|\\.github|\\.githooks)';
const CODE_EXT  = '(?:mjs|cjs|js|ts|json|sql|sh|ya?ml)';
const CODE_TOKEN = `${CODE_ROOT}/(?:${SEG}/)*(?:${PHSTEM}|${STEM})\\.${CODE_EXT}`;
// Same boundary discipline as REF_RE: no leading `/`/alnum/`.`/`-` (so a
// cross-repo or mid-word hit is invisible), and no trailing path-ish character
// (so `scripts/a.mjs/b` is not read as a complete citation).
const CODE_REF_RE = new RegExp(
  `(?<![A-Za-z0-9./-])(${CODE_TOKEN})(?![A-Za-z0-9_-])(?![./][A-Za-z0-9._-])`, 'g',
);

/** Live operational surfaces — read as instructions for the CURRENT tree. */
const LIVE_SURFACE_RE = /^(?:AGENTS\.md|CLAUDE\.md|README\.md|skills\/|\.claude\/skills\/|docs\/reference\/|docs\/runbooks\/)/;

/** @param {string} relPath repo-relative, forward-slashed */
export function isLiveSurface(relPath) {
  return LIVE_SURFACE_RE.test(relPath);
}

/**
 * Paths that correctly do not exist HERE because they describe the CONSUMER
 * layout. `scripts/.claude-skills/**` is where this repo's tooling deploys INTO
 * another repo (AGENTS.md "Consumer-repo layout"); citing it from a runbook is
 * right, and its absence from this index is the whole point. Structural, not a
 * baseline entry: a baseline says "known rot, tolerated", and this is neither.
 */
export const CONSUMER_LAYOUT_PREFIXES = ['scripts/.claude-skills/'];

/** @param {string} target */
export function isConsumerLayoutPath(target) {
  return CONSUMER_LAYOUT_PREFIXES.some((p) => target.startsWith(p));
}

/**
 * Extract every citation site from a chunk of text.
 * @param {string} text
 * @param {{codePaths?: boolean}} [opts] - `codePaths` adds the code-path grammar
 *   (live surfaces only; see CODE_REF_RE's note on why it is not universal).
 * @returns {Array<{target:string, kind:'concrete'|'placeholder', offset:number, planned:boolean, traversal:boolean}>}
 *   `offset` is a JS string index (UTF-16 code units) locating the token in the
 *   line — for traceability only, never used as a byte position.
 */
export function extractRefs(text, { codePaths = false } = {}) {
  if (typeof text !== 'string') return [];
  const out = [];
  // matchAll clones the regex per spec, so it never mutates REF_RE's shared
  // lastIndex — no manual reset, no fragile global-state dependence (G3).
  for (const m of text.matchAll(REF_RE)) {
    const target = m[1];
    const stem = target.slice(0, -'.md'.length).split('/').pop();
    out.push({
      target,
      kind: (stem.includes('<') || stem.includes('*')) ? 'placeholder' : 'concrete',
      offset: m.index,
      // Cap the tail slice: PLANNED_RE only matches immediately-adjacent text,
      // so slicing the whole remainder per match is a needless O(N^2) copy in a
      // citation-dense file (G2). 200 chars comfortably covers a fragment + a
      // link destination + the marker.
      planned: PLANNED_RE.test(text.slice(m.index + target.length, m.index + target.length + 200)),
      traversal: target.split('/').includes('..'),
    });
  }
  if (codePaths) {
    for (const m of text.matchAll(CODE_REF_RE)) {
      const target = m[1];
      // Strip the real extension rather than a hardcoded '.md' — the code
      // grammar spans nine of them, and slicing a fixed length here would
      // silently mangle the stem the placeholder test reads.
      const last = target.split('/').pop();
      const stem = last.slice(0, last.lastIndexOf('.'));
      out.push({
        target,
        kind: (stem.includes('<') || stem.includes('*')) ? 'placeholder' : 'concrete',
        offset: m.index,
        planned: PLANNED_RE.test(text.slice(m.index + target.length, m.index + target.length + 200)),
        traversal: target.split('/').includes('..'),
      });
    }
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
  // A Category-A generated artefact is gitignored, so it is absent from the git
  // index this gate resolves against — but the citation is correct and must
  // stay. Resolving it here (rather than via EXCLUSIONS, which is SOURCE-side)
  // keeps every citing file still fully linted for its OTHER refs.
  const resolved = index.has(ref.target)
    || GENERATED_UNTRACKED_TARGETS.has(ref.target)
    // Absent BY DESIGN (consumer-side deploy layout), not rot — see
    // CONSUMER_LAYOUT_PREFIXES. Resolved here rather than baselined so the
    // citing file keeps being linted for all its other refs.
    || isConsumerLayoutPath(ref.target);

  if (ref.planned) {
    // A marker cannot outlive its reason.
    return resolved
      ? { class: 'stale-planned-marker', target: ref.target, offset: ref.offset, resolved }
      : { class: 'PLANNED', target: ref.target, offset: ref.offset, resolved };
  }
  return { class: resolved ? 'RESOLVES' : 'GONE', target: ref.target, offset: ref.offset, resolved };
}

/**
 * Cited targets that are deliberately gitignored generated artefacts.
 *
 * The gate's grammar only sees `docs/**\/*.md`, so this set is small by
 * construction — a Category-A artefact outside `docs/` (dashboard/index.html,
 * .audit-loop/domain-deps-observed.json) is already structurally invisible here.
 *
 * `docs/architecture-map.md` was reclassified B → A on 2026-07-20: it fails the
 * byte-identical test three ways over (a timestamp + commit sha + refresh_id in
 * its header, 33 LLM-written domain summaries in its body, and the cloud
 * symbol_index rather than committed source as its data source). AGENTS.md still
 * directs every agent to it, so the citations are right; only the tracking was
 * wrong. Regenerate with `npm run arch:render`.
 */
export const GENERATED_UNTRACKED_TARGETS = new Set([
  'docs/architecture-map.md',
  // Category A, gitignored at .gitignore:121. Regenerated by every `npm run
  // sync` and carrying volatile provenance (a timestamp + HEAD sha), so it is
  // never committed HERE — but the runbooks and AGENTS.md cite it correctly when
  // explaining the sync contract. Became visible only when the code-path grammar
  // landed; before that it was one of the artefacts this comment called
  // "structurally invisible".
  'scripts/.sync-manifest.json',
]);

/** Classes that are findings (everything else is informational). */
const FINDING_CLASSES = new Set(['GONE', 'traversal', 'stale-planned-marker']);

// ── Drift-gate baseline ─────────────────────────────────────────────────────
//
// The gate is DRIFT-ONLY (multi-LLM design review, 2026-07-18): under `--gating`
// it fails on a ref that NEWLY breaks, never on the standing total. That makes a
// noisy baseline free — write-target `--out` paths, never-produced generated
// artifacts, and illustrative comments sit here and never fire. Each entry is a
// real `docs/**.md` target absent from the index with NO correct mechanical fix
// (marking a real output path as a `<placeholder>` would be wrong). Key is
// `<file>→<target>`, line-independent. Shrinking this list (a baselined ref that
// later resolves) is always fine; a GONE NOT in it is drift and fails.
export const BASELINE = new Set([
  // never-produced audit-summary, cited in an archived plan
  'docs/plans/architecture-intent-framework.md→docs/completed/architecture-intent-framework-audit-summary.md',
  // generated `--out` / never-produced experiment docs
  'docs/plans/audit-effectiveness-experiment.md→docs/experiments/.../phase1-ledger.md',
  'docs/plans/audit-effectiveness-experiment.md→docs/experiments/audit-effectiveness/phase1-ledger-decomposition.md',
  'docs/plans/audit-effectiveness-experiment.md→docs/experiments/audit-effectiveness/phase5-decision.md',
  'docs/plans/audit-effectiveness-experiment.md→docs/experiments/audit-effectiveness/README.md',
  'package.json→docs/experiments/audit-effectiveness/phase1-ledger-decomposition.md',
  // Synthetic CLI payloads, not documentation references: the golden-envelope
  // capture table invokes `upsert-plan` / `update-plan-status` with a made-up
  // plan path to pin their refusal + cloud-off envelopes. The path must never
  // resolve (a real plan would make the fixture depend on repo contents), and
  // it cannot be rewritten to a `<placeholder>` — the string is an argument the
  // CLI parses, and the fixture pins the exact argv it was captured with.
  'scripts/dev/capture-cross-skill-envelopes.mjs→docs/plans/x.md',
  // tool-owned output cited from a runbook
  'docs/research/runbooks/model-ab-experiment.md→docs/arm-eval/worksheets/model-ab-adjudication-worksheet.md',
  // illustrative `// auth (docs/auth.md, …)` comment
  'scripts/lib/learning/author-tier-observation.mjs→docs/auth.md',
  // Deliberately-unpublished doc buckets (docs/upstream-issues/, docs/personal/).
  // These targets exist on the author's disk but are gitignored and untracked, so
  // they are absent from a fresh clone — the reference is intentional provenance,
  // not rot. Distinct from every other entry here: the others cite something never
  // produced or tool-generated; these cite something that EXISTS and is withheld.
  // Removing the citation would be worse than the dangling ref, because the claim
  // it supports ("this came from real field evidence") would lose its attribution.
  'docs/plans/sast-triage-routing.md→docs/upstream-issues/claude-engineering-skills-feedback-2026-07-19.md',
  'docs/plans/provenance-trailers-and-gate-honesty.md→docs/personal/ibm-fs-breadth-evidence-claude-engineering-skills.md',
  'status.md→docs/personal/ibm-fs-breadth-evidence-claude-engineering-skills.md',

  // ── code-path grammar (2026-07-31), live surfaces only ────────────────────
  // TOMBSTONES. `skill-surface-ownership.md` §"Retired tools" is a table OF
  // deletions: each row names a file and the date it was deleted. The citation
  // is correct precisely BECAUSE the target is gone — the gate's vocabulary has
  // `PLANNED` for "not yet" but nothing for "no longer", and inventing a marker
  // to silence a correct historical record would be worse than the entry here.
  // Removing the citations would destroy the retirement record itself.
  // Same tombstone shape: the skill now states the workflow was RETIRED (and
  // names the commit), so the filename must stay for the statement to be
  // checkable. This one is the gate catching itself — the citation was a live
  // FALSE CLAIM ("drift detection runs on every PR") until 2026-07-31.
  'skills/ai-context-management/SKILL.md→.github/workflows/context-drift.yml',
  '.claude/skills/ai-context-management/SKILL.md→.github/workflows/context-drift.yml',
  'docs/runbooks/consumer-adoption.md→scripts/foo.js',
  'docs/reference/skill-surface-ownership.md→scripts/check-skill-updates.mjs',
  'docs/reference/skill-surface-ownership.md→scripts/lib/install/merge.mjs',
  'docs/reference/skill-surface-ownership.md→scripts/lib/install/gitignore.mjs',
  // Illustrative stand-ins in operator prose ("`scripts/X.mjs` here,
  // `scripts/.claude-skills/X.mjs` in a consumer"). NOT rewritten as
  // `<placeholder>`: these sit in runnable command examples, and this repo's
  // operator-doc convention is real values or shell variables, never
  // angle-brackets (PowerShell reserves `<`, making the line unpasteable).
  'AGENTS.md→scripts/X.mjs',
  'README.md→scripts/X.mjs',
  'docs/reference/skill-surface-ownership.md→scripts/X.mjs',
  'docs/runbooks/consumer-adoption.md→scripts/X.mjs',
  'skills/ship/SKILL.md→scripts/foo.mjs',
  'skills/ship/SKILL.md→tests/foo.test.mjs',
  '.claude/skills/ship/SKILL.md→scripts/foo.mjs',
  '.claude/skills/ship/SKILL.md→tests/foo.test.mjs',
  // Consumer-side artefacts this repo describes but never contains: a transient
  // sync lockfile, a per-machine untracked repo list, and a consumer's own test
  // entry point. Never existed here and never will (verified via git log).
  'docs/runbooks/consumer-adoption.md→scripts/.sync-in-progress.json',
  'docs/runbooks/consumer-adoption.md→scripts/lib/consumer-repos.local.json',
  'docs/runbooks/consumer-adoption.md→scripts/automated-tests.js',
  // Spec files /ux-lock GENERATES inside a consumer repo; the reference
  // documents the helper layout it emits, not a file that lives here.
  'skills/ux-lock/references/scope-and-limitations.md→tests/e2e/helpers/auth.js',
  'skills/ux-lock/references/scope-and-limitations.md→tests/e2e/helpers/axe.js',
  '.claude/skills/ux-lock/references/scope-and-limitations.md→tests/e2e/helpers/auth.js',
  '.claude/skills/ux-lock/references/scope-and-limitations.md→tests/e2e/helpers/axe.js',
]);

const baselineKey = f => `${f.file}→${f.target}`;

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
  // .diff — text, and classified TEXT for the same reason as .sarif below: the
  // anchor-contract fixture diff carries real repo paths in its  headers,
  // so treating it as binary would skip a file whose contents genuinely ARE
  // references. Scanning it also means a fixture that drifts to name a deleted
  // path fails loudly instead of quietly citing nothing.
  '.diff',
  // .sarif is JSON (static-analysis interchange format), so it is scannable
  // text, not an opaque blob. Classified deliberately: the SARIF corpus fixture
  // carries tool-reported file paths, and treating it as binary would skip a
  // file whose contents genuinely look like references.
  '.sarif',
  // .jsonc is JSON-with-comments (knip.jsonc, JSON5-shaped tool configs) — text
  // for the same reason .sarif is: comments and values alike can carry a
  // repo-relative path worth checking, and it is never an opaque binary blob.
  '.jsonc',
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
  // actions/runner's own extensionless config basenames, synthesised (fake
  // values) in tests/fixtures/runner/synthetic-install/ for the runner-doctor
  // suite — all JSON or plain text, never opaque binaries.
  '.credentials', '.credentials_rsaparams', '.runner', '.service',
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
  {
    id: 'FIXTURE',
    reason:
      'test files are not documentation — they are private scratchpads. They CONSTRUCT synthetic ' +
      'doc paths as DATA (`docs/plans/a.md`, `docs/plans/zeta.md`, `docs/gone.md` written into temp ' +
      'dirs), not as citations of real files, so there is no real target to "fix". This is the same ' +
      'use-vs-mention class as SPEC, at subtree scale rather than per-file. STRUCTURAL scope, not a ' +
      'growing per-token allowlist (multi-LLM design review, 2026-07-18: OpenAI + Gemini both '+
      'independently recommended excluding the test surface wholesale — "test files are not ' +
      'documentation" — to eliminate ~65 false positives with one coherent semantic rule). ACCEPTED ' +
      'TRADE-OFF: a genuinely-stale docs citation inside a test comment goes unchecked. Tolerable ' +
      'under the drift-gate (a stale test comment breaks no one — "acceptable decay"), and the '+
      'gate\'s VALUE is protecting authored reference prose in docs/code, not test data.',
    test: rel => rel.startsWith('tests/'),
  },
  {
    id: 'TOOL_OWNED',
    reason:
      'append-only RUNTIME EXPORT archives, tool-written, not authored reference prose. ' +
      '`docs/arm-eval/**` is listed in docs/README.md under "Tool-owned directories — don\'t ' +
      'reorganise these" (an *output* of the arm-eval capture). Same class as HISTORICAL (status.md): ' +
      'a session export was true when written; editing it to keep a link green falsifies the record. ' +
      'Scoped to the declared tool-owned subtree, per docs/README.md.',
    test: rel => rel.startsWith('docs/arm-eval/'),
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
  const codePaths = isLiveSurface(relPath);
  for (let i = 0; i < lines.length; i++) {
    for (const ref of extractRefs(lines[i], { codePaths })) {
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
 * findings unless `gating`. Under `gating` the gate is DRIFT-ONLY: a finding whose
 * `<file>→<target>` key is in the BASELINE does not fail the run — only NET-NEW
 * breakage does. `baseline` defaults to BASELINE; pass an empty Set for absolute.
 */
export function runCheck({ repoRoot, files, index, gating = false, baseline = BASELINE } = {}) {
  const failures = [];
  const sites = [];
  const scanned = [];

  // "Audit your success paths": can this return 0 findings without having
  // checked anything? An empty scan set is not a green — it means the file
  // discovery broke.
  if (!files || files.length === 0) {
    failures.push({ rule: 'scan/empty-scan-set', message: 'no files to scan — discovery returned nothing; refusing to report a green' });
    return { ok: false, failures, findings: [], drift: [], baselined: 0, sites, scanned };
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
  // Drift = findings NOT in the baseline. Under --gating, only drift fails.
  const drift = findings.filter(f => !baseline.has(baselineKey(f)));

  // Self-cleaning baseline (M3): a BASELINE entry whose target now RESOLVES is
  // STALE — the suppression outlived its reason (same doctrine as
  // stale-planned-marker). It must be removed from BASELINE, so it is drift-
  // failing under --gating. Without this, a baselined ref that gets fixed and
  // later regresses would be silently re-accepted.
  const resolvingSites = new Set(sites.filter(s => s.class === 'RESOLVES').map(baselineKey));
  const staleBaseline = [...baseline].filter(k => resolvingSites.has(k));
  for (const k of staleBaseline) drift.push({ class: 'stale-baseline-entry', key: k });

  return {
    ok: failures.length === 0 && (!gating || drift.length === 0),
    failures,
    findings,
    drift,
    staleBaseline,
    baselined: findings.length - findings.filter(f => !baseline.has(baselineKey(f))).length,
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
      baselined: r.baselined,
      drift: r.drift,
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

  if (gating) {
    if (r.drift.length > 0) {
      console.error(`\n${R}${B}DRIFT${X} (${r.drift.length}) — ref(s) that newly broke (not in the baseline):`);
      for (const f of r.drift.slice(0, 40)) console.error(`  ${f.file}:${f.line}  ${R}${f.class}${X}  ${f.target}`);
      console.error(`\n${D}Fix the ref, mark it (planned)/<placeholder>, or (a real new exempt surface) add an exclusion. Baseline: BASELINE in scripts/check-docs-refs.mjs.${X}`);
    } else {
      console.log(`\n${G}drift-gate: clean${X} — ${r.baselined} finding(s) in the accepted baseline, 0 net-new.`);
    }
  } else if (r.findings.length > 0) {
    console.log(`\n${Y}report-only${X} — findings do not fail the run (pass --gating for the drift-gate).`);
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
