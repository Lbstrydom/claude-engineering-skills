/**
 * @fileoverview What a RECORD commit may contain — `ship-commit.mjs --record` (docs/plans/ship-record-catchup.md §2.6).
 *
 * The record half of /ship has no gate to launder: it writes the session log and nothing else. So an agent may commit it
 * under a standing decision — but only if the commit IS a record. That is decided here, from the change itself judged
 * against HEAD, never from the path names or the decision: the decision is a declaration (no code can verify a user's
 * origin), the scope check below is the safety. Merging the record PR stays the user's.
 *
 * Allowed, per path (anything else refuses with its own reason; an empty set refuses too):
 *   - docs/status/entries/<entry-name>.md   ABSENT at HEAD, a regular file, exactly one `## ` heading;
 *   - docs/status/entries/README.md         ABSENT at HEAD, byte-equal to `renderInitReadme()` (the marker `init` writes);
 *   - docs/plans/<name>.md                  PRESENT at HEAD, a regular file, and the change only INSERTS suggestion lines
 *                                           inside its `## Implementation Log` (or appends that section at EOF).
 *
 * **Pure.** `evaluateRecordCommit` takes gathered facts and returns one row per condition, so the direction the check
 * must NOT fire is as testable as the one it must. `gatherRecordPathFacts` is the I/O half.
 *
 * @module scripts/lib/ship-record/authority
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENTRY_NAME_RE } from './state.mjs';
import { PLAN_LOG_LINE_RE, renderInitReadme } from './entry.mjs';
import { activeDecision } from '../fleet/decisions.mjs';
import { fleetDir } from '../fleet/registry.mjs';

export const RECORD_CONDITIONS = Object.freeze(['flags', 'gate', 'decision', 'paths']);
const ENTRY_PATH_RE = /^docs\/status\/entries\/([^/]+)$/;
const PLAN_PATH_RE = /^docs\/plans\/[^/]+\.md$/;
const LOG_HEADING = '## Implementation Log';

const row = (id, ok, reason) => ({ id, ok, reason });
const lines = (s) => String(s).replace(/\r\n/g, '\n').split('\n');

/**
 * Is `newText` = `oldText` with only suggestion lines INSERTED inside its `## Implementation Log` section (or that section
 * appended at EOF when absent)? Pure.
 * @returns {{ok: true, inserted: number} | {ok: false, reason: string}}
 */
export function planChangeIsRecordOnly(oldText, newText) {
  const a = lines(oldText);
  const b = lines(newText);
  // Greedy line alignment: every old line must appear in order; everything extra is an insertion.
  const inserted = [];
  let i = 0;
  for (let j = 0; j < b.length; j++) {
    if (i < a.length && a[i] === b[j]) { i++; continue; }
    inserted.push(j);
  }
  if (i < a.length) return { ok: false, reason: `line ${i + 1} of the plan was changed or removed — a record change only inserts lines` };
  if (!inserted.length) return { ok: false, reason: 'the plan is unchanged' };
  const headingAt = b.findIndex((l) => l === LOG_HEADING);
  const sectionEnd = (start) => { const k = b.findIndex((l, n) => n > start && /^## /.test(l)); return k < 0 ? b.length : k; };
  const oldHadLog = a.includes(LOG_HEADING);
  for (const j of inserted) {
    const l = b[j];
    if (l === '') continue; // spacing around an inserted line or section
    if (!oldHadLog && l === LOG_HEADING && j === headingAt && sectionEnd(headingAt) === b.length) continue; // section created at EOF
    if (!PLAN_LOG_LINE_RE.test(l)) return { ok: false, reason: `line ${j + 1} is not a ship-record Implementation Log line` };
    if (headingAt < 0 || j <= headingAt || j >= sectionEnd(headingAt)) return { ok: false, reason: `line ${j + 1} is outside the ${LOG_HEADING} section` };
  }
  return { ok: true, inserted: inserted.filter((j) => b[j] !== '').length };
}

/**
 * @param {object} f
 * @param {string|null} f.gate the requested gate
 * @param {{preauthorised?: boolean, noTests?: boolean}} f.flags
 * @param {{ok: boolean, reason?: string, decision?: object}} f.decision activeDecision()'s result
 * @param {Array<{rel: string, atHead: 'absent'|'blob'|'other', kind: 'regular'|'symlink'|'missing'|'other', oldText?: string|null, newText?: string|null}>} f.paths
 */
export function evaluateRecordCommit(f) {
  const c = [];
  if (f.flags?.preauthorised) c.push(row('flags', false, '--record cannot be combined with --preauthorised (that is a code ship)'));
  else if (f.flags?.noTests) c.push(row('flags', false, '--record cannot be combined with --no-tests (the hooks still run on a record)'));
  else c.push(row('flags', true, 'no conflicting flags'));
  c.push(f.gate === 'not-run' ? row('gate', true, 'gate is not-run (a record carries no audit claim)') : row('gate', false, `a record commit is --gate not-run, not ${JSON.stringify(f.gate ?? null)}`));
  c.push(f.decision?.ok ? row('decision', true, `active decision ${f.decision.decision.id} (${f.decision.decision.scope})`) : row('decision', false, f.decision?.reason ?? 'no --decision'));
  const paths = Array.isArray(f.paths) ? f.paths : null;
  if (!paths || paths.length === 0) c.push(row('paths', false, 'no --path given: an empty record must not read as clean'));
  else {
    const bad = paths.map((p) => [p.rel, pathVerdict(p)]).filter(([, v]) => v);
    c.push(bad.length ? row('paths', false, bad.slice(0, 3).map(([r, v]) => `${r}: ${v}`).join('; ') + (bad.length > 3 ? `; +${bad.length - 3} more` : ''))
      : row('paths', true, `${paths.length} path(s), each a new log entry or a record-only plan insertion`));
  }
  const refusals = c.filter((x) => !x.ok).map((x) => `${x.id}: ${x.reason}`);
  return { ok: refusals.length === 0, conditions: c, refusals };
}

/** Why one path is not record-only, or null when it is. */
function pathVerdict(p) {
  if (p.kind === 'missing') return 'deleted (a record never deletes)';
  if (p.kind !== 'regular') return `not a regular file (${p.kind})`;
  const entry = ENTRY_PATH_RE.exec(p.rel);
  if (entry) {
    if (p.atHead !== 'absent') return 'already exists at HEAD (an entry is immutable; a correction is a new entry)';
    // CRLF-folded: core.autocrlf=true (system-wide on Git for Windows) may hand back the marker with CRLF line ends.
    if (entry[1] === 'README.md') return String(p.newText ?? '').replace(/\r\n/g, '\n') === renderInitReadme() ? null : 'README.md differs from the marker `ship-record init` writes';
    if (!ENTRY_NAME_RE.test(entry[1])) return 'name does not match <YYYY-MM-DD>-<HHMMSS>-<slug>.md';
    const headings = lines(p.newText ?? '').filter((l) => /^## /.test(l)).length;
    return headings === 1 ? null : `has ${headings} "## " headings, not exactly one`;
  }
  if (PLAN_PATH_RE.test(p.rel)) {
    if (p.atHead !== 'blob') return 'is not an existing plan at HEAD';
    const v = planChangeIsRecordOnly(p.oldText ?? '', p.newText ?? '');
    return v.ok ? null : v.reason;
  }
  return 'outside the record allowlist (docs/status/entries/*.md, docs/plans/*.md)';
}

/**
 * Gather per-path facts against HEAD, in the window just before commit. `git(args)` → `{status, stdout}`.
 * @param {string[]} rels repo-relative, forward-slash paths
 */
export function gatherRecordPathFacts({ repoRoot, git, rels }) {
  return rels.map((rel) => {
    const abs = path.join(repoRoot, rel);
    let kind = 'other';
    try { const st = fs.lstatSync(abs); kind = st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'regular' : 'other'; } catch (e) { kind = e.code === 'ENOENT' ? 'missing' : 'other'; }
    const t = git(['cat-file', '-t', `HEAD:${rel}`]);
    const atHead = t.status !== 0 ? 'absent' : String(t.stdout).trim() === 'blob' ? 'blob' : 'other';
    const oldText = atHead === 'blob' ? String(git(['show', `HEAD:${rel}`]).stdout ?? '') : null;
    const newText = kind === 'regular' ? fs.readFileSync(abs, 'utf8') : null;
    return { rel, atHead, kind, oldText, newText };
  });
}

export function renderRecordConditions(verdict) {
  return verdict.conditions.map((x) => `  ${x.ok ? 'ok     ' : 'REFUSED'} ${x.id.padEnd(9)} ${x.reason}`);
}

/**
 * ship-commit's whole `--record` step, so the CLI only calls it (ship-commit is at its size ceiling). Gathers, evaluates,
 * and returns the lines to print. Never throws: an unreadable registry is a refused `decision` row.
 * @returns {{ok: boolean, lines: string[], decisionId: string|null}}
 */
export function checkRecordCommit({ repoRoot, git, paths, decisionId, gate, flags, now = new Date() }) {
  let decision;
  try { decision = activeDecision(fleetDir(repoRoot), decisionId ?? null, 'record-catchup', now); } catch (e) { decision = { ok: false, reason: `the fleet registry could not be read (${e.message})` }; }
  const rels = (paths ?? []).map((p) => path.relative(repoRoot, path.resolve(repoRoot, p)).split(path.sep).join('/'));
  let facts = null;
  try { facts = gatherRecordPathFacts({ repoRoot, git, rels }); } catch { facts = null; }
  const verdict = evaluateRecordCommit({ gate, flags, decision, paths: facts });
  return { ok: verdict.ok, lines: renderRecordConditions(verdict), decisionId: verdict.ok ? decision.decision.id : null };
}
