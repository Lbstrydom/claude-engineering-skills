/**
 * @fileoverview The single source of truth for a plan's `Status:` line.
 *
 * Contract: docs/plans/reference-integrity-gate.md §2 "The status contract".
 *
 * Why this exists (R1-H2): making `Status:` authoritative while letting the
 * shell pre-push hook `grep` for it would recreate this plan's own root cause
 * one layer down — two implementations of one contract, drifting silently. The
 * hook is generated into consumer repos, so a drift there is invisible. So the
 * hook calls a CLI (`check-plan-status.mjs --select`) that imports THIS module;
 * nothing re-implements the parse.
 *
 * @module scripts/lib/plan-status
 */
import fs from 'node:fs';
import path from 'node:path';

// The status VOCABULARY (markdown spellings, DB spellings, and the normaliser)
// moved to shared-lib on 2026-07-20 so the stores domain (`plans-ship.mjs`)
// can validate against it without a `stores → plan` cross-domain edge. This
// module — the plan-domain PARSER — imports the shared contract and re-exports
// it, so `plan-status.mjs` stays the discoverable entry point for the
// plan-authoring side while `status-vocabulary.mjs` is the single definition.
// See status-vocabulary.mjs for the full rationale.
import { PLAN_STATUS_VOCABULARY, toDbPlanStatus, DB_PLAN_STATUSES } from './status-vocabulary.mjs';

export { PLAN_STATUS_VOCABULARY, toDbPlanStatus, DB_PLAN_STATUSES };

// Longest-token-first so `In Progress` matches before `In`. Each entry carries
// its kind. Derived from the vocabulary object so adding a kind above cannot
// leave its tokens unparseable here.
const TOKENS = Object.entries(PLAN_STATUS_VOCABULARY)
  .flatMap(([kind, tokens]) => tokens.map(token => ({ token, kind })))
  .sort((a, b) => b.token.length - a.token.length);

// The leading `- ` is OPTIONAL. The metadata block is conventionally a bullet
// list, but the corpus has a plan whose Status line is a bare `**Status**: …`
// (docs/plans/audit-tool-staleness-check.md). Requiring the bullet made that
// plan invisible to this parser while the dashboard's own looser regex still
// displayed its text — the exact "two implementations of one contract" drift
// this module exists to prevent. The corpus is the truth; the parser widens.
const STATUS_LINE_RE = /^-?\s*\*\*Status\*\*:\s*(.+)$/gm;

// A token is a prefix of the trimmed value followed by end-of-string or a
// separator. The separator class deliberately EXCLUDES the hyphen (so
// `Complete-ish` → unrecognized); a trailing `-` inside a bracket expression
// would be a literal hyphen and silently re-admit it (R3-M1).
const SEPARATOR = /[\s—–(:,.;]/;

/**
 * Join a metadata bullet's INDENTED continuation lines onto the bullet itself.
 *
 * `STATUS_LINE_RE` is anchored with `$` and `.` does not cross a newline, so
 * without this a wrapped status contributes only its FIRST line to `raw` —
 * every consumer then reads a fragment as if it were the whole value, with no
 * marker saying otherwise. That is not an edge case in this corpus: of the
 * plans carrying a Status line, **52 wrap** and only a handful do not.
 *
 * Indentation is the whole test, and it is corpus-derived rather than
 * stylistic. A wrapped status indents its continuations by two spaces; an
 * UNindented following line is a different metadata field —
 * `Date: 2026-07-13`, `**Owner**: Louis.`, `**Scope**: …` — which appears
 * after 7 of the Status lines here and must never be folded in, or the index
 * would attribute one field's text to another. A nested `- ` sub-bullet is
 * likewise its own item, and stays one.
 */
function foldListContinuations(header) {
  const lines = header.split('\n');
  const out = [];
  for (const line of lines) {
    const prev = out.length > 0 ? out[out.length - 1] : null;
    const continues = prev !== null
      && /^-?\s*\*\*|^\s*[-*]\s/.test(prev)
      && /^(?: {2,}|\t)\S/.test(line)
      && !/^\s*[-*]\s/.test(line)
      // Never swallow a second Status line: folding one into the first would
      // turn a `duplicate` (which check-plan-status FAILS on) into a silent
      // pass. Continuations that merely START with `**` are common and stay
      // foldable — `  **Round 2**: a later audit round…` is real corpus.
      && !/^\s*\*\*Status\*\*:/.test(line);
    if (continues) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(line);
  }
  return out.join('\n');
}

/**
 * Parse a plan document's Status line.
 * @param {string} content
 * @returns {{ok:true, token:string, kind:'terminal'|'active', raw:string}
 *          | {ok:false, reason:'absent'|'duplicate'|'implemented'|'unrecognized', raw?:string, rawStatusValues?:string[], message?:string}}
 *   `raw` is the status text as authored (present whenever a Status line was
 *   found) so display surfaces need no second regex. On `duplicate`, `raw` is
 *   the FIRST value and `rawStatusValues` carries all conflicting values in
 *   document order — so a surface can name what disagrees, not merely that
 *   something does.
 */
export function parsePlanStatus(content) {
  if (typeof content !== 'string') return { ok: false, reason: 'absent' };
  // Only the METADATA BLOCK counts — the leading region before the first `## `
  // (level-2) heading. Archived plans carry `- **Status**:` narrative lines
  // inside their audit trails (`## Audit trail` → `- **Status**: GPT audit
  // complete`); those are prose, not the plan's status, and must not read as
  // duplicates. A real duplicate (two Status lines in the header) is still
  // caught because both sit before the first `## `.
  const firstH2 = content.search(/^## /m);
  const header = foldListContinuations(firstH2 >= 0 ? content.slice(0, firstH2) : content);
  STATUS_LINE_RE.lastIndex = 0;
  const matches = [...header.matchAll(STATUS_LINE_RE)];
  if (matches.length === 0) return { ok: false, reason: 'absent' };
  if (matches.length > 1) {
    // Carry the conflicting values (WS-D R3-L1). Two reasons, and the second is
    // a real bug this closes:
    //  1. Display: without them the dashboard can say "malformed" but not WHICH
    //     values disagree, so the operator has to open the file to learn
    //     anything — and this function's own docstring already promises `raw` is
    //     "present whenever a Status line was found".
    //  2. Inclusion: `collect-reference.mjs` derives `hasStatusLine` from
    //     `parsed.raw != null`, and its documented rule is a UNION — a plan is
    //     included if it has a Status line OR a `# Plan:` H1. A plan with TWO
    //     Status lines self-evidently HAS one, so returning no `raw` made it
    //     fail the very signal it satisfies twice over.
    // `raw` is the first value (so single-value consumers keep working);
    // `rawStatusValues` is the full conflicting set, in document order.
    const values = matches.map((m) => (m[1] ?? '').trim());
    return { ok: false, reason: 'duplicate', raw: values[0], rawStatusValues: values };
  }

  // `raw` is the status text exactly as written (minus surrounding whitespace).
  // Returned so a display surface — the dashboard — can show what the author
  // wrote WITHOUT re-implementing this regex. That second implementation is
  // precisely how the dashboard drifted into showing "Complete" on a plan it had
  // bucketed as active.
  const raw = matches[0][1].trim();

  // Strip markdown emphasis markers, then trim. The real corpus form bolds the
  // TOKEN, not the whole value (`**Approved** — 3 GPT rounds`), so stripping only
  // whole-value wrappers misses it; `**`/`__` are never part of a status token,
  // so removing every occurrence is safe.
  const value = raw.replace(/\*\*|__/g, '').trim();

  // `Implemented` is rejected with a disambiguating message — it means "done" in
  // some corpus files and "partially done" in others, so it can never be aliased.
  if (/^Implemented\b/i.test(value)) {
    return {
      ok: false,
      reason: 'implemented',
      raw,
      message: '"Implemented" is ambiguous — use "Complete" (done) or "In Progress" (partially done).',
    };
  }

  for (const { token, kind } of TOKENS) {
    if (value.length < token.length) continue;
    if (value.slice(0, token.length).toLowerCase() !== token.toLowerCase()) continue;
    const next = value.slice(token.length);
    if (next.length === 0 || SEPARATOR.test(next[0])) {
      return { ok: true, token, kind, raw };
    }
  }
  return { ok: false, reason: 'unrecognized', raw };
}

// `*-audit-summary.md` is exempt from the vocabulary lint — docs/README.md
// mandates its free-text convergence sentence ("Audit-complete. 17 fixes
// applied."). `[\w-]+` (not `\w+`) so a hyphenated suffix
// (`…-audit-summary-phase-1.md`) is still exempted. Consolidated here (single
// source of truth) from two byte-identical copies in check-plan-status.mjs
// and generate-plans-index.mjs, flagged by `arch:duplicates` — this module is
// the natural home since both callers already import from it.
export const isAuditSummary = (name) => /-audit-summary(?:-[\w-]+)?\.md$/.test(name);

/** A plan is selectable iff it is a docs/plans/*.md that is not an audit-summary. */
function isSelectableName(name) {
  return name.endsWith('.md') && !isAuditSummary(name);
}

/**
 * Pick the single plan the pre-push hook should audit, or null.
 *
 * Shallow (docs/plans/*.md only — never recursive). Selectable iff
 * parsePlanStatus is `active`. Among actives, newest mtime wins, tie-broken
 * lexically; mtime is a non-portable heuristic (a fresh clone stamps every file
 * identically), so >1 active reports the ambiguity via `opts.warn`.
 *
 * @param {string} plansDir - absolute path to docs/plans
 * @param {{warn?: (msg:string)=>void}} [opts]
 * @returns {{path:string}|null}
 */
export function selectAuditPlan(plansDir, opts = {}) {
  const warn = opts.warn ?? (() => {});
  let entries;
  try { entries = fs.readdirSync(plansDir, { withFileTypes: true }); }
  catch { return null; }

  const actives = [];
  const unparseable = [];
  for (const e of entries) {
    if (!e.isFile() || !isSelectableName(e.name)) continue;
    const abs = path.join(plansDir, e.name);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const s = parsePlanStatus(content);
    if (s.ok && s.kind === 'active') {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { /* keep 0 */ }
      actives.push({ path: abs, name: e.name, mtimeMs });
    } else if (!s.ok) {
      // A plan whose Status prose doesn't match the vocabulary is INVISIBLE to
      // selection. Silently skipping it makes "no active plan to audit" a lie by
      // omission: the honest statement is "I could not read N candidates".
      // Field case (2026-07-19): a consumer's in-flight plan carried a free-text
      // Status ("Cluster 1 SHIPPED · Clusters 2c/2d/3 BLOCKED…"), so the plan
      // actually being implemented could never be selected, while two stale
      // active plans sat around winning the old mtime tiebreak. That is why the
      // pre-push audit had produced a verdict zero times.
      unparseable.push(e.name);
    }
  }
  // Report unreadable candidates whatever the outcome — it explains BOTH "nothing
  // selected" and "selected something surprising". The vocabulary lint
  // (`check-plan-status.mjs` with no --select) is the enforcing gate; consumers
  // that don't run it get this as the standing hint.
  if (unparseable.length > 0) {
    warn(`${unparseable.length} plan(s) have a non-conforming Status and are INVISIBLE to selection: ${unparseable.join(', ')}. Fix the Status line (active: Draft/Approved/In Progress · terminal: Complete/Superseded) or they can never be audited.`);
  }
  if (actives.length === 0) return null;

  // ── Bind the selection to the CHANGE, not to the clock ────────────────────
  // mtime answers "which plan did I touch last", which is not "which plan does
  // this push implement". When they diverge the audit runs against an unrelated
  // plan, its own A1 integrity guard aborts with "0 implementation files reached
  // the prompt", and — because the chooser starts the shadow comparison in
  // PARALLEL with the legacy promise — a paid shadow run still happens and
  // records an observation with comparison:null. Every such push spent money to
  // produce a structurally uncountable row (field-confirmed 2026-07-19).
  //
  // `changedFiles` (paths changed in the range being pushed) is the binding
  // signal: /ship updates a plan's Status + implementation log in the same push
  // that implements it, so the implemented plan is normally IN the diff.
  const changed = normalizeChangedPlanNames(opts.changedFiles);
  if (changed !== null) {
    const bound = actives.filter(a => changed.has(a.name));
    if (bound.length === 1) return { path: bound[0].path, boundBy: 'changed-file' };
    if (bound.length > 1) {
      // Genuinely ambiguous. Refuse rather than guess — picking by mtime here is
      // the exact coin-flip this block exists to remove.
      warn(`${bound.length} active plans changed in this push (${bound.map(a => a.name).join(', ')}); refusing to guess which one this change implements. Audit explicitly, or set AUDIT_PREPUSH_PLAN=<path>.`);
      return null;
    }
    // bound.length === 0 — nothing in this push touches an active plan. Fall
    // through: a SINGLE active plan is still unambiguous (no guess required).
  }

  if (actives.length === 1) return { path: actives[0].path, boundBy: 'sole-active-plan' };

  actives.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name));
  warn(`>1 active plan (${actives.length}) and none of them changed in this push (${actives.map(a => a.name).join(', ')}); refusing to pick by mtime — it is a heuristic, not the contract. Audit explicitly, or set AUDIT_PREPUSH_PLAN=<path>.`);
  return null;
}

/**
 * Reduce a caller-supplied changed-path list to a Set of plan BASENAMES.
 *
 * Accepts absolute or repo-relative paths with either separator (the hook feeds
 * `git diff --name-only`, which always emits POSIX separators, while callers on
 * Windows may pass native ones). Returns `null` — meaning "no change signal
 * available", distinct from an empty Set meaning "the push changed no plans" —
 * when the caller passed nothing, so an absent signal can never be read as
 * "nothing matched".
 *
 * @param {string[]|null|undefined} changedFiles
 * @returns {Set<string>|null}
 */
function normalizeChangedPlanNames(changedFiles) {
  if (!Array.isArray(changedFiles)) return null;
  const names = new Set();
  for (const raw of changedFiles) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const base = raw.split(/[\\/]/).pop();
    if (base && isSelectableName(base)) names.add(base);
  }
  return names;
}
