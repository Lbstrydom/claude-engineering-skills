/**
 * @fileoverview Ship-train verification — stateless (plan §2.8).
 *
 * Pure: the caller gathers facts from owned state (fleet's train manifest,
 * GitHub, git, the audit store) and this module judges them. Nothing here
 * reads or writes a ship-train record; every call is a fresh judgement, so
 * there is no stored result to go stale, race, or be revoked.
 *
 * Two questions, in order, per train source:
 *   1. SOURCE IDENTITY — is the merged PR the source the train tested? Its
 *      merged head must be the manifest's pinned oid, or a chain of fleet
 *      serial's own base-only updates leading back to it (each link judged by
 *      fleet's `classifyUpdatedHead`). Anything else blocks publication and no
 *      flag acknowledges it: identity is the train's definition.
 *   2. CLAIM TRUTH — is every AI-* claim on the squash commit TRUE, given git
 *      and the store? Not "equal to what was decided": an under-claim is true.
 *
 * Then, across the train: the final merge OID and any foreign commits
 * interleaved before it, and `publicationClearance` — the one predicate `sync`
 * applies to the verification it computed in the same invocation.
 *
 * @module scripts/lib/ship-train/verify
 */

import { parseMessageTrailers, AI_TRAILER_KEYS } from '../commit-trailers.mjs';

/** A merged head is a bounded number of serial updates from its pinned oid. */
export const MAX_UPDATE_LINKS = 5;

/**
 * Read the AI-* trailers of a commit message. Multiplicity is preserved: a key
 * appearing more than once is reported in `duplicates`, never reduced to its
 * last value — two contradictory claims on one commit is itself a false claim.
 *
 * @param {string} message
 * @returns {{parseable: boolean, trailers: Record<string, string>, duplicates: string[]}}
 */
export function readAiTrailers(message) {
  const { isTrailerBlock, trailers } = parseMessageTrailers(message);
  const out = {};
  const seen = new Set();
  const duplicates = new Set();
  const nonCanonical = [];
  for (const t of trailers) {
    if (!/^AI-/i.test(t.key)) continue;
    // ONE canonical key per claim (code R1 H2/M5): matching is case-insensitive,
    // so `ai-gate` and `AI-Gate` are the same claim — a second one is a
    // duplicate, never a separate key the lookup would miss.
    const canonical = CANONICAL_KEYS.get(t.key.toLowerCase()) ?? t.key;
    if (canonical !== t.key) nonCanonical.push(t.key);
    if (seen.has(canonical)) duplicates.add(canonical);
    seen.add(canonical);
    out[canonical] = t.value;
  }
  return { parseable: isTrailerBlock && seen.size > 0, trailers: out, duplicates: [...duplicates], nonCanonical };
}

/** The reserved keys as their one writer emits them (commit-trailers.mjs formatTrailerBlock). */
const CANONICAL_KEYS = new Map(AI_TRAILER_KEYS.map((k) => [k.toLowerCase(), k]));

/**
 * Judge source identity from a first-parent walk the caller gathered.
 *
 * @param {object} input
 * @param {string} input.pinnedOid — the manifest's `sources[].oid`
 * @param {Array<{oid: string, verdict: 'own'|'foreign'|'unverifiable', reason?: string}>} input.links
 *   — from the merged head backwards, each head with fleet's verdict on it being
 *   a clean base-only update of its first parent
 * @param {string|null} input.reachedOid — the oid the walk stopped at
 * @returns {{ok: boolean, reason: string|null}}
 */
export function judgeSourceIdentity({ pinnedOid, links, reachedOid }) {
  const bad = links.find((l) => l.verdict !== 'own');
  if (bad) {
    return { ok: false, reason: `${bad.oid.slice(0, 12)} is not fleet serial's own base-only update (${bad.verdict}${bad.reason ? `: ${bad.reason}` : ''})` };
  }
  if (reachedOid !== pinnedOid) {
    return { ok: false, reason: `merged head does not lead back to the tested head ${String(pinnedOid).slice(0, 12)} within ${MAX_UPDATE_LINKS} update link(s)` };
  }
  return { ok: true, reason: null };
}

/**
 * Is every claim on one squash commit TRUE? (plan §2.8 truth list)
 *
 * @param {object} input
 * @param {string} input.message — the squash commit's full message
 * @param {string} input.tree — the squash commit's own tree (%T)
 * @param {Array<{oid: string, tree: string}>} input.prCommits — the PR's commits (merge-base..merged head)
 * @param {{id: string, auditedTree: string|null, auditedSha: string|null, roundConvergedAfter: number|null}|null} input.run
 *   — `AI-Run-ID` resolved through the repo-scoped, code-mode lookup; null when absent or unresolvable
 * @returns {{true: boolean, gate: string|null, problems: string[], notes: string[]}}
 */
export function checkClaimTruth({ message, tree, prCommits, run }) {
  const { parseable, trailers, duplicates, nonCanonical } = readAiTrailers(message);
  if (!parseable) return { true: false, gate: null, problems: ['no parseable AI-* trailer block on the squash commit'], notes: [] };
  const problems = [
    ...duplicates.map((k) => `${k} appears more than once`),
    // The reserved namespace has exactly one writer, which emits canonical keys;
    // any other spelling did not come from it.
    ...nonCanonical.map((k) => `${k} is not the canonical spelling — not written by the trailer helper`),
  ];
  const notes = [];
  const gate = trailers['AI-Gate'] ?? null;
  const runId = trailers['AI-Run-ID'];
  const claimedTree = trailers['AI-Audited-Tree'];
  const trees = new Set(prCommits.map((c) => c.tree));
  const oids = new Set(prCommits.map((c) => c.oid));

  const runResolves = () => {
    if (!runId) { problems.push(`AI-Gate ${gate} names no AI-Run-ID`); return false; }
    if (!run || run.id !== runId) { problems.push(`run ${runId} is not a code-mode run of this repository`); return false; }
    return true;
  };
  const requireTreeBound = () => {
    if (!(run.auditedTree && trees.has(run.auditedTree))) problems.push(`run ${runId}'s audited tree is not the tree of any commit in this PR`);
  };
  const requireConverged = () => {
    if (run.roundConvergedAfter == null) problems.push(`run ${runId} did not converge`);
  };

  if (claimedTree !== undefined && gate !== 'passed') problems.push(`AI-Audited-Tree on a ${gate} gate`);
  // The train is the squash's writer and never writes this key: the final-review marker it derives from is a local record in the
  // worktree that ran the review, and none is bound to a PR's run in the checkout a train lands from (copilot-feedback-item4 B4).
  if (trailers['AI-Final-Review'] !== undefined) problems.push(`AI-Final-Review ${trailers['AI-Final-Review']} on a squash commit: the train does not write it, so the trailer helper did not either`);
  switch (gate) {
    case 'passed':
      if (claimedTree !== tree) problems.push(`AI-Audited-Tree ${String(claimedTree).slice(0, 12)} is not the commit's tree ${String(tree).slice(0, 12)}`);
      if (runResolves()) {
        if (run.auditedTree !== claimedTree) problems.push(`run ${runId} audited tree ${String(run.auditedTree).slice(0, 12)}, not the claimed ${String(claimedTree).slice(0, 12)}`);
        requireTreeBound();
        requireConverged();
      }
      break;
    case 'converged':
      if (runResolves()) { requireTreeBound(); requireConverged(); }
      break;
    case 'waived':
      if (runResolves() && !(trees.has(run.auditedTree) || oids.has(run.auditedSha))) {
        problems.push(`run ${runId} is unrelated to this PR's commits`);
      }
      break;
    case 'not-run':
      if (runId) problems.push('not-run carries an AI-Run-ID');
      break;
    default:
      problems.push(`AI-Gate is ${gate === null ? 'missing' : `"${gate}"`}`);
  }
  if (problems.length === 0 && gate === 'converged' && run?.auditedTree === tree) {
    notes.push('converged where the commit tree equals the audited tree — an under-claim, true');
  }
  return { true: problems.length === 0, gate, problems, notes };
}

/**
 * Judge a train from gathered facts.
 *
 * @param {object} input
 * @param {Array<{pr: number, merged: null | {mergeOid: string, message: string, tree: string},
 *   identity: {ok: boolean, reason: string|null}|null, prCommits: Array<{oid: string, tree: string}>,
 *   run: object|null}>} input.sources — every manifest source, in manifest (landing) order
 * @param {Array<{oid: string, subject: string}>} input.chain — destination first-parent commits after the
 *   train's base, OLDEST first
 */
export function verifyTrain({ sources, chain }) {
  const position = new Map(chain.map((c, i) => [c.oid, i]));
  const perPr = {};
  const unmerged = [];
  const identityFailures = [];
  const falseClaims = [];
  const offChain = [];
  const actualGates = {};
  const trainMerges = new Map();

  for (const s of sources) {
    const key = String(s.pr);
    if (!s.merged) {
      unmerged.push(s.pr);
      perPr[key] = { merged: false, identity: null, claim: null };
      continue;
    }
    if (!position.has(s.merged.mergeOid)) offChain.push(s.pr);
    if (!s.identity?.ok) {
      // A foreign head is not a train source: its merge is not train evidence.
      identityFailures.push(s.pr);
      perPr[key] = { merged: true, identity: s.identity?.reason ?? 'identity not established', claim: null };
      continue;
    }
    trainMerges.set(s.merged.mergeOid, s.pr);
    const claim = checkClaimTruth({ message: s.merged.message, tree: s.merged.tree, prCommits: s.prCommits, run: s.run });
    if (!claim.true) falseClaims.push(s.pr);
    actualGates[key] = claim.gate;
    perPr[key] = { merged: true, identity: null, claim };
  }

  const onChain = [...trainMerges.keys()].filter((o) => position.has(o)).sort((a, b) => position.get(a) - position.get(b));
  const finalMergeOid = onChain.length ? onChain[onChain.length - 1] : null;
  const interleaved = [];
  if (finalMergeOid) {
    for (let i = 0; i <= position.get(finalMergeOid); i++) {
      if (!trainMerges.has(chain[i].oid)) interleaved.push({ oid: chain[i].oid, subject: chain[i].subject });
    }
  }
  return { perPr, finalMergeOid, interleaved, unmerged, identityFailures, falseClaims, offChain, actualGates };
}

/**
 * May this train be published now? `sync` calls this on the verification it
 * computed in the SAME invocation, with the flags given on that invocation.
 * Unmerged sources, foreign heads and merges off the destination's chain have
 * no acknowledging flag: they are not this train.
 *
 * @param {ReturnType<typeof verifyTrain>} v
 * @param {{acceptInterleaved?: boolean, acceptProvenanceMismatch?: boolean}} [acks]
 * @returns {{clear: boolean, blocks: Array<{reason: string, flag: string|null}>}}
 */
export function publicationClearance(v, { acceptInterleaved = false, acceptProvenanceMismatch = false } = {}) {
  const blocks = [];
  const list = (prs) => prs.map((p) => `#${p}`).join(', ');
  if (!v.finalMergeOid) blocks.push({ reason: 'no train merge is on the destination', flag: null });
  if (v.unmerged.length) blocks.push({ reason: `not merged: ${list(v.unmerged)}`, flag: null });
  if (v.identityFailures.length) blocks.push({ reason: `merged at a head the train did not test: ${list(v.identityFailures)}`, flag: null });
  if (v.offChain.length) blocks.push({ reason: `merge commit not on the destination's first-parent chain: ${list(v.offChain)}`, flag: null });
  if (v.falseClaims.length && !acceptProvenanceMismatch) {
    blocks.push({ reason: `provenance claims that do not hold: ${list(v.falseClaims)}`, flag: '--accept-provenance-mismatch' });
  }
  if (v.interleaved.length && !acceptInterleaved) {
    blocks.push({ reason: `${v.interleaved.length} foreign commit(s) interleaved before the final merge`, flag: '--accept-interleaved' });
  }
  return { clear: blocks.length === 0, blocks };
}

// ── Train-run thinness (plan §2.10a) ────────────────────────────────────────
//
// Did the train's combined run fail on a test the branch tier would NOT have
// selected for a source's head? A counterfactual observation about the branch
// tier, reported by `verify` and never gating (it is not about this train).
// Every function below is pure; the gathering, with its budget and error
// boundary, lives in commands.mjs.

/** The fleet tier results this metric knows how to read (fleet registry.mjs RESULTS). */
const KNOWN_TIER_RESULTS = new Set(['green', 'green-after-rerun', 'red', 'dirty', 'none']);
/** A log is read only up to this many bytes; a longer one is unmeasured, never truncated. */
export const THINNESS_MAX_LOG_BYTES = 64 * 1024 * 1024;
const ATTEMPT_HEADER = /^--- fleet: tier (.+) attempt (\d+) at .* ---$/;

/**
 * Which attempts of a tier failed, by fleet's own record. `null` when the
 * result says nothing about a test run (`dirty`, `none`).
 * @returns {number[]|null}
 */
function failedAttemptNumbers(t) {
  if (t.result === 'green') return [];
  if (t.result === 'green-after-rerun') return [1];
  if (t.result === 'red') return t.reran ? [1, 2] : [1];
  return null;
}

/**
 * The section of a fleet tier log for one attempt OF THE RECORDED RUN. A tier
 * interrupted and re-run on resume appends a whole new run to the same log,
 * starting at a new "attempt 1", so the recorded run begins at the LAST
 * "attempt 1" header; attempt n is the first header for n at or after it
 * (an older run's attempt 2 is never read for a newer run, code R3 M1).
 * The section runs up to the next header.
 * @returns {string|null}
 */
export function attemptSection(logText, tierName, attempt) {
  const lines = String(logText).split(/\r?\n/);
  const headerAt = (i) => { const m = ATTEMPT_HEADER.exec(lines[i]); return m && m[1] === tierName ? Number(m[2]) : null; };
  let runStart = -1;
  for (let i = 0; i < lines.length; i++) if (headerAt(i) === 1) runStart = i;
  if (runStart < 0) return null;
  let start = -1;
  for (let i = runStart; i < lines.length; i++) if (headerAt(i) === attempt) { start = i; break; }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (ATTEMPT_HEADER.test(lines[i])) { end = i; break; }
  return lines.slice(start + 1, end).join('\n');
}

/**
 * What the combined run failed on, from fleet's tier record and its logs.
 *
 * @param {object} input
 * @param {Array<{name: string, result: string, reran?: boolean, stage?: string}>|undefined} input.tierResults
 * @param {(tier: object) => ({ok: true, text: string}|{ok: false, reason: string})} input.readLog
 * @param {(payload: string) => {kind: string, files?: string[]}} input.parsePayload  failed-files-marker's one reader
 * @param {string} input.marker  the marker prefix
 * @returns {{ok: true, failures: Array<{tier: string, attempt: number, files: string[]}>}|{ok: false, reason: string}}
 */
export function failedAttempts({ tierResults, readLog, parsePayload, marker }) {
  if (!Array.isArray(tierResults) || tierResults.length === 0) return { ok: false, reason: 'the train has no recorded combined run (no tierResults)' };
  const preLand = tierResults.filter((t) => (t.stage ?? 'pre-land') === 'pre-land');
  // Only post-merge records is "no combined run examined", never a clean one (code R1 M3/M8).
  if (preLand.length === 0) return { ok: false, reason: 'the train records no pre-land tier result' };
  const failures = [];
  for (const t of preLand) {
    if (!KNOWN_TIER_RESULTS.has(t.result)) return { ok: false, reason: `tier ${t.name}: result ${JSON.stringify(t.result)} is not one fleet records` };
    const attempts = failedAttemptNumbers(t);
    if (attempts === null) return { ok: false, reason: `tier ${t.name} is ${t.result}: not a test verdict` };
    if (attempts.length === 0) continue;
    const log = readLog(t);
    if (!log.ok) return { ok: false, reason: `tier ${t.name}: ${log.reason}` };
    for (const attempt of attempts) {
      const section = attemptSection(log.text, t.name, attempt);
      if (section === null) return { ok: false, reason: `tier ${t.name}: its log has no section for attempt ${attempt}` };
      const markerLines = section.split('\n').filter((l) => l.includes(marker));
      if (!markerLines.length) return { ok: false, reason: `tier ${t.name} attempt ${attempt}: no failed-files line (a timeout, a tier that is not run-tests, or a run that died)` };
      const last = markerLines[markerLines.length - 1];
      const parsed = parsePayload(last.slice(last.indexOf(marker) + marker.length));
      if (parsed.kind === 'unknown') return { ok: false, reason: `tier ${t.name} attempt ${attempt}: run-tests could not name its failing files (unknown)` };
      if (parsed.kind !== 'files') return { ok: false, reason: `tier ${t.name} attempt ${attempt}: malformed failed-files line` };
      if (parsed.files.length === 0) return { ok: false, reason: `tier ${t.name} attempt ${attempt}: it failed, but its failed-files line names no file` };
      failures.push({ tier: t.name, attempt, files: [...parsed.files].sort() });
    }
  }
  return { ok: true, failures };
}

/**
 * Validate one `test-tier select --json` answer. Anything that is not a
 * measured envelope for exactly this head, with a string `skipped[]`, is
 * unmeasured: absence of a skip list never reads as "skipped nothing".
 *
 * @param {{status: number|null, stdout: string, stderr?: string, error?: string|null}} r
 * @param {string} head
 * @returns {{measured: true, skipped: string[], selector: object|null, manifest: string|null}|{measured: false, reason: string}}
 */
export function parseSelection(r, head) {
  if (r.error) return { measured: false, reason: `the selection query did not run (${r.error})` };
  if (r.status !== 0 && r.status !== 3) {
    const tail = r.stderr ? `: ${String(r.stderr).trim().split('\n').pop().slice(0, 200)}` : '';
    return { measured: false, reason: `the selection query exited ${r.status ?? 'without a status'}${tail}` };
  }
  let env;
  try { env = JSON.parse(r.stdout); } catch { return { measured: false, reason: 'the selection query printed unparseable output' }; }
  if (env?.measured === false) return { measured: false, reason: String(env.reason ?? 'unmeasured, no reason given') };
  if (r.status !== 0 || env?.measured !== true) return { measured: false, reason: 'the selection query did not say it measured' };
  if (env.head !== head) return { measured: false, reason: `the selection answered for ${String(env.head).slice(0, 12)}, not ${head.slice(0, 12)}` };
  if (!Array.isArray(env.skipped) || !env.skipped.every((f) => typeof f === 'string' && f)) return { measured: false, reason: 'the selection carries no valid skipped[]' };
  return { measured: true, skipped: env.skipped, selector: env.selector ?? null, manifest: env.manifest ?? null };
}

/**
 * Does `file` exist at a head, from `git ls-tree -z --full-tree <oid> -- <file>`? Exit 0 with a blob record for
 * exactly that path is present; exit 0 with no output is absent; anything else (a non-zero exit, a record that is
 * not a blob of that path, an unterminated stream) cannot say, and is never read as absent.
 * @param {{status: number|null, stdout: string}} r
 * @param {string} file
 * @returns {{known: true, exists: boolean}|{known: false, reason: string}}
 */
export function readExistence(r, file) {
  if (r.status !== 0) return { known: false, reason: `git ls-tree exited ${r.status ?? 'without a status'}` };
  const out = String(r.stdout ?? '');
  if (out === '') return { known: true, exists: false };
  if (!out.endsWith('\0')) return { known: false, reason: 'git ls-tree output is not NUL-terminated' };
  const records = out.slice(0, -1).split('\0');
  const m = records.length === 1 ? /^\d+ (\w+) [0-9a-f]+\t(.*)$/s.exec(records[0]) : null;
  if (!m || m[2] !== file) return { known: false, reason: 'git ls-tree returned an unexpected record' };
  return m[1] === 'blob' ? { known: true, exists: true } : { known: false, reason: `${file} is a ${m[1]} at this head, not a file` };
}

/**
 * Classify one (failing file, source) pair (plan §2.10a).
 * @param {object} a
 * @param {{measured: boolean, skipped?: string[], reason?: string}} a.selection
 * @param {{known: true, exists: boolean}|{known: false, reason: string}|null} a.existence  null when not asked
 * @param {string} a.file
 * @returns {{class: 'skipped'|'selected'|'absent'|'unmeasured', reason?: string}}
 */
export function classifyPair({ selection, existence, file }) {
  if (!selection.measured) return { class: 'unmeasured', reason: selection.reason };
  if (selection.skipped.includes(file)) return { class: 'skipped' };
  if (!existence) return { class: 'unmeasured', reason: 'whether the file exists at this head was not asked' };
  if (!existence.known) return { class: 'unmeasured', reason: existence.reason };
  return existence.exists ? { class: 'selected' } : { class: 'absent' };
}

/**
 * The train's thinness verdict: an ordered table, first match wins (plan §2.10a).
 *
 * @param {object} input
 * @param {{ok: true, failures: Array<{tier: string, attempt: number, files: string[]}>}|{ok: false, reason: string}} input.attempts
 * @param {Array<{file: string, pairs: Array<{pr: number, class: string, reason?: string}>}>} input.files
 *   one entry per distinct failing file, with a pair for every source
 * @returns {{verdict: 'unmeasured'|'thin'|'not-thin'|'no-failures', reason: string|null, failures: object[]}}
 */
export function judgeThinness({ attempts, files }) {
  if (!attempts.ok) return { verdict: 'unmeasured', reason: attempts.reason, failures: [] };
  if (attempts.failures.length === 0) return { verdict: 'no-failures', reason: null, failures: [] };
  const byFile = new Map(files.map((f) => [f.file, f.pairs]));
  const failures = [];
  for (const a of attempts.failures) {
    for (const file of a.files) {
      const pairs = byFile.get(file) ?? [];
      const of = (c) => pairs.filter((p) => p.class === c).map((p) => p.pr);
      const unmeasuredFor = pairs.filter((p) => p.class === 'unmeasured').map((p) => ({ pr: p.pr, reason: p.reason ?? null }));
      const applicable = pairs.filter((p) => p.class !== 'absent');
      failures.push({
        tier: a.tier, attempt: a.attempt, file,
        skippedBy: of('skipped'), selectedBy: of('selected'), absentFrom: of('absent'), unmeasuredFor,
        // Complete or false: no unmeasured pair, at least one applicable source, every one of them skipped.
        skippedByAll: unmeasuredFor.length === 0 && applicable.length > 0 && applicable.every((p) => p.class === 'skipped'),
      });
    }
  }
  if (failures.some((f) => f.skippedBy.length)) return { verdict: 'thin', reason: null, failures };
  const unasked = failures.find((f) => f.skippedBy.length + f.selectedBy.length + f.absentFrom.length + f.unmeasuredFor.length === 0);
  if (unasked) return { verdict: 'unmeasured', reason: `${unasked.file}: no source was asked about it`, failures };
  const partial = failures.find((f) => f.unmeasuredFor.length);
  if (partial) return { verdict: 'unmeasured', reason: `${partial.file}: unmeasured for ${partial.unmeasuredFor.map((u) => `#${u.pr}`).join(', ')}`, failures };
  const orphan = failures.find((f) => f.selectedBy.length === 0);
  if (orphan) return { verdict: 'unmeasured', reason: `${orphan.file} exists at no source's head, so no source can speak for it`, failures };
  return { verdict: 'not-thin', reason: null, failures };
}
