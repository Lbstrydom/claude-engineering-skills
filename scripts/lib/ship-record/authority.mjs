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
/** A file's lines without the empty element its terminating newline produces (B-R4-H1): that newline is not content. */
const planLines = (s) => { const l = lines(s); if (l.length && l[l.length - 1] === '') l.pop(); return l; };

/**
 * Is `newText` = `oldText` with only suggestion lines INSERTED inside its `## Implementation Log` section (or that section
 * appended at EOF when absent)? Pure.
 * @returns {{ok: true, inserted: number} | {ok: false, reason: string}}
 */
export function planChangeIsRecordOnly(oldText, newText) {
  const a = planLines(oldText);
  const b = planLines(newText);
  // Greedy line alignment: every old line must appear in order; everything extra is an insertion.
  const inserted = [];
  let i = 0;
  let lastOld = -1; // index in b of the last line that matched an old line
  for (let j = 0; j < b.length; j++) {
    if (i < a.length && a[i] === b[j]) { i++; lastOld = j; continue; }
    inserted.push(j);
  }
  if (i < a.length) return { ok: false, reason: `line ${i + 1} of the plan was changed or removed — a record change only inserts lines` };
  if (!inserted.length) return { ok: false, reason: 'the plan is unchanged' };
  const headingAt = b.findIndex((l) => l === LOG_HEADING);
  const sectionEnd = (start) => { const k = b.findIndex((l, n) => n > start && /^## /.test(l)); return k < 0 ? b.length : k; };
  const oldHadLog = a.includes(LOG_HEADING);
  for (const j of inserted) {
    const l = b[j];
    // Blank lines are located like any other insertion (B-R2-M6): inside the log, or after all original content when the
    // section is being created at EOF.
    const inLog = headingAt >= 0 && j > headingAt && j < sectionEnd(headingAt);
    if (l === '') { if (inLog || (!oldHadLog && j > lastOld)) continue; return { ok: false, reason: `line ${j + 1} inserts a blank line outside the ${LOG_HEADING} section` }; }
    // A CREATED section must come after every original line (B-R1-H3): EOF means EOF, not "no later heading".
    if (!oldHadLog && l === LOG_HEADING && j === headingAt && j > lastOld && sectionEnd(headingAt) === b.length) continue;
    if (!PLAN_LOG_LINE_RE.test(l)) return { ok: false, reason: `line ${j + 1} is not a ship-record Implementation Log line` };
    if (headingAt < 0 || j <= headingAt || j >= sectionEnd(headingAt)) return { ok: false, reason: `line ${j + 1} is outside the ${LOG_HEADING} section` };
    if (!oldHadLog && j < lastOld) return { ok: false, reason: `line ${j + 1} was inserted before original content` };
  }
  // A record change records something (B-R3-H1): blank lines alone are not a record, and a created section must exist.
  const lines_ = inserted.filter((j) => b[j] !== '' && b[j] !== LOG_HEADING).length;
  if (lines_ === 0) return { ok: false, reason: 'the change inserts no ship-record Implementation Log line' };
  if (!oldHadLog && !(headingAt > lastOld)) return { ok: false, reason: `the plan had no ${LOG_HEADING}, and none was appended after its content` };
  return { ok: true, inserted: lines_ };
}

// ---- the SHIP-step delta grammar (docs/plans/coordinator-aggregate-ship.md section 2.3, C4) --------------------------------
// What /ship itself may change AFTER the audit: its own status entry, and a plan's `Status:` line and Implementation Log.
// The coordinator batch re-check judges the audited tree against the shipped head with exactly this grammar, so a code change
// after the audit can never ride in as "ship docs". Narrower than nothing, stricter than the record grammar above: the log
// section here is free text (the ship writes prose), so the test is WHERE a line changed, never WHAT it says.

const STATUS_LINE_RE = /^- \*\*Status\*\*:/;
const LEGACY_LOG_REL = 'status.md';
/** Refuse a diff larger than this many LCS cells after the common prefix and suffix are trimmed: fail closed, never guess. */
const MAX_DIFF_CELLS = 4_000_000;

/** `[first, last)` line range (0-based) of the Implementation Log section, or null when the text has none. */
function logRange(ls) {
  const h = ls.indexOf(LOG_HEADING);
  if (h < 0) return null;
  const k = ls.findIndex((l, n) => n > h && /^## /.test(l));
  return [h, k < 0 ? ls.length : k];
}
/** Is the 0-based line `i` inside the Status header line or the Implementation Log of `ls`? */
function inShipRegion(ls, i) {
  // A blank line carries no content: the blank separator the ship writes ahead of a new log heading sits outside the section.
  if ((ls[i] ?? '').trim() === '') return true;
  if (STATUS_LINE_RE.test(ls[i] ?? '')) return true;
  const r = logRange(ls);
  return r !== null && i >= r[0] && i < r[1];
}

/**
 * Changed line runs between two line arrays, as `{oldAt, oldN, newAt, newN}` (0-based starts). Common prefix and suffix are
 * trimmed first, so a one-line edit in a thousand-line plan costs one cell. `null` when what is left is too big to diff.
 */
function diffRuns(a, b) {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - lo;
  const m = eb - lo;
  if (n === 0 && m === 0) return [];
  if (n * m > MAX_DIFF_CELLS) return null;
  // LCS table over the trimmed middle; walk it to emit maximal changed runs.
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[lo + i] === b[lo + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const runs = [];
  let i = 0;
  let j = 0;
  let open = null;
  const close = () => { if (open) { runs.push(open); open = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[lo + i] === b[lo + j]) { close(); i++; j++; continue; }
    open ??= { oldAt: lo + i, oldN: 0, newAt: lo + j, newN: 0 };
    if (j < m && (i >= n || t[i * w + j + 1] >= t[(i + 1) * w + j])) { open.newN++; j++; } else { open.oldN++; i++; }
  }
  close();
  return runs;
}

/**
 * Is this one path's change between the AUDITED tree and the SHIPPED head something /ship itself writes? Pure.
 *
 *   (a) `docs/status/entries/<entry-name>.md`  ADDED (an entry is immutable: modifying one refuses);
 *   (b) `status.md` (the legacy log)           MODIFIED by inserting lines before its first `## ` entry heading only;
 *   (c) `docs/plans/<name>.md`                 MODIFIED, every changed line (both sides) inside the `- **Status**:` line or the
 *                                              `## Implementation Log` section (a log the ship creates counts as new region).
 * Everything else, every delete and every rename half refuses. `status` is `git diff --name-status --no-renames`'s letter.
 *
 * @param {{status: string, rel: string, oldText?: string|null, newText?: string|null}} d
 * @returns {string|null} why it is not a ship-step edit, or null when it is
 */
export function isShipStepDelta({ status, rel, oldText = null, newText = null }) {
  if (status === 'D') return 'deleted after the audit (a ship never deletes)';
  const entry = ENTRY_PATH_RE.exec(rel);
  if (entry) {
    if (status !== 'A') return 'an existing status entry was changed (an entry is immutable: it may only be a new file)';
    return ENTRY_NAME_RE.test(entry[1]) ? null : 'a status entry whose name does not match <YYYY-MM-DD>-<HHMMSS>-<slug>.md';
  }
  if (status !== 'M') return `change status ${JSON.stringify(status)} is not a ship-step edit (only an added entry or a modified plan or status.md)`;
  if (typeof oldText !== 'string' || typeof newText !== 'string') return 'the file text on one side could not be read, so nothing was checked';
  const a = lines(oldText);
  const b = lines(newText);
  if (rel === LEGACY_LOG_REL) {
    // Insert-only, before the first entry heading: the old tail (from that heading) survives verbatim at the end, and the old
    // head survives in order inside the new head.
    const h = a.findIndex((l) => /^## /.test(l));
    if (h < 0) return `${LEGACY_LOG_REL} has no entry heading to insert before`;
    const tail = a.slice(h);
    const head = b.slice(0, b.length - tail.length);
    if (b.length < tail.length || tail.some((l, k) => l !== b[head.length + k])) return `${LEGACY_LOG_REL}: an existing entry was changed or the insertion is below the first entry`;
    let k = 0;
    for (const l of head) if (k < h && l === a[k]) k++;
    return k === h ? null : `${LEGACY_LOG_REL}: lines above the first entry were changed or removed`;
  }
  if (!PLAN_PATH_RE.test(rel)) return `${rel} is outside the ship-step allowlist (a new status entry, status.md, docs/plans/*.md)`;
  const runs = diffRuns(a, b);
  if (runs === null) return `${rel} is too large to verify the delta line by line, so it refuses`;
  if (runs.length === 0) return null;
  for (const r of runs) {
    for (let i = r.oldAt; i < r.oldAt + r.oldN; i++) if (!inShipRegion(a, i)) return `${rel}: line ${i + 1} outside the Status line and the ${LOG_HEADING} was changed or removed`;
    for (let j = r.newAt; j < r.newAt + r.newN; j++) if (!inShipRegion(b, j)) return `${rel}: line ${j + 1} outside the Status line and the ${LOG_HEADING} was added or changed`;
  }
  return null;
}

/**
 * @param {object} f
 * @param {string|null} f.gate the requested gate
 * @param {{preauthorised?: boolean, noTests?: boolean}} f.flags
 * @param {{ok: boolean, reason?: string, decision?: object}} f.decision activeDecision()'s result
 * @param {Array<{rel: string, atHead: 'absent'|'blob'|'symlink'|'other'|'unknown', kind: 'regular'|'symlink'|'missing'|'other', oldText?: string|null, newText?: string|null}>} f.paths
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
  if (p.atHead === 'unknown') return 'its state at HEAD could not be read (git failed), so nothing was checked';
  if (p.atHead === 'symlink') return 'is a symlink at HEAD';
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
    // Mode evidence is REQUIRED (B-R5-M2): only an explicit false (compared, unchanged) passes; absent or unknown refuses.
    if (p.modeChanged !== false) return p.modeChanged === true ? 'changes the file mode (a record changes only lines)' : 'its file mode could not be compared with HEAD';
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
    // The tree ENTRY, not the object type (B-R1-H4/M6): git stores a symlink as a blob too; only the mode tells them apart.
    // Every git call is checked (B-R1-H7/H9): a failure is 'unknown' and refuses, never a fabricated "absent".
    // Literal pathspec (B-R2-H2): `[draft].md` is a filename, not a glob. Per-pathspec magic — never --literal-pathspecs,
    // whose environment form leaks into hooks.
    const t = git(['ls-tree', '-z', 'HEAD', '--', `:(literal)${rel}`]);
    let atHead = 'unknown';
    let oldText = null;
    let headMode = null;
    if (t.status === 0 && !t.error) {
      const entry = String(t.stdout).split('\0').find((x) => x.endsWith(`\t${rel}`));
      if (!entry) atHead = 'absent';
      else {
        const [mode, type] = entry.split('\t')[0].split(' ');
        headMode = mode;
        atHead = type === 'blob' && (mode === '100644' || mode === '100755') ? 'blob' : mode === '120000' ? 'symlink' : 'other';
        if (atHead === 'blob') {
          const shown = git(['show', `HEAD:${rel}`]);
          if (shown.status === 0 && !shown.error) oldText = String(shown.stdout ?? ''); else atHead = 'unknown';
        }
      }
    }
    const newText = kind === 'regular' ? fs.readFileSync(abs, 'utf8') : null;
    // The mode git would COMMIT (B-R4-M1): `diff --raw` against HEAD honours core.fileMode, so an exec-bit flip shows here
    // exactly when it would land. No diff line = unchanged mode.
    let modeChanged = null;
    if (atHead === 'blob') {
      const d = git(['diff', '--raw', '--no-renames', 'HEAD', '--', `:(literal)${rel}`]);
      if (d.status === 0 && !d.error) { const m = /^:(\d{6}) (\d{6}) /.exec(String(d.stdout)); modeChanged = m ? m[1] !== m[2] : false; }
    }
    return { rel, atHead, kind, oldText, newText, headMode, modeChanged };
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
