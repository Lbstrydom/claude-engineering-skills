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

/** The CLOSED status vocabulary. Anything else is `unrecognized`. */
export const PLAN_STATUS_VOCABULARY = Object.freeze({
  terminal: ['Complete', 'Superseded'],
  active: ['Draft', 'Approved', 'In Progress'],
});

// Longest-token-first so `In Progress` matches before `In`. Each entry carries
// its kind.
const TOKENS = [
  ...PLAN_STATUS_VOCABULARY.terminal.map(t => ({ token: t, kind: 'terminal' })),
  ...PLAN_STATUS_VOCABULARY.active.map(t => ({ token: t, kind: 'active' })),
].sort((a, b) => b.token.length - a.token.length);

const STATUS_LINE_RE = /^- \*\*Status\*\*:\s*(.+)$/gm;

// A token is a prefix of the trimmed value followed by end-of-string or a
// separator. The separator class deliberately EXCLUDES the hyphen (so
// `Complete-ish` → unrecognized); a trailing `-` inside a bracket expression
// would be a literal hyphen and silently re-admit it (R3-M1).
const SEPARATOR = /[\s—–(:,.;]/;

/**
 * Parse a plan document's Status line.
 * @param {string} content
 * @returns {{ok:true, token:string, kind:'terminal'|'active'}
 *          | {ok:false, reason:'absent'|'duplicate'|'implemented'|'unrecognized', message?:string}}
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
  const header = firstH2 >= 0 ? content.slice(0, firstH2) : content;
  STATUS_LINE_RE.lastIndex = 0;
  const matches = [...header.matchAll(STATUS_LINE_RE)];
  if (matches.length === 0) return { ok: false, reason: 'absent' };
  if (matches.length > 1) return { ok: false, reason: 'duplicate' };

  // Strip markdown emphasis markers, then trim. The real corpus form bolds the
  // TOKEN, not the whole value (`**Approved** — 3 GPT rounds`), so stripping only
  // whole-value wrappers misses it; `**`/`__` are never part of a status token,
  // so removing every occurrence is safe.
  let value = matches[0][1].replace(/\*\*|__/g, '').trim();

  // `Implemented` is rejected with a disambiguating message — it means "done" in
  // some corpus files and "partially done" in others, so it can never be aliased.
  if (/^Implemented\b/i.test(value)) {
    return {
      ok: false,
      reason: 'implemented',
      message: '"Implemented" is ambiguous — use "Complete" (done) or "In Progress" (partially done).',
    };
  }

  for (const { token, kind } of TOKENS) {
    if (value.length < token.length) continue;
    if (value.slice(0, token.length).toLowerCase() !== token.toLowerCase()) continue;
    const next = value.slice(token.length);
    if (next.length === 0 || SEPARATOR.test(next[0])) {
      return { ok: true, token, kind };
    }
  }
  return { ok: false, reason: 'unrecognized' };
}

/** A plan is selectable iff it is a docs/plans/*.md that is not an audit-summary. */
function isSelectableName(name) {
  return name.endsWith('.md') && !/-audit-summary(?:-[\w-]+)?\.md$/.test(name);
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
    }
  }
  if (actives.length === 0) return null;

  actives.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name));
  const chosen = actives[0];
  if (actives.length > 1) {
    warn(`>1 active plan (${actives.length}); auditing the newest — ${path.basename(chosen.path)} — mtime is a heuristic, not the contract. Others: ${actives.slice(1).map(a => a.name).join(', ')}`);
  }
  return { path: chosen.path };
}
