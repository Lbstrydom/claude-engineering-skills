/**
 * @fileoverview Which active plan does a push implement? Answered from the plan's own DECLARED PATHS.
 *
 * `selectAuditPlan` used to know two signals: the push edits a plan file, or exactly one plan is active. Everything else was
 * UNMEASURED - measured 2026-10-25 (derived, replaying the last 60 merge commits of each consumer against its current plan
 * set): 33 of 46 code-bearing pushes in wine-cellar-app and 30 of 54 in storyline had no single plan, which trains people to
 * reach for AUDIT_PREPUSH_ALLOW_UNMEASURED. A plan already says which files it will touch (backticked paths in its file-level
 * plan); this module reads that, so the choice is bound to the CHANGE, never to the clock.
 *
 * The decision is deliberately conservative and always explains itself:
 *   - `coverage(plan)` = how many of the push's changed CODE files the plan declares (docs, `docs/plans/**` and sync
 *     bookkeeping are not code and not counted, so a plan edit cannot score itself);
 *   - a plan is selected only when it covers at least one file, STRICTLY more than the runner-up, and at least HALF of the
 *     changed code files. The majority rule is what stops a plan that merely mentions a shared file (`package.json`) winning;
 *   - otherwise nothing is selected and `why` carries the counts, so the refusal is as legible as a choice.
 *
 * Pure: no filesystem, no git.
 *
 * @module scripts/lib/plan-declared-paths
 */
import { SYNC_BOOKKEEPING_FILES } from './prepush-audit-gate.mjs';

const DOCS_EXT = /\.(md|mdx|markdown|txt|rst)$/i;

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

/** A changed path that a code audit would read: not prose, not a plan, not sync bookkeeping. */
export function isCodeChange(file) {
  const f = norm(file);
  if (DOCS_EXT.test(f) || f.startsWith('docs/plans/')) return false;
  return !SYNC_BOOKKEEPING_FILES.includes(file) && !SYNC_BOOKKEEPING_FILES.map(norm).includes(f);
}

/**
 * The repo-relative paths a plan declares: backticked path-like tokens. A token ending in `/`, `/*` or `/**` declares a directory
 * (everything under it); any other token declares exactly one file. Line suffixes (`:120`) and a leading `./` are dropped; URLs,
 * flags, brace/regex/angle-bracket forms and tokens with no `/` and no extension are not paths.
 *
 * @param {string} planText
 * @returns {{files: Set<string>, dirs: string[]}}
 */
export function extractDeclaredPaths(planText) {
  const files = new Set();
  const dirs = new Set();
  for (const m of String(planText ?? '').matchAll(/`([^`\s]+)`/g)) {
    let tok = m[1].replace(/:\d+(?:-\d+)?$/, '').replace(/^\.\//, '').replace(/[),.;]+$/, '');
    if (!tok || /^(https?:|--?[a-z])/i.test(tok) || /[{}<>|*?\[\]()$^]/.test(tok.replace(/\/\*{1,2}$/, ''))) continue;
    if (/^[A-Za-z]:/.test(tok) || tok.startsWith('/') || tok.includes('..')) continue;
    const isDir = /\/(\*{1,2})?$/.test(tok);
    const t = norm(tok.replace(/\/(\*{1,2})?$/, '/'));
    if (isDir) { if (t.length > 1) dirs.add(t); continue; }
    if (t.includes('/') || /\.[a-z][a-z0-9]{0,5}$/.test(t)) files.add(t);
  }
  return { files, dirs: [...dirs] };
}

/** Does the plan's declared set cover this changed file? */
export function declares(declared, file) {
  const f = norm(file);
  return declared.files.has(f) || declared.dirs.some((d) => f.startsWith(d));
}

/**
 * @param {Array<{name: string, content: string}>} candidates active plans to choose among
 * @param {string[]} changedFiles every path in the push
 * @returns {{selected: {name: string, covered: number, runnerUp: number} | null, codeFiles: number, ranking: Array<{name: string, covered: number}>, why: string}}
 */
export function selectByDeclaredPaths(candidates, changedFiles) {
  const code = (Array.isArray(changedFiles) ? changedFiles : []).filter(isCodeChange);
  const ranking = candidates
    .map((c) => {
      const declared = extractDeclaredPaths(c.content);
      return { name: c.name, covered: code.filter((f) => declares(declared, f)).length };
    })
    .sort((a, b) => (b.covered - a.covered) || a.name.localeCompare(b.name));
  const counts = ranking.slice(0, 4).map((r) => `${r.name} ${r.covered}`).join(', ') + (ranking.length > 4 ? ', ...' : '');
  if (code.length === 0) return { selected: null, codeFiles: 0, ranking, why: 'the push changes no code file, so no plan can be bound by declared paths' };
  const top = ranking[0];
  const runnerUp = ranking[1]?.covered ?? 0;
  if (!top || top.covered < 1) return { selected: null, codeFiles: code.length, ranking, why: `no active plan declares any of the ${code.length} changed code file(s) (${counts})` };
  if (top.covered <= runnerUp) return { selected: null, codeFiles: code.length, ranking, why: `declared-path coverage is a tie or too close to call (${counts}; ${code.length} changed code file(s))` };
  if (top.covered * 2 < code.length) return { selected: null, codeFiles: code.length, ranking, why: `the best plan (${top.name}) covers only ${top.covered} of ${code.length} changed code file(s), under the half this rule requires (${counts})` };
  return {
    selected: { name: top.name, covered: top.covered, runnerUp },
    codeFiles: code.length,
    ranking,
    why: `${top.name} covers ${top.covered}/${code.length} changed code files; next best covers ${runnerUp}`,
  };
}
