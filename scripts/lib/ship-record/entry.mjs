/**
 * @fileoverview Entry rendering and create-only publication for the ship record catch-up
 * (docs/plans/ship-record-catchup.md §2.2–§2.4).
 *
 * **Determinism is the idempotency.** A per-PR entry's path and bytes are a pure function of the PR's immutable facts
 * (its number, merge time and merge commit), so a re-run — or a concurrent run on another machine — writes the same
 * path with the same bytes, and git sees one identical add instead of two entries. Nothing mutable reaches a per-PR
 * entry: not the GitHub title (editable after merge — the merge commit's subject is used), not the PR body, not the
 * run's clock, not an operational outcome.
 *
 * **Create-only (incident PR #87, a script that rewrote status.md and destroyed 19,257 lines).** `publishEntry` writes a
 * temp file and publishes it with `link()`, which is atomic and fails with EEXIST instead of replacing anything. No
 * existing file is ever opened for writing — not status.md, not a plan (plan lines are SUGGESTED, §2.4).
 *
 * **One output boundary** (`sanitizeField`, audit R2-H6): every externally sourced string passes it — redact before
 * truncating, strip control characters, neutralise HTML/marker syntax, fence code spans safely. Markers are rendered
 * only from validated integers and 40-hex shas.
 *
 * @module scripts/lib/ship-record/entry
 */
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../secret-patterns.mjs';
import { classifyPath } from '../sensitive-paths.mjs';
import { SHA_RE, ENTRY_NAME_RE, renderFloorMarker } from './state.mjs';

export const MAX_FILES_LISTED = 20;
export const TITLE_MAX = 160;
/** A PR that touched more plans than this gets no plan-log suggestion (an index sweep is not an implementation). */
export const MAX_PLANS_SUGGESTED = 3;
export const PLAN_LOG_LINE_RE = /^- (\d{4}-\d{2}-\d{2}): merged #([1-9]\d*) \(([0-9a-f]{12})\) — recorded by ship-record catch-up <!-- ship-record pr=\2 -->$/;

// ── the output boundary ────────────────────────────────────────────────────

/** A backtick fence one longer than the longest backtick run in `s` (CommonMark), padded when `s` touches a backtick. */
export function codeSpan(s) {
  const runs = String(s).match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = /^`|`$/.test(s) ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Backslash-escape the CommonMark punctuation that could start a link, image, emphasis, code span or table cell (A-R1-M14). */
const escapeMarkdown = (s) => s.replace(/[\\`*_[\]~|]/g, (c) => `\\${c}`); // `[` is enough to defuse links and images; ( ) stay readable

/**
 * The ONE path from an external fact to entry text.
 * @param {unknown} value
 * @param {'title'|'ref'|'path'|'url'} kind
 * @param {{repo?: string, pr?: number}} [ctx] for `url`
 * @returns {string} already-formatted Markdown for its context ('' when a url is omitted)
 */
export function sanitizeField(value, kind, ctx = {}) {
  // 1. redact BEFORE truncating, so a secret cannot be cut into an unredacted fragment.
  let s = redactSecrets(String(value ?? '')).text;
  // 2. control characters and newlines: a value can never open a new heading or line.
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (kind === 'url') {
    const want = ctx.repo && ctx.pr ? `https://github.com/${ctx.repo}/pull/${ctx.pr}` : null;
    return want && s === want ? want : '';
  }
  if (kind === 'ref') {
    if (!s || !/^[A-Za-z0-9._/@+-]+$/.test(s)) return '<unprintable ref>';
    return codeSpan(s);
  }
  if (kind === 'path') {
    const shown = classifyPath(s) === 'sensitive' ? `${path.posix.dirname(s)}/ (sensitive file not named)` : s;
    return codeSpan(shown);
  }
  // title: 3. neutralise markup (no HTML, no marker forgery), then 4. truncate.
  s = escapeMarkdown(escapeHtml(s));
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s;
}

// ── names ──────────────────────────────────────────────────────────────────

const stamp = (iso) => {
  const d = new Date(Date.parse(iso));
  const p = (n) => String(n).padStart(2, '0');
  return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` };
};

/** `<YYYY-MM-DD>-<HHMMSS>-<slug>.md` in UTC. Throws on a name the README's grammar would reject. */
export function entryFileName(iso, slug) {
  if (!Number.isFinite(Date.parse(iso))) throw new Error(`entryFileName: ${JSON.stringify(iso)} is not a timestamp`);
  const { date, time } = stamp(iso);
  const name = `${date}-${time}-${slug}.md`;
  if (!ENTRY_NAME_RE.test(name)) throw new Error(`entryFileName: ${name} does not match the entry grammar`);
  return name;
}

export const prEntryFileName = (pr) => entryFileName(pr.mergedAt, `pr-${pr.number}`);

// ── per-PR entry ───────────────────────────────────────────────────────────

/** The merge commit's subject without GitHub's trailing ` (#N)`. */
export const titleFromSubject = (subject, n) => String(subject ?? '').replace(new RegExp(`\\s*\\(#${n}\\)\\s*$`), '');

const trailerLine = (t) => (t?.kind === 'gate' ? `\`AI-Gate: ${t.gate}\`` : t?.kind === 'ai-no-gate' ? 'AI-* trailers present, no valid AI-Gate' : 'no AI-* trailers');

/** Plans this PR touched, or null when it touched too many to suggest a log line for. */
export function touchedPlans(files) {
  const plans = files.filter((f) => /^docs\/plans\/[^/]+\.md$/.test(f) && f !== 'docs/plans/README.md');
  return plans.length > MAX_PLANS_SUGGESTED ? { plans, suggest: false } : { plans, suggest: true };
}

/**
 * The provenance lines of a fleet rollup. A manifest in commit text is SELF-DECLARED (any PR can author one), so it is listed as
 * unverified data and never as members the ship record vouches for; matching it to a local run is the coordinator's `fleet land
 * --resume` summary, which cannot enter these deterministic bytes (they must be the same on every machine).
 */
const rollupLines = (r) => {
  if (!r) return [];
  if (!r.ok) return [`- The squash message carries a fleet-rollup/v1 block that could not be read (${sanitizeField(r.reason, 'title')}).`];
  const members = r.members.slice(0, 20).map((m) => `${sanitizeField(m.id, 'title')}@${m.head.slice(0, 12)}${m.gate ? ` (gate ${sanitizeField(m.gate, 'title')})` : ''}`);
  return [`- The squash message carries a self-declared fleet-rollup/v1 manifest (${r.stage}) for ${sanitizeField(r.rollupId, 'title')} naming ${r.members.length} member${r.members.length === 1 ? '' : 's'}: ${members.join(', ')}. UNVERIFIED: a manifest in commit text is data, not proof; the rollup was not /shipped as one change.`];
};

/**
 * Render one PR's entry. Pure and byte-deterministic: same facts ⇒ same bytes.
 * @param {{number:number, mergedAt:string, mergeCommit:string, headRefName:string, url:string}} pr
 * @param {{subject:string, files:string[], trailers:object}} facts mergeFacts()
 * @param {{repo: string}} ctx
 */
export function renderPrEntry(pr, facts, { repo }) {
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error('renderPrEntry: invalid PR number');
  if (!SHA_RE.test(pr.mergeCommit ?? '')) throw new Error('renderPrEntry: invalid merge sha');
  const { date } = stamp(pr.mergedAt);
  const title = sanitizeField(titleFromSubject(facts.subject, pr.number), 'title') || '(no subject)';
  const url = sanitizeField(pr.url, 'url', { repo, pr: pr.number });
  const files = facts.files;
  const listed = files.slice(0, MAX_FILES_LISTED).map((f) => `- ${sanitizeField(f, 'path')}`);
  if (files.length > MAX_FILES_LISTED) {
    const dirs = [...new Set(files.slice(MAX_FILES_LISTED).map((f) => f.split('/')[0]))].sort().slice(0, 6);
    listed.push(`- +${files.length - MAX_FILES_LISTED} more across ${dirs.map((d) => sanitizeField(d, 'path')).join(', ')}`);
  }
  if (!listed.length) listed.push('- (no files changed)');
  const { plans } = touchedPlans(files);
  const planLine = plans.length ? plans.map((p) => sanitizeField(p, 'path')).join(', ') : 'none';
  return [
    `## ${date} — #${pr.number} ${title}`,
    `<!-- ship-record v1 pr=${pr.number} merge=${pr.mergeCommit} -->`,
    '',
    '### Changes',
    // No head ref name: it is not immutable (a branch rename re-labels it), and the bytes must not move (A-R1-M12).
    `- Merged #${pr.number} at ${pr.mergedAt} as \`${pr.mergeCommit.slice(0, 12)}\`${url ? ` (${url})` : ''}.`,
    '',
    '### Files Affected',
    ...listed,
    '',
    '### Provenance',
    '- Recorded after merge by `ship-record catchup`: no in-band /ship-checked record was found for this PR.',
    `- Squash-commit trailers: ${trailerLine(facts.trailers)}.`,
    ...rollupLines(facts.rollup),
    `- Plan: ${planLine}.`,
    '',
  ].join('\n');
}

/** The Implementation Log line a coordinator pastes for a plan this PR touched (§2.4). */
export function planLogSuggestion(pr) {
  const line = `- ${stamp(pr.mergedAt).date}: merged #${pr.number} (${pr.mergeCommit.slice(0, 12)}) — recorded by ship-record catch-up <!-- ship-record pr=${pr.number} -->`;
  if (!PLAN_LOG_LINE_RE.test(line)) throw new Error('planLogSuggestion: rendered line does not match its own grammar');
  return line;
}

/** Does this plan text already carry the marker for PR n? (the suggestion's idempotency key) */
export const planHasMarker = (text, n) => String(text ?? '').includes(`<!-- ship-record pr=${n} -->`);

// ── run, floor, init ───────────────────────────────────────────────────────

export const RUN_MARKER_RE = /<!-- ship-record-run v1 prs=([0-9,]+) -->/g;

/** PR numbers a run entry lists (its marker), so a later run knows they already have a run entry. */
export function parseRunMarker(text) {
  return [...String(text ?? '').matchAll(RUN_MARKER_RE)].flatMap((m) => m[1].split(',').filter(Boolean).map(Number));
}

/** The run entry: what this run recorded, plus the Backlog line. The only non-deterministic file (duplicates are harmless). */
export function renderRunEntry({ nowIso, recorded, backlogLine, suggestions, base }) {
  const { date } = stamp(nowIso);
  const nums = recorded.map((p) => p.number).sort((a, b) => a - b);
  const range = nums.length ? `#${Math.min(...nums)}…#${Math.max(...nums)}` : 'none';
  const lines = [
    `## ${date} — Record catch-up: ${recorded.length} PR(s) (${range})`,
    `<!-- ship-record-run v1 prs=${nums.join(',')} -->`,
    '',
    '### Changes',
    `- Recorded ${recorded.length} merged PR(s) into ${sanitizeField(base.branch, 'ref')} that had no /ship-checked record: ${nums.map((n) => `#${n}`).join(', ') || 'none'}.`,
    '',
    backlogLine,
  ];
  if (suggestions.length) {
    lines.push('', '### Plan Implementation Log lines to paste', ...suggestions.map((s) => `- ${sanitizeField(s.plan, 'path')}: ${codeSpan(s.line)}`));
  }
  lines.push('');
  return lines.join('\n');
}

/** The summarised backfill entry (§2.3). */
export function renderFloorEntry({ nowIso, mergedThrough, covered, lastEntry, withGate, total, base }) {
  const { date } = stamp(nowIso);
  const marker = renderFloorMarker({ mergedThrough, covered });
  return [
    `## ${date} — Record floor: per-PR recording starts after ${mergedThrough}`,
    marker,
    '',
    '### Changes',
    `- Summarised backfill. The last log entry before this floor: ${lastEntry ? sanitizeField(lastEntry, 'title') : 'none found'}.`,
    `- ${total} PR(s) merged into ${sanitizeField(base.branch, 'ref')} up to ${mergedThrough} are covered by this summary and get no individual entry; git log keeps their detail.`,
    `- Of those, ${withGate} carry a valid AI-Gate trailer on the squash commit (${total ? Math.round((withGate / total) * 100) : 0}%).`,
    '- PRs merged after the cutoff — or not in the covered list — are recorded one entry each by `ship-record catchup`.',
    '',
  ].join('\n');
}

/** The consumer cutover marker `init` writes; `ship-commit --record` accepts it only byte-equal to this. */
export function renderInitReadme() {
  return [
    '# Session log entries',
    '',
    '**This file is the cutover marker.** While it exists, the session log is one file per entry: a new `/ship-checked` entry is a',
    'NEW FILE in this directory, and `status.md` at the repo root takes no new entry.',
    '',
    '## The contract',
    '',
    '- **Name**: `<YYYY-MM-DD>-<HHMMSS>-<kebab-slug>.md` — UTC time of the ship, a lowercase slug naming the work.',
    '- **Content**: the first line is the entry\'s own `## YYYY-MM-DD — summary` heading; the date equals the file name\'s.',
    '  Exactly one `## ` heading per file.',
    '- **Immutable**: an entry file is never edited or deleted once it is on the base branch. A correction is a new entry.',
    '- **`status.md` is frozen history**: it gains no new `## ` heading.',
    '- **Record catch-up**: PRs merged without `/ship-checked` get one entry each (`…-pr-<N>.md`) from `ship-record catchup`; the',
    '  `…-record-floor.md` entry is where per-PR recording starts.',
    '',
  ].join('\n');
}

// ── publication ────────────────────────────────────────────────────────────

/**
 * The entries directory must be a real directory inside the repo root (never a symlink).
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkEntriesDir(repoRoot, rel) {
  const dir = path.join(repoRoot, rel);
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { return { ok: false, reason: `${rel} is missing (${e.code ?? e.message})` }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: `${rel} is not a real directory` };
  const real = fs.realpathSync(dir);
  const root = fs.realpathSync(repoRoot);
  if (path.relative(root, real).startsWith('..') || path.isAbsolute(path.relative(root, real))) return { ok: false, reason: `${rel} resolves outside the repo` };
  return { ok: true };
}

/**
 * Publish `bytes` at `dir/name` atomically and only if absent.
 * @returns {{outcome: 'written'|'identical'|'differs'|'error', reason?: string}}
 */
export function publishEntry(dir, name, bytes, { fsMod = fs } = {}) {
  const final = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.tmp-${process.pid}`);
  try {
    fsMod.writeFileSync(tmp, bytes, { flag: 'wx' });
    try { fsMod.linkSync(tmp, final); return { outcome: 'written' }; }
    catch (e) {
      if (e.code !== 'EEXIST') return { outcome: 'error', reason: `${name}: ${e.code ?? e.message}` };
      const st = fsMod.lstatSync(final);
      if (!st.isFile()) return { outcome: 'differs', reason: `${name} exists and is not a regular file` };
      return fsMod.readFileSync(final, 'utf8') === bytes ? { outcome: 'identical' } : { outcome: 'differs', reason: `${name} exists with different content (left alone)` };
    }
  } catch (e) {
    return { outcome: 'error', reason: `${name}: ${e.code ?? e.message}` };
  } finally {
    try { fsMod.unlinkSync(tmp); } catch { /* not created, or already gone */ }
  }
}

/** A temp file older than this was left by an interrupted run (a live run's temp lives for milliseconds). */
export const STALE_TEMP_MS = 10 * 60 * 1000;

/** Remove stray temp files an interrupted run left behind. Never touches a fresh one (a concurrent run's). Never throws. */
export function sweepTemps(dir, { fsMod = fs, nowMs = Date.now() } = {}) {
  try {
    for (const n of fsMod.readdirSync(dir)) {
      if (!/^\..+\.md\.tmp-\d+$/.test(n)) continue;
      const p = path.join(dir, n);
      try { if (nowMs - fsMod.lstatSync(p).mtimeMs > STALE_TEMP_MS) fsMod.unlinkSync(p); } catch { /* raced */ }
    }
  } catch { /* unreadable dir: checkEntriesDir reports it */ }
}
