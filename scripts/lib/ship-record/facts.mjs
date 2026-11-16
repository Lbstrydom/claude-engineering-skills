/**
 * @fileoverview Fact gatherers for the ship record catch-up (docs/plans/ship-record-catchup.md §2.1, §2.1a, §2.2).
 *
 * Every function takes injectable runners — `git(args)` and `gh(args)`, each returning `{status, stdout, stderr, error}` —
 * so the CLI is tested over a temp repo and a fake gh. Nothing here throws and nothing here writes: each failure comes
 * back with its reason, and the pure oracle (state.mjs) turns any unanswered question into `unmeasured`, never `0`.
 *
 * The base is ONE resolved triple (audit R1-H3): `branch` (bare name, what gh takes), `ref` (always fully qualified
 * `refs/remotes/origin/<branch>`, what git takes — a short name can resolve to a local branch), `repo` (`owner/name`
 * from origin, passed to every gh call with `-R`).
 *
 * @module scripts/lib/ship-record/facts
 */
import { spawnSync } from 'node:child_process';
import { sanitizeGitEnv } from '../git-env-sanitize.mjs';
import { classifyGhFailure } from '../fleet/gh-facts.mjs';
import { parseMessageTrailers, GATE_VALUES } from '../commit-trailers.mjs';
import {
  SHA_RE, isFloorEntryName, parseFloorMarker, parsePrMarkers, prNumberFromEntryName, classifyRecordState, listingStart,
} from './state.mjs';

export const ENTRIES_DIR = 'docs/status/entries';
export const MARKER_FILE = `${ENTRIES_DIR}/README.md`;
/** Rows one listing window may return before it is split (gh paginates internally up to this). */
export const WINDOW_LIMIT = 500;
/** gh calls one run may make while bisecting; past it the listing is `partial`. */
export const MAX_LIST_CALLS = 64;
export const MERGED_FIELDS = 'number,headRefName,mergedAt,mergeCommit,url';
const GH_TIMEOUT_MS = 30_000;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

// ── real runners ───────────────────────────────────────────────────────────

/** gh's environment minus the variables that silently re-point it at another repository or host (the ship-train rule). */
export function ghEnv(env = process.env) {
  const out = { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  for (const k of Object.keys(out)) if (/^GH_(REPO|HOST)$/i.test(k)) delete out[k];
  return out;
}

const wrap = (r) => ({ status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null });

/** Real runners for `cwd`. */
export function realRunners(cwd, { ghBin = 'gh' } = {}) {
  return {
    git: (args) => wrap(spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: sanitizeGitEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'] })),
    gh: (args) => wrap(spawnSync(ghBin, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: ghEnv(), timeout: GH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })),
  };
}

const ok = (r) => r && !r.error && r.status === 0;
const out = (r) => String(r.stdout ?? '').trim();
const ghWhy = (r) => (r.error ? (r.error.code === 'ENOENT' ? 'gh not installed' : r.error.code === 'ETIMEDOUT' ? 'gh timed out' : `gh failed to run: ${r.error.message}`) : classifyGhFailure(r.stderr));

// ── base ───────────────────────────────────────────────────────────────────

/** `owner/name` from a GitHub remote URL, or null. */
export function githubSlugFromRemote(url) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Resolve the base triple. `branch` explicit, else origin/HEAD's target, else `main`.
 * @returns {{ok: true, branch: string, ref: string, oid: string, repo: string} | {ok: false, reason: string}}
 */
export function resolveBase({ git }, { branch: explicit = null } = {}) {
  let branch = explicit;
  if (branch === null) {
    const r = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    branch = ok(r) && out(r).startsWith('refs/remotes/origin/') ? out(r).slice('refs/remotes/origin/'.length) : 'main';
  }
  if (!BRANCH_RE.test(branch) || branch.startsWith('-') || branch.includes('..')) return { ok: false, reason: `base branch ${JSON.stringify(branch)} is not a valid branch name` };
  const ref = `refs/remotes/origin/${branch}`;
  const v = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!ok(v) || !SHA_RE.test(out(v))) return { ok: false, reason: `base ref ${ref} not found — git fetch origin ${branch}` };
  const u = git(['remote', 'get-url', 'origin']);
  const repo = ok(u) ? githubSlugFromRemote(out(u)) : null;
  if (!repo) return { ok: false, reason: 'origin is not a GitHub remote (the PR oracle is GitHub)' };
  return { ok: true, branch, ref, oid: out(v), repo };
}

// ── base tree ──────────────────────────────────────────────────────────────

/**
 * Read the base tree's log entries: names, the marker, floors and catch-up markers.
 * Reads entry CONTENT only for `*-pr-<N>.md` and `*-record-floor.md` files (bounded).
 */
export function readBaseEntries({ git }, ref) {
  const ls = git(['ls-tree', '-r', '--name-only', ref, '--', `${ENTRIES_DIR}/`]);
  if (!ok(ls)) return { ok: false, reason: `could not list ${ENTRIES_DIR} on ${ref}` };
  const paths = out(ls) ? out(ls).split('\n') : [];
  const names = paths.map((p) => p.slice(ENTRIES_DIR.length + 1)).filter((n) => n && !n.includes('/'));
  const markerPresent = names.includes('README.md');
  const floors = [];
  const markers = [];
  for (const name of names) {
    const isFloor = isFloorEntryName(name);
    if (!isFloor && prNumberFromEntryName(name) === null) continue;
    const c = git(['cat-file', '-p', `${ref}:${ENTRIES_DIR}/${name}`]);
    if (!ok(c)) return { ok: false, reason: `could not read ${ENTRIES_DIR}/${name} on ${ref}` };
    if (isFloor) floors.push({ file: name, ...parseFloorMarker(c.stdout) });
    else markers.push(...parsePrMarkers(c.stdout));
  }
  return { ok: true, names, markerPresent, floors, markers };
}

// ── merged-PR listing (date-window bisection, plan §2.1a) ───────────────────

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);

/** Validate one gh row; null if its identity is missing. */
function row(raw) {
  if (!raw || !Number.isSafeInteger(raw.number) || raw.number <= 0 || typeof raw.mergedAt !== 'string' || !Number.isFinite(Date.parse(raw.mergedAt))) return null;
  const sha = raw.mergeCommit && typeof raw.mergeCommit === 'object' ? raw.mergeCommit.oid : raw.mergeCommit;
  return {
    number: raw.number, mergedAt: new Date(Date.parse(raw.mergedAt)).toISOString(),
    mergeCommit: typeof sha === 'string' && SHA_RE.test(sha) ? sha : null,
    headRefName: typeof raw.headRefName === 'string' ? raw.headRefName : '', url: typeof raw.url === 'string' ? raw.url : '',
  };
}

/**
 * Every PR merged into `branch` from `fromIso`'s day to `toIso`'s day. A window that returns its limit is halved until
 * none does; a single-day overflow (or the call budget) makes the result `complete:false` with the reason named. Any gh
 * failure makes the whole listing `ok:false` — a partial list must never read as a complete one.
 * @returns {{ok: true, complete: boolean, prs: object[], calls: number, partialReason?: string} | {ok: false, reason: string}}
 */
export function listMergedSince({ gh }, { repo, branch, fromIso, toIso, limit = WINDOW_LIMIT, maxCalls = MAX_LIST_CALLS }) {
  const seen = new Map();
  const stack = [[day(Date.parse(fromIso)), day(Date.parse(toIso))]];
  let calls = 0;
  const overflow = [];
  while (stack.length) {
    const [from, to] = stack.pop();
    if (calls >= maxCalls) { overflow.push(`call budget (${maxCalls}) spent before ${from}..${to}`); continue; }
    calls++;
    const r = gh(['pr', 'list', '-R', repo, '--state', 'merged', '--base', branch, '--search', `merged:${from}..${to}`, '--limit', String(limit), '--json', MERGED_FIELDS]);
    if (!ok(r)) return { ok: false, reason: `merged-PR listing failed for ${from}..${to}: ${ghWhy(r)}` };
    let rows;
    try { rows = JSON.parse(r.stdout); } catch { return { ok: false, reason: `gh printed unparseable JSON for ${from}..${to}` }; }
    if (!Array.isArray(rows)) return { ok: false, reason: `gh returned a non-array for ${from}..${to}` };
    if (rows.length >= limit) {
      if (from === to) { overflow.push(`${from} has ≥${limit} merged PRs (single-day window full)`); }
      else {
        const mid = day(Math.floor((dayMs(from) + dayMs(to)) / 2 / 86_400_000) * 86_400_000);
        const next = day(dayMs(mid) + 86_400_000);
        stack.push([next, to], [from, mid]);
        continue;
      }
    }
    for (const raw of rows) {
      const v = row(raw);
      if (!v) return { ok: false, reason: `gh returned a merged PR without its identity in ${from}..${to}` };
      seen.set(v.number, v);
    }
  }
  const prs = [...seen.values()].sort((a, b) => (Date.parse(a.mergedAt) - Date.parse(b.mergedAt)) || (a.number - b.number));
  return overflow.length ? { ok: true, complete: false, prs, calls, partialReason: overflow.join('; ') } : { ok: true, complete: true, prs, calls };
}

// ── per-merge git facts ────────────────────────────────────────────────────

/** Is `sha` a commit in the local object store? */
export const hasCommit = ({ git }, sha) => SHA_RE.test(sha ?? '') && ok(git(['cat-file', '-e', `${sha}^{commit}`]));

/**
 * Did this merge commit ADD a log entry (a non-README `.md` under docs/status/entries/)? That is /ship Step 2's
 * footprint for the PR it ships. A modification or deletion is not evidence (audit R1-H9). null = not determinable.
 */
export function inBandRecorded({ git }, sha) {
  if (!hasCommit({ git }, sha)) return null;
  const r = git(['diff-tree', '--no-commit-id', '--name-status', '--no-renames', '-r', `${sha}^1`, sha, '--', `${ENTRIES_DIR}/`]);
  if (!ok(r)) return null;
  return out(r).split('\n').some((l) => {
    const [st, p] = l.split('\t');
    return st === 'A' && p && p.endsWith('.md') && p !== MARKER_FILE && !p.slice(ENTRIES_DIR.length + 1).includes('/');
  });
}

/** Three observed trailer states (audit R3-M3). */
export function trailerState(message) {
  const { trailers } = parseMessageTrailers(message);
  const ai = trailers.filter((t) => /^AI-/i.test(t.key));
  const gate = ai.find((t) => t.key === 'AI-Gate' && GATE_VALUES.includes(t.value));
  if (gate) return { kind: 'gate', gate: gate.value };
  return ai.length ? { kind: 'ai-no-gate' } : { kind: 'none' };
}

/**
 * The immutable facts of one merge commit: subject (its title — the GitHub title stays editable after merge, audit
 * R3-H2), changed files, trailers. null when the commit is not local.
 */
export function mergeFacts({ git }, sha) {
  if (!hasCommit({ git }, sha)) return null;
  const msg = git(['log', '-1', '--format=%B', sha]);
  const files = git(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', `${sha}^1`, sha]);
  if (!ok(msg) || !ok(files)) return null;
  const message = String(msg.stdout).replace(/\r\n/g, '\n');
  return {
    subject: message.split('\n')[0] ?? '',
    files: out(files) ? out(files).split('\n') : [],
    trailers: trailerState(message),
  };
}

// ── composition ────────────────────────────────────────────────────────────

/**
 * Gather every fact and classify. Never throws.
 * @returns the classifyRecordState result plus `{base}`
 */
export function gatherRecordState(runners, { branch = null, now = new Date() } = {}) {
  const base = resolveBase(runners, { branch });
  const fail = (reason) => ({ state: 'unmeasured', reason, base: base.ok ? base : null, floor: null, prs: [], counts: { merged: null, recorded: null, unrecorded: null, unknown: null } });
  if (!base.ok) return fail(base.reason);
  const entries = readBaseEntries(runners, base.ref);
  if (!entries.ok) return fail(entries.reason);
  const pre = classifyRecordState({ markerPresent: entries.markerPresent, floors: entries.floors, merged: { ok: true, prs: [] }, baseMarkers: [], inBand: new Map() });
  if (pre.state !== 'measured') return { ...pre, base, entries };
  const floor = entries.floors[0];
  const merged = listMergedSince(runners, { repo: base.repo, branch: base.branch, fromIso: listingStart(floor), toIso: now.toISOString() });
  const inBand = new Map();
  if (merged.ok) {
    const markerFor = new Map(entries.markers.map((m) => [m.pr, m.merge]));
    for (const pr of merged.prs) {
      if (!pr.mergeCommit || markerFor.get(pr.number) === pr.mergeCommit) continue;
      inBand.set(pr.mergeCommit, inBandRecorded(runners, pr.mergeCommit));
    }
  }
  return { ...classifyRecordState({ markerPresent: true, floors: entries.floors, merged, baseMarkers: entries.markers, inBand }), base, entries };
}
