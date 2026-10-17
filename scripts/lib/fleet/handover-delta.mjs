/**
 * @fileoverview The post-prepare DELTA for `fleet handover receive` (proposal p-20261017123914-6797): work the old
 * account did AFTER `prepare` wrote the manifest (common: the operator prepares at 2-3% credits and keeps working),
 * folded into receive so a stale kickoff prompt does not lose it. Per repo: commits, PRs updated, claims touched and
 * proposals created since the manifest's `createdAt`.
 *
 * Every field is MEASURED or UNMEASURED, never a silent empty list: a `gh` that cannot read the repo (a remote that
 * needs a different gh account answers "Could not resolve to a Repository") is `{measured:false, reason}` and prints
 * as UNMEASURED, because "no PRs" and "could not ask" are different facts. `git log` runs after a fetch; when the
 * fetch did not happen (`--dry-run` writes nothing, or it failed) the text says the log is as of the last fetch.
 *
 * Also owns `previousStintStart`: the lower bound for the stale-session sweep.
 *
 * @module scripts/lib/fleet/handover-delta
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyGhFailure, ghSpawnFailure, spawnGh } from './gh-facts.mjs';
import { runGit } from './git-facts.mjs';
import { fleetDir, readSessions } from './registry.mjs';
import { readProposals } from './proposals.mjs';

const OP_ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[0-9a-f]{6}$/;
/** Items kept per field; the count beside them is the real total. */
export const DELTA_LISTED = 15;
const COMMIT_CAP = 200;
const PR_CAP = 50;
const FETCH_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 20_000;

/** `20261017T123120123Z-abc123` to its ISO instant; null for any other shape. */
const idToIso = (id) => {
  const m = OP_ID.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : null;
};

/**
 * Where the arriving account's LAST stint began: the SECOND-newest handover manifest older than `id`. The newest older
 * one was prepared when this account LEFT (its stint ended there); the one before it is when the stint began. Sessions
 * from the other account's stint are not on this account's list at all. Fewer than two older manifests means no bound
 * (`at: null`); a directory that cannot be listed is `{ok:false}`, never "no bound".
 * @returns {{ok: true, at: string|null} | {ok: false, reason: string}}
 */
export function previousStintStart(dir, id, { readdir = fs.readdirSync } = {}) {
  let names;
  try { names = readdir(dir); } catch (e) { return { ok: false, reason: `${dir} could not be listed (${e.code ?? e.message})` }; }
  const older = names.map((n) => /^handover-(.+)\.json$/.exec(n)?.[1]).filter((x) => x && idToIso(x) && x < id).sort();
  return { ok: true, at: older.length >= 2 ? idToIso(older.at(-2)) : null };
}


const unmeasured = (reason) => ({ measured: false, reason });

/** `--since` PRUNES the walk at the first commit older than the cutoff, so a newer commit behind an older-dated one is missed (commit dates need not be monotonic); `--since-as-filter` visits every reachable commit and filters. */
function measureCommits(repo, since, git) {
  const res = git(['log', '--all', `--since-as-filter=${since}`, '--format=%H%x09%s', '-n', String(COMMIT_CAP + 1)], repo);
  if (!res.ok) return unmeasured(res.reason ?? 'git log failed');
  const rows = res.stdout.split('\n').filter(Boolean).map((l) => { const [sha, ...rest] = l.split('\t'); return { sha: sha.slice(0, 12), subject: rest.join('\t') }; });
  return { measured: true, total: Math.min(rows.length, COMMIT_CAP), truncated: rows.length > COMMIT_CAP, items: rows.slice(0, COMMIT_CAP) };
}

function measurePrs(repo, since, gh) {
  const res = gh(repo, ['pr', 'list', '--state', 'all', '--search', `updated:>=${since}`, '--json', 'number,title,state,updatedAt,headRefName', '--limit', String(PR_CAP)]);
  if (res.error) return unmeasured(ghSpawnFailure(res, 'pr list'));
  if (res.status !== 0) return unmeasured(classifyGhFailure(res.stderr));
  let rows;
  try { rows = JSON.parse(res.stdout); } catch { return unmeasured('gh pr list printed something that is not JSON'); }
  if (!Array.isArray(rows)) return unmeasured('gh pr list did not answer with a list');
  return { measured: true, total: rows.length, truncated: rows.length >= PR_CAP, items: rows.map((r) => ({ number: r.number, title: r.title, state: r.state, branch: r.headRefName })) };
}

function measureClaims(repo, sinceMs, deps) {
  try {
    const read = deps.readSessions(deps.fleetDirOf(repo));
    if (!read.complete) return unmeasured(`registry incomplete (${(read.invalid ?? []).map((i) => i.file).slice(0, 3).join(', ') || 'unreadable records'})`);
    const items = read.sessions.filter((s) => Date.parse(s.updatedAt) > sinceMs).map((s) => ({ id: s.id, state: s.state, intent: s.intent, created: Date.parse(s.createdAt) > sinceMs }));
    return { measured: true, total: items.length, items };
  } catch (e) { return unmeasured(e.message); }
}

function measureProposals(repo, sinceMs, deps) {
  try {
    const read = deps.readProposals(deps.fleetDirOf(repo));
    if (read.unmeasured || !read.complete) return unmeasured(read.reason ?? 'proposals not completely readable');
    const items = read.records.filter((p) => Date.parse(p.createdAt) > sinceMs).map((p) => ({ id: p.id, state: p.state, what: p.what }));
    return { measured: true, total: items.length, items };
  } catch (e) { return unmeasured(e.message); }
}

/**
 * One repo's delta since `since` (ISO). `fetch:false` is `--dry-run`: nothing is written, so the log is as of the
 * last fetch and says so. Deps are injectable; defaults are the real git/gh/registry readers.
 */
export function measureRepoDelta(repo, since, deps = {}) {
  const d = {
    git: (args, cwd, opts) => runGit(args, cwd, opts), gh: (cwd, args) => spawnGh(cwd, args, { timeoutMs: GH_TIMEOUT_MS }),
    fleetDirOf: fleetDir, readSessions, readProposals, fetch: true, ...deps,
  };
  let fetched;
  if (d.fetch === false) fetched = { done: false, why: 'skipped in --dry-run' };
  else { const f = d.git(['fetch', '--all', '--quiet'], repo, { timeoutMs: FETCH_TIMEOUT_MS }); fetched = f.ok ? { done: true } : { done: false, failed: true, why: `fetch failed: ${f.reason ?? 'unknown'}` }; }
  const sinceMs = Date.parse(since);
  return { repo, since, fetched, commits: measureCommits(repo, since, d.git), prs: measurePrs(repo, since, d.gh), claims: measureClaims(repo, sinceMs, d), proposals: measureProposals(repo, sinceMs, d) };
}

const FIELDS = ['commits', 'prs', 'claims', 'proposals'];
/** Anything new, or anything that could not be measured: either needs the coordinator's eye. */
export const deltaNeedsAttention = (d) => d.fetched.failed === true || FIELDS.some((f) => !d[f].measured || d[f].total > 0);

/** A repo receive could not even open: every field UNMEASURED with the same reason, so it still has a delta record. */
export function unmeasuredDelta(repo, since, reason) {
  return { repo, since, fetched: { done: false, why: reason }, commits: unmeasured(reason), prs: unmeasured(reason), claims: unmeasured(reason), proposals: unmeasured(reason) };
}

const listed = (items, fmt, more) => [...items.slice(0, DELTA_LISTED).map(fmt), ...(items.length > DELTA_LISTED ? [`      … and ${items.length - DELTA_LISTED} more${more ? ` (${more})` : ''}`] : [])];

/** The receive-text lines for one repo's delta. */
export function renderDeltaLines(d) {
  const L = [`  after prepare in ${d.repo} (since ${d.since})${d.fetched.done ? '' : `; commits are as of the last fetch (${d.fetched.why})`}:`];
  const field = (name, none, f, fmt, more) => {
    if (!f.measured) { L.push(`    ${name}: UNMEASURED (${f.reason})`); return; }
    if (!f.total) { L.push(`    ${name}: ${none}`); return; }
    L.push(`    ${name}: ${f.total}${f.truncated ? '+' : ''}`, ...listed(f.items, fmt, more));
  };
  field('commits', 'none on any branch', d.commits, (c) => `      ${c.sha} ${c.subject}`, 'git log --all for the rest');
  field('PRs', 'none updated since', d.prs, (p) => `      #${p.number} ${p.state} ${p.branch ?? ''} — ${p.title}`, 'gh pr list for the rest');
  field('claims', 'none touched', d.claims, (c) => `      ${c.id} (${c.state})${c.created ? ' NEW' : ''}${c.intent ? ` — ${c.intent}` : ''}`);
  field('proposals', 'none created', d.proposals, (p) => `      ${p.id} (${p.state}) ${p.what}`);
  return L;
}

/** The one follow-up summarising every repo's delta; null when nothing is new and nothing is unmeasured. */
export function deltaFollowUp(deltas) {
  const hot = deltas.filter(deltaNeedsAttention);
  if (!hot.length) return null;
  const parts = hot.map((d) => `${path.basename(d.repo)}: ${FIELDS.map((f) => (d[f].measured ? `${d[f].total}${d[f].truncated ? '+ (capped)' : ''} ${f}` : `${f} UNMEASURED`)).join(', ')}${d.fetched.done ? '' : ` (commits as of the last fetch: ${d.fetched.why})`}`);
  return { kind: 'delta', detail: `work after prepare (listed above): ${parts.join('; ')} — fold it into the handover before acting on its resume prompts; an UNMEASURED field is not "nothing new"` };
}
