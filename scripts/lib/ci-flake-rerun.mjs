/**
 * @fileoverview One recorded re-run of a CI failure that the diff cannot have caused (fleet p-20261015045129-6c44).
 *
 * **The gap.** A `full-suite` run that failed on a test this PR does not touch (a timing flake, a network blip in a
 * test that is not about the network) stops a merge until someone re-runs it by hand, and a hand re-run leaves no
 * record of WHY it was trusted. Rule 8 needs the decision made from facts, once, and written down.
 *
 * **The decision is pure** (`classifyFlakeRerun`) over evidence about the ONE run `selectRun` judged: attempt 1 only
 * (GitHub counts attempts, not us); every failed job names its failing files with exactly one `run-tests/v1
 * failed-files:` marker; the only failed step is the test step; the changed set is complete; no changed file is a
 * shared input; and no failing file is changed or reached by the change through the same reach the branch tier uses.
 * Anything unknown is ineligible, with its reason.
 *
 * **The mutation is reserved, never repeated.** `rerunUnrelatedFlake` holds a file lock on a per-run reservation record
 * (`<git-common-dir>/fleet/ci-flake/<owner>__<repo>__<run>.json`). States: `reserved` -> `dispatching` -> `accepted` |
 * `rejected`; `dispatching` means "possibly submitted" and is never dispatched again by this tool. Reconciliation is
 * read-only: attempt >= 2 visible is `accepted`; anything else stays `dispatching` and is reported as indeterminate. There
 * is no retry path: a negative read never authorises a second submission. The proposal is filed under the same lock and
 * its id is written before the lock is released, so it is filed exactly once.
 *
 * Scope: one coordinator machine (rule 8 runs merges there); a second machine is out of scope.
 *
 * Plan: docs/plans/fleet-chips-and-merge-friction.md section 2.3.
 *
 * @module scripts/lib/ci-flake-rerun
 */
import fs from 'node:fs';
import path from 'node:path';
import { runJson, runText } from './ci-verdict.mjs';
import { atomicWriteFileSync } from './file-io.mjs';
import { withFileLock } from './file-lock.mjs';
import { FAILED_FILES_MARKER } from './failed-files-marker.mjs';
import { globMatch } from './glob-match.mjs';
import { SELECTOR_DEPENDENCIES, SELECTOR_IDENTITY_FILES, SHARED_ENVIRONMENT, computeReach, entryReached } from './test-tier.mjs';

export { FAILED_FILES_MARKER };
/** The workflow step that runs the suite and prints the marker; the only failed step a flake may have. */
export const TEST_STEP_NAME = 'npm test';
const SHA40 = /^[0-9a-f]{40}$/;
const PASSING_JOB = new Set(['success', 'skipped', 'neutral']);
const PASSING_STEP = new Set(['success', 'skipped', 'neutral', null]);

/** The stable key a proposal carries, so recovery can find it again. */
export const flakeKey = (nwo, runId) => `ci-flake:${nwo}:${runId}:attempt-1`;

/**
 * The markers in a `gh run view --log-failed` text, per job. Each log line is `<job>\t<step>\t<timestamp> <text>`.
 * @returns {Map<string, Array<{kind: 'files', files: string[]}|{kind: 'unknown'}|{kind: 'malformed', raw: string}>>}
 */
export function parseFailedFilesMarkers(logText) {
  const byJob = new Map();
  for (const line of String(logText ?? '').split(/\r?\n/)) {
    const at = line.indexOf(FAILED_FILES_MARKER);
    if (at < 0) continue;
    const job = line.split('\t')[0];
    const payload = line.slice(at + FAILED_FILES_MARKER.length).trim();
    let marker;
    if (payload === 'unknown') marker = { kind: 'unknown' };
    else {
      try {
        const v = JSON.parse(payload);
        marker = Array.isArray(v) && v.every((f) => typeof f === 'string' && f) ? { kind: 'files', files: v } : { kind: 'malformed', raw: payload.slice(0, 80) };
      } catch { marker = { kind: 'malformed', raw: payload.slice(0, 80) }; }
    }
    if (!byJob.has(job)) byJob.set(job, []);
    byJob.get(job).push(marker);
  }
  return byJob;
}

/** Is a changed file one every test shares, or the selector, or the workflow that grades the run? */
function sharedInput(file, workflowPath) {
  if (SHARED_ENVIRONMENT.includes(file) || SELECTOR_IDENTITY_FILES.includes(file) || file === workflowPath) return true;
  return SELECTOR_DEPENDENCIES.some((g) => globMatch(g, file));
}

/**
 * THE decision. Pure.
 * @param {object} e
 * @param {{verdict: string}} e.verdict the `classifyCiVerdict` result for this PR
 * @param {number|null} e.pr
 * @param {object|null} e.run the run `selectRun` judged (id, run_attempt, conclusion, head_sha)
 * @param {string} e.prHead the PR's current head
 * @param {Array<{name: string, conclusion: string|null, steps?: Array<{name: string, conclusion: string|null}>}>|null} e.jobs attempt 1's jobs
 * @param {Map|null} e.markers `parseFailedFilesMarkers` of attempt 1's failed log
 * @param {string[]|null} e.changed the complete changed set, tested base...head
 * @param {{files: Set<string>, read: Function}|null} e.tree the tree AT the tested head
 * @param {string} e.workflowPath
 * @param {Array<{file: string, reach: string[]}>|null} e.heavy the heavy list's declared reaches at the tested head; null = unreadable
 * @returns {{eligible: true, failingFiles: string[]} | {eligible: false, reason: string}}
 */
export function classifyFlakeRerun(e) {
  const no = (reason) => ({ eligible: false, reason });
  const { verdict, pr, run, prHead, jobs, markers, changed, tree, workflowPath, heavy } = e ?? {};
  if (pr === null || pr === undefined) return no('a flake re-run is decided for a PR, not a bare head');
  if (verdict?.verdict !== 'failed') return no(`the verdict is ${verdict?.verdict ?? 'unknown'}, not failed`);
  if (!run) return no('no judged run');
  if (run.conclusion !== 'failure') return no(`run ${run.id} concluded ${run.conclusion}, not failure`);
  if (run.run_attempt !== 1) return no(`run ${run.id} is at attempt ${run.run_attempt}: already re-run once`);
  if (!SHA40.test(String(run.head_sha ?? '')) || run.head_sha !== prHead) return no(`run ${run.id} tested ${String(run.head_sha).slice(0, 8)}, not the PR's current head`);
  if (!Array.isArray(jobs)) return no('the jobs of attempt 1 could not be read');
  const failed = [];
  for (const j of jobs) {
    if (j.conclusion === 'failure') failed.push(j);
    else if (!PASSING_JOB.has(j.conclusion)) return no(`job "${j.name}" concluded ${j.conclusion}: not explained by a test failure`);
  }
  if (failed.length === 0) return no('no failed job to explain');
  if (!(markers instanceof Map)) return no('the failed log of attempt 1 could not be read');
  const failing = new Set();
  for (const j of failed) {
    const bad = (j.steps ?? []).filter((s) => !PASSING_STEP.has(s.conclusion) && s.name !== TEST_STEP_NAME);
    if (bad.length) return no(`job "${j.name}" also failed step "${bad[0].name}": the test marker does not explain it`);
    if (!(j.steps ?? []).some((s) => s.name === TEST_STEP_NAME && s.conclusion === 'failure')) return no(`job "${j.name}" failed without its "${TEST_STEP_NAME}" step failing`);
    const ms = markers.get(j.name) ?? [];
    if (ms.length !== 1) return no(`job "${j.name}" carries ${ms.length} failed-files marker(s), not exactly one`);
    if (ms[0].kind !== 'files') return no(`job "${j.name}" could not name its failing files (${ms[0].kind})`);
    if (ms[0].files.length === 0) return no(`job "${j.name}" names no failing file`);
    for (const f of ms[0].files) failing.add(f);
  }
  if (!Array.isArray(changed)) return no('the changed-file set could not be read completely');
  const shared = changed.filter((f) => sharedInput(f, workflowPath));
  if (shared.length) return no(`the diff changes a shared input: ${shared.slice(0, 3).join(', ')}`);
  if (!tree) return no('the tree at the tested head could not be read');
  // The declared reaches are evidence too: an unreadable list is not an empty one (a declared reach could relate the failure).
  if (!Array.isArray(heavy)) return no('the heavy list (declared reaches) at the tested head could not be read');
  const suffixIndex = new Map();
  for (const file of [...failing].sort()) {
    if (changed.includes(file)) return no(`${file} failed and the diff changes it`);
    if (!tree.files.has(file)) return no(`${file} failed but is not in the tested tree`);
    const reach = computeReach({ file, tree, suffixIndex });
    const declared = heavy.find((h) => h.file === file)?.reach ?? [];
    const r = entryReached({ file, reach: declared }, { changed, reach });
    if (r.reached) return no(`${file} failed and the diff reaches it: ${r.via[0]}`);
  }
  return { eligible: true, failingFiles: [...failing].sort() };
}

// ── Evidence (I/O through an injected runner) ───────────────────────────────

/**
 * Gather what `classifyFlakeRerun` judges, for the run the verdict judged. Every read that fails leaves its field
 * null, which the classifier turns into a named ineligibility; nothing here throws or guesses.
 *
 * The changed set and the tree come from the TESTED snapshot (the run's own head and base, fetched by sha), never the
 * caller's checkout.
 *
 * @param {object} a
 * @param {Function} a.run `(cmd, args) => spawnSync-like result`
 * @param {string} a.nwo owner/repo
 * @param {object} a.judged the run record `selectRun` chose
 * @param {number} a.pr
 * @param {(head: string) => {ok: boolean, tree?: object, error?: string}} a.readTree the tree at a commit
 * @param {(head: string) => {ok: true, heavy: Array<{file: string, reach: string[]}>}|{ok: false, why: string}} a.readHeavy the heavy list at a commit
 * @returns {{jobs: Array|null, markers: Map|null, changed: string[]|null, tree: object|null, heavy: Array|null, notes: string[]}}
 */
export function gatherFlakeEvidence({ run, nwo, judged, pr, readTree, readHeavy }) {
  const notes = [];
  let jobs = null;
  const jr = runJson(run, 'gh', ['api', `repos/${nwo}/actions/runs/${judged.id}/attempts/1/jobs?per_page=100`]);
  if (!jr.ok) notes.push(`jobs: ${jr.why}`);
  else if (!Array.isArray(jr.value?.jobs) || (jr.value.total_count ?? jr.value.jobs.length) !== jr.value.jobs.length) notes.push('jobs: the answer is incomplete or malformed');
  else jobs = jr.value.jobs.map((j) => ({ name: j.name, conclusion: j.conclusion ?? null, steps: (j.steps ?? []).map((s) => ({ name: s.name, conclusion: s.conclusion ?? null })) }));

  const lr = runText(run, 'gh', ['run', 'view', String(judged.id), '--repo', nwo, '--attempt', '1', '--log-failed']);
  const markers = lr.ok ? parseFailedFilesMarkers(lr.value) : null;
  if (!lr.ok) notes.push(`log: ${lr.why}`);

  const head = judged.head_sha;
  const base = (judged.pull_requests ?? []).find((p) => p?.number === pr)?.base?.sha;
  let changed = null;
  let tree = null;
  let heavy = null;
  if (!SHA40.test(String(head ?? '')) || !SHA40.test(String(base ?? ''))) notes.push('the run does not name its tested head and base');
  else {
    const f = runText(run, 'git', ['fetch', '--quiet', 'origin', head, base]);
    if (!f.ok) notes.push(`fetch: ${f.why}`);
    else {
      let d;
      try { d = run('git', ['diff', '--name-only', '--no-renames', '-z', '--no-ext-diff', '--no-textconv', `${base}...${head}`]); } catch (err) { d = { error: err }; }
      if (!d || d.error || d.status !== 0) notes.push(`diff: ${d?.error?.message ?? String(d?.stderr ?? '').trim().split('\n')[0]}`);
      else changed = String(d.stdout ?? '').split('\0').filter(Boolean);
      const t = readTree(head);
      if (t.ok) tree = t.tree; else notes.push(`tree: ${t.error}`);
      let h;
      try { h = readHeavy(head); } catch (err) { h = { ok: false, why: err.message }; }
      if (h?.ok && Array.isArray(h.heavy)) heavy = h.heavy; else notes.push(`heavy list: ${h?.why ?? 'unreadable'}`);
    }
  }
  return { jobs, markers, changed, tree, heavy, notes };
}

// ── Reservation + mutation ──────────────────────────────────────────────────

/**
 * The CLI's exit code, pure. Only a FAILED verdict takes its exit from the re-run outcome (accepted: wait, 3; refused or
 * ineligible: the failure stands, 4; indeterminate: 1, a human decides). Any other verdict keeps its own exit, so a run
 * that passed after a re-run is green (0) whatever the reservation still has to report.
 * @param {string} verdict
 * @param {{rerun: string}|null} outcome
 * @param {{full: number, notYet: number, failed: number, error: number}} exits
 */
export function flakeExit(verdict, outcome, exits) {
  if (verdict === 'full') return exits.full;
  if (verdict !== 'failed') return exits.notYet;
  if (!outcome) return exits.failed;
  return { accepted: exits.notYet, indeterminate: exits.error }[outcome.rerun] ?? exits.failed;
}

const RECORD_VERSION = 'ci-flake/v1';
const STATES = new Set(['reserved', 'dispatching', 'accepted', 'rejected']);

/** Where the reservation for one run lives. */
export const reservationFile = (stateDir, nwo, runId) => path.join(stateDir, `${nwo.replace('/', '__')}__${runId}.json`);

function readRecord(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, record: null };
    return { ok: false, why: `cannot read ${file} (${err.code ?? 'error'})` };
  }
  try {
    const r = JSON.parse(text);
    if (r?.version !== RECORD_VERSION || !STATES.has(r.state)) return { ok: false, why: `${file} is not a ${RECORD_VERSION} record` };
    return { ok: true, record: r };
  } catch { return { ok: false, why: `${file} is not JSON` }; }
}

/**
 * One invocation of `ci-verdict --pr <n> --rerun-unrelated-flake`, after the verdict and the classification.
 *
 * @param {object} a
 * @param {string} a.stateDir `<git-common-dir>/fleet/ci-flake`
 * @param {string} a.nwo owner/repo
 * @param {number} a.runId
 * @param {{eligible: boolean, reason?: string, failingFiles?: string[]}} a.classification for attempt 1, or null when
 *   the run is no longer at attempt 1 (then only a record this tool wrote can be taken forward)
 * Each injected call may return its answer or a Promise of it.
 * @param {() => {ok: boolean, attempt?: number, why?: string}} a.readAttempt the run's live attempt
 * @param {() => {ok: boolean, rejected?: boolean, why?: string}} a.dispatch `gh run rerun <id> --failed`; `rejected` only for a definitive refusal
 * @param {(key: string) => {ok: boolean, id?: string|null, why?: string}} a.findProposal
 * @param {(fields: object) => {ok: boolean, id?: string, why?: string}} a.propose
 * @param {string} [a.url]
 * @param {() => string} [a.now]
 * @returns {Promise<{rerun: 'accepted'|'rejected'|'indeterminate'|'ineligible', detail: string, proposal: string|null}>}
 */
export async function rerunUnrelatedFlake({ stateDir, nwo, runId, classification, readAttempt, dispatch, findProposal, propose, url = '', now = () => new Date().toISOString() }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = reservationFile(stateDir, nwo, runId);
  const key = flakeKey(nwo, runId);
  const save = (rec) => atomicWriteFileSync(file, `${JSON.stringify({ ...rec, updatedAt: now() }, null, 2)}\n`);
  return withFileLock(`${file}.lock`, { maxWaitMs: 15_000 }, async () => {
    const cur = readRecord(file);
    if (!cur.ok) return { rerun: 'indeterminate', detail: `${cur.why}; check \`gh run view ${runId}\` and decide by hand`, proposal: null };
    let rec = cur.record;

    if (!rec || rec.state === 'reserved') {
      const live = await readAttempt();
      if (!live.ok) return { rerun: 'indeterminate', detail: `cannot read run ${runId}: ${live.why}`, proposal: null };
      if (live.attempt !== 1) {
        return { rerun: 'ineligible', detail: `run ${runId} is at attempt ${live.attempt}${rec ? '' : ', and this tool did not re-run it'}: already re-run once`, proposal: null };
      }
      if (!classification?.eligible) return { rerun: 'ineligible', detail: classification?.reason ?? 'not classified', proposal: null };
      if (!rec) {
        rec = { version: RECORD_VERSION, nwo, runId, key, state: 'reserved', failingFiles: classification.failingFiles, createdAt: now() };
        fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`, { flag: 'wx' });
      }
      // Persisted BEFORE the call: from here on the request may have been submitted, so it is never sent again.
      rec = { ...rec, state: 'dispatching' };
      save(rec);
      const d = await dispatch();
      if (d.ok) {
        const after = await readAttempt();
        if (after.ok && after.attempt >= 2) { rec = { ...rec, state: 'accepted' }; save(rec); } else {
          return { rerun: 'indeterminate', detail: `the re-run was sent but attempt 2 is not visible yet${after.ok ? '' : ` (${after.why})`}; run this again later, it never sends twice`, proposal: null };
        }
      } else if (d.rejected) {
        rec = { ...rec, state: 'rejected', rejection: d.why };
        save(rec);
        return { rerun: 'rejected', detail: `GitHub refused the re-run: ${d.why}`, proposal: null };
      } else {
        return { rerun: 'indeterminate', detail: `the re-run call did not complete (${d.why}); it may have been accepted. Check \`gh run view ${runId}\`; this tool never sends it again`, proposal: null };
      }
    } else if (rec.state === 'dispatching') {
      const live = await readAttempt();
      if (!live.ok || live.attempt < 2) {
        return { rerun: 'indeterminate', detail: `a re-run was possibly submitted and attempt 2 is not visible${live.ok ? '' : ` (${live.why})`}; this tool never sends it again. Check \`gh run view ${runId}\``, proposal: null };
      }
      rec = { ...rec, state: 'accepted' };
      save(rec);
    } else if (rec.state === 'rejected') {
      return { rerun: 'rejected', detail: `GitHub refused the re-run earlier: ${rec.rejection ?? 'no detail'}`, proposal: null };
    }

    // accepted: file the proposal exactly once
    if (rec.proposalId) return { rerun: 'accepted', detail: `run ${runId} re-run (attempt 2)`, proposal: `already recorded ${rec.proposalId}` };
    const found = await findProposal(key);
    let proposal;
    if (found.ok && found.id) { rec = { ...rec, proposalId: found.id }; save(rec); proposal = `already recorded ${found.id}`; } else if (!found.ok) {
      proposal = `NOT recorded (${found.why}); the next run of this command files it`;
    } else {
      const p = await propose({
        what: `CI flake re-run: run ${runId} failed on files this diff does not reach`,
        where: (rec.failingFiles ?? []).join(', ').slice(0, 580) || '(unnamed)',
        why: 'one re-run of an unrelated failure, decided by ci-verdict --rerun-unrelated-flake; recurring files are worth fixing',
        evidence: `${key} ${url}`.trim(),
      });
      if (p.ok && p.id) { rec = { ...rec, proposalId: p.id }; save(rec); proposal = `recorded ${p.id}`; } else proposal = `NOT recorded (${p.why ?? 'no id returned'}); the next run of this command files it`;
    }
    return { rerun: 'accepted', detail: `run ${runId} re-run (attempt 2)`, proposal };
  });
}
