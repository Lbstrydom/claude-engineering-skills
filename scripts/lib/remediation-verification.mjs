/**
 * @fileoverview Out-of-band remediation-state verification — the reconciler
 * for `accepted`/`severity_adjusted` findings stuck at `remediation_state`
 * `pending`/`planned` that the live-audit-round lifecycle
 * (`computeFixLifecycleUpdates`/`reconcileRemediationProjection`,
 * `scripts/lib/ledger.mjs` / `scripts/lib/store/runs-findings.mjs`) cannot
 * reach — see docs/plans/remediation-state-verification-reconciler.md.
 *
 * Split deliberately into PURE decision functions (selection, grouping,
 * verdict normalisation, write-action planning — all directly unit-testable)
 * and a small set of IMPURE adapters (git reads, the LLM call) that a caller
 * injects, mirroring `scripts/lib/campaign/adjudicate.mjs`'s split between the
 * pure verdict contract and `callAdjudicator` in the CLI.
 *
 * @module scripts/lib/remediation-verification
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  gitDiffWithWorkingTree, gitNumstatWithWorkingTree, gitUnifiedDiffWithWorkingTree, isSafeGitRevision,
} from './vcs.mjs';
import { resolveAndClassify } from './sensitive-paths.mjs';
import { buildToolUseRequest, withToolInstruction } from './anthropic-tool-choice.mjs';

// ── Selection / gating (pure) ────────────────────────────────────────────

/**
 * The commit a row's "did anything change" gate is measured from: the last
 * time this reconciler actually checked it, or (never checked) the commit it
 * was accepted at. Using the LATER checkpoint is the throttle — see the
 * plan's Decision B.
 */
export function effectiveSinceCommit(row) {
  return row.remediation_last_checked_commit || row.accepted_at_commit;
}

/**
 * PURE. Partitions candidate rows using an injected file-state predicate —
 * never touches git itself, so it is directly testable with a fake.
 *
 * @param {object[]} rows - shape from getStaleAcceptedFindingsForVerification
 *   (audit_finding_id, primary_file, detail_snapshot, category, severity,
 *   finding_fingerprint, accepted_at_commit, remediation_last_checked_commit)
 * @param {(file: string, sinceCommit: string) => 'changed'|'unchanged'|'deleted'|'untracked'|'unknown'} fileState
 * @param {(file: string) => boolean} [isSensitivePath] - classifies `primary_file`
 *   BEFORE any git/LLM work is attempted on it; defaults to "never sensitive"
 *   only for callers that supply their own gate — production wiring always
 *   passes `scripts/lib/sensitive-paths.mjs`-backed classification (see the
 *   CLI), since a finding's file content and diff are about to be quoted into
 *   an external LLM prompt if this gate does not stop it here.
 * @returns {{needsLlmCheck: object[], mechanicallyResolved: object[],
 *            sensitivePathSkipped: object[], unresolvablePathSkipped: object[],
 *            skipped: Array<{row: object, reason: string}>}}
 */
export function selectFindingsNeedingCheck(rows, fileState, isSensitivePath = () => false) {
  const needsLlmCheck = [];
  const mechanicallyResolved = [];
  const sensitivePathSkipped = [];
  const unresolvablePathSkipped = [];
  const skipped = [];
  // Accepts EITHER shape, so this stays a drop-in for both the boolean predicate and
  // the reason-returning classifier. A bare `true` is read as `sensitive`, which is
  // what the old callers meant — it can only under-split, never mislabel a real hit
  // as merely unresolvable.
  const skipReason = (file) => {
    const verdict = isSensitivePath(file);
    if (verdict === true) return PATH_SKIP_SENSITIVE;
    if (verdict === false || verdict == null) return null;
    return verdict;
  };
  for (const row of rows || []) {
    const sinceCommit = effectiveSinceCommit(row);
    if (!row.primary_file || !sinceCommit) {
      skipped.push({ row, reason: 'missing-primary-file-or-commit' });
      continue;
    }
    // Checked BEFORE any git/content read — a sensitive path is refused
    // outright, never diffed or shown to the LLM, and never mechanically
    // "resolved" either (a deleted `.env` is not evidence this reconciler
    // should act on unsupervised). It is left exactly where it was.
    const reason = skipReason(row.primary_file);
    if (reason === PATH_SKIP_SENSITIVE) { sensitivePathSkipped.push(row); continue; }

    const state = fileState(row.primary_file, sinceCommit);

    // An UNRESOLVABLE path may still be MECHANICALLY resolved — and only that.
    //
    // Found while fixing f8d2730f, and it is the more consequential half. The skip
    // above used to `continue` before `fileState` ran, so a file that no longer
    // exists in the working tree failed `realpathSync`, was bucketed as sensitive,
    // and never reached `state === 'deleted'`. That made `mechanicallyResolved`
    // unreachable for EXACTLY the population it was built for — AGENTS.md describes
    // it as "a file that was simply deleted resolves mechanically, no LLM needed",
    // and both this repo and the reporting consumer measured `0 mechanically
    // resolved` on queues of 282 and 52. A documented capability, dead on arrival.
    //
    // Why reaching `fileState` from here is SAFE, and why only this outcome is:
    //   - `fileState` is `git diff --name-status` (buildFileChangeStateFn). It reads
    //     no file CONTENT and cannot be redirected by a working-tree symlink, which
    //     is the hazard `resolveAndClassify` is here to catch.
    //   - `mechanicalResolvedAction` is pure: it writes a store verdict keyed on the
    //     finding id and never opens the path.
    //   - Every other outcome keeps the row refused. `changed` in particular must
    //     NOT fall through to `needsLlmCheck`, which reads content and quotes it into
    //     an external prompt. That is the whole gate, and it is intact.
    // A plan-mode section reference is simply never listed by `git diff`, so it stays
    // in `unresolvablePathSkipped` where it belongs.
    //
    // A genuinely SENSITIVE path is deliberately NOT given this route: a deleted
    // `.env` is not evidence this reconciler should act on unsupervised (the
    // pre-existing policy, unchanged).
    if (reason === PATH_SKIP_UNRESOLVABLE) {
      if (state === 'deleted') { mechanicallyResolved.push(row); continue; }
      unresolvablePathSkipped.push(row);
      continue;
    }

    if (state === 'deleted') { mechanicallyResolved.push(row); continue; }
    if (state === 'changed') { needsLlmCheck.push(row); continue; }
    if (state === 'unchanged') { skipped.push({ row, reason: 'unchanged-since-last-check' }); continue; }
    // NOT folded into `unchanged`. `git diff <commit>` is structurally silent
    // about a path git does not track, so "this file did not change" is a claim
    // the instrument never made — the same fail-quiet shape as f8d2730f, where a
    // bucket swallowed the population the feature exists to serve. A row parked
    // here is a permanent coverage hole, not a throttle working as designed, and
    // it must be countable as such.
    if (state === 'untracked') { skipped.push({ row, reason: 'path-not-tracked' }); continue; }
    skipped.push({ row, reason: 'commit-unresolvable' });
  }
  return { needsLlmCheck, mechanicallyResolved, sensitivePathSkipped, unresolvablePathSkipped, skipped };
}

/**
 * PURE. Batch findings by `primary_file` — one LLM call verifies every
 * pending finding on that file at once (the user's suggested shape, and it
 * minimises call count on a file carrying several stuck findings).
 */
export function groupByFile(findings) {
  const byFile = new Map();
  for (const f of findings || []) {
    const key = f.primary_file;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(f);
  }
  return [...byFile.entries()].map(([file, batch]) => ({ file, findings: batch }));
}

// ── The impure git adapter ────────────────────────────────────────────────

/**
 * The ONE spelling both sides of this module's path comparisons are reduced to.
 *
 * `scripts/lib/sync-owned-sidecar.mjs` states the same rule for the ownership
 * sidecar (`comparisonKey`, and the artifact itself declares
 * `"comparison": "case-insensitive"`). It is deliberately NOT imported here:
 * that module is not in the consumer sync manifest, so importing it would drag
 * sync-authoring internals into every consumer bundle for a one-line fold. The
 * rule is shared; the distribution closures are not.
 *
 * @param {string} p
 * @returns {string}
 */
function pathComparisonKey(p) {
  return String(p).replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

/**
 * Index one `gitDiffWithWorkingTree` result by path, once per distinct
 * `sinceCommit`, so the per-row lookup is O(1) rather than four array scans.
 *
 * Insertion order encodes the precedence the linear form had: added/modified,
 * then renamed, then deleted LAST so it wins. `untracked` is indexed too — see
 * that state's note in the caller.
 */
function indexDiffByPath(diff) {
  const exact = new Map();
  const folded = new Map();
  const put = (p, state) => {
    if (typeof p !== 'string' || p === '') return;
    exact.set(p, state);
    folded.set(pathComparisonKey(p), state);
  };
  for (const p of diff.untracked || []) put(p, 'untracked');
  for (const p of diff.added || []) put(p, 'changed');
  for (const p of diff.modified || []) put(p, 'changed');
  for (const r of diff.renamed || []) { put(r.from, 'changed'); put(r.to, 'changed'); }
  for (const p of diff.deleted || []) put(p, 'deleted');
  return { exact, folded };
}

/**
 * Build a memoised
 * `(file, sinceCommit) => 'changed'|'unchanged'|'deleted'|'untracked'|'unknown'`
 * predicate for `selectFindingsNeedingCheck`. One `git diff --name-status`
 * subprocess call per DISTINCT `sinceCommit` seen (findings sharing an
 * acceptance commit — the common case, since many stuck findings come from
 * one run — never re-pay the git call).
 *
 * **The comparison is case-insensitive, and that is the whole point.** Upstream
 * report (Lbstrydom/wine-cellar-app, 2026-09-07). `audit_findings.primary_file`
 * is written through `normalizePath`, whose last operation is `.toLowerCase()`
 * — it is a MATCHING key (AGENTS.md §Accepted Technical Debt), lossy by design.
 * `git diff --name-status` emits REAL-CASED paths on every platform, and git's
 * pathspec matching is case-sensitive even on a case-insensitive filesystem. So
 * the raw `String === String` this used to do could never match a stored path
 * whose real spelling carries an uppercase letter: the reconciler bucketed every
 * such row as "unchanged", never examined it, never stamped
 * `remediation_last_checked_at`, and exited `ok`. In a camelCase/PascalCase
 * codebase that is most of the repo. Reproduced HERE, on Windows — where the
 * filesystem's own case-insensitivity is irrelevant, because the defect is in a
 * string compare: against `HEAD~3`, `AGENTS.md` answered `changed` and
 * `agents.md` answered `unchanged`.
 *
 * Fixed at the READER, never at `normalizePath`: that fold is the
 * dedup/fingerprint key shared by `ledger.mjs`, `findings-pipeline.mjs` and
 * `semantic-suppression.mjs`, so unfolding it there would move the bug rather
 * than remove it. `displayPathOf` (7cc1a47a) fixed the WRITE side going forward;
 * this fixes every row already stored, which is the population the reconciler
 * exists to serve.
 *
 * EXACT match wins before the folded fallback, so a repo that genuinely tracks
 * two paths differing only in case still answers precisely for both. Only when
 * nothing matches exactly does the fold decide, and its worst case — attributing
 * a sibling's change to the wrong spelling — routes the row to an LLM check that
 * defaults to `uncertain`. That is the safe direction: it can over-examine, never
 * emit a false `resolved`.
 *
 * @param {string} repoRoot
 * @returns {(file: string, sinceCommit: string) => 'changed'|'unchanged'|'deleted'|'untracked'|'unknown'}
 */
export function buildFileChangeStateFn(repoRoot) {
  const cache = new Map(); // sinceCommit -> {exact, folded} | null
  return (file, sinceCommit) => {
    if (!isSafeGitRevision(sinceCommit)) return 'unknown';
    let index = cache.get(sinceCommit);
    if (index === undefined) {
      const res = gitDiffWithWorkingTree(repoRoot, sinceCommit);
      index = res.ok ? indexDiffByPath(res.files) : null;
      cache.set(sinceCommit, index);
    }
    if (!index) return 'unknown';
    const normalised = String(file).replaceAll('\\', '/');
    const hit = index.exact.get(normalised) ?? index.folded.get(pathComparisonKey(normalised));
    // Absence from a READABLE diff is a true "did not change since sinceCommit"
    // — for a path git tracks. `untracked` is separated above because for such a
    // path `git diff <commit>` is structurally silent, so "unchanged" would be a
    // claim this instrument never made.
    return hit ?? 'unchanged';
  };
}

/**
 * Build a memoised `(file) => boolean` sensitive-path gate for
 * `selectFindingsNeedingCheck`, backed by the single sensitive-path oracle
 * (`scripts/lib/sensitive-paths.mjs` — AGENTS.md: "never add a fifth
 * implementation"). `resolveAndClassify`, not the historical-read variant
 * `assertGitPathAdmissible`: this reconciler reads the LIVE working tree
 * (`fs.readFileSync`), where a symlink-bypass is a real hazard realpath
 * resolution exists to catch — unlike a `git show <sha>:<path>` read, which
 * cannot be redirected by a working-tree symlink at all.
 *
 * @param {string} repoRoot
 * @returns {(file: string) => boolean}
 */
export function buildSensitivePathPredicate(repoRoot) {
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    const { category } = resolveAndClassify(file, { repoRoot });
    const sensitive = category === 'sensitive';
    cache.set(file, sensitive);
    return sensitive;
  };
}

/**
 * The two REASONS a row is refused before any git or LLM work — kept apart because
 * they are opposite claims, and one of them was being asserted falsely.
 *
 * Upstream report f8d2730f (Lbstrydom/wine-cellar-app, 2026-09-06). `resolveAndClassify`
 * answers `category: 'sensitive'` for FOUR distinct situations, and the boolean predicate
 * above fuses all four into one bucket the CLI then printed as `N sensitive-path skipped`:
 *
 *   1. `lexical` matched a sensitive PATTERN — a real hit (`.env`, keys).
 *   2. the resolved path ESCAPED the repo — a real hazard (INC-001's symlink class).
 *   3. the canonical path re-classified sensitive — the innocently-named symlink into
 *      `~/.ssh/`, also INC-001.
 *   4. `realpathSync` simply FAILED — and a plan-mode finding's `primary_file` is a
 *      section reference (`§2 decision 4; phase 0`), so it fails on every single one.
 *
 * Only 1-3 are security facts. Measured in the reporting consumer: 44 of 52 eligible
 * rows were bucket 4, in a repo with ZERO credential-like paths in its queue — the
 * operator was shown `44 sensitive-path skipped`, which reads as "44 credential-ish
 * files are under audit here" and had nothing to find. Meanwhile the fact that WAS
 * true and useful — *these rows have no file to diff, so this tool can never process
 * them* — appeared nowhere.
 *
 * **Both still skip, and the fail-closed behaviour is unchanged.** An unresolvable path
 * must still be refused: this module reads file CONTENT with `fs.readFileSync` and quotes
 * it into an external LLM prompt, which is the whole reason realpath resolution is here.
 * Only the accounting and the operator-facing wording change — a bucket is not a
 * permission.
 *
 * Keyed on `resolutionFailed` rather than on "no lexical match", deliberately: cases 2
 * and 3 also carry a null `lexical`, and reading them as "just unresolvable" would
 * downgrade the two REAL hazards this classifier exists to catch. They resolve fine;
 * that is what distinguishes them.
 */
export const PATH_SKIP_SENSITIVE = 'sensitive';
export const PATH_SKIP_UNRESOLVABLE = 'unresolvable';

/**
 * Classify why a `primary_file` is refused, or `null` when it is fine to process.
 *
 * The reason-returning sibling of `buildSensitivePathPredicate`. Same resolution, same
 * refusals, same cache shape — it just stops throwing away WHICH of the two it was.
 *
 * @param {string} repoRoot
 * @returns {(file: string) => 'sensitive'|'unresolvable'|null}
 */
export function buildPathSkipClassifier(repoRoot) {
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    const { category, resolutionFailed } = resolveAndClassify(file, { repoRoot });
    let reason = null;
    if (category === 'sensitive') {
      reason = resolutionFailed ? PATH_SKIP_UNRESOLVABLE : PATH_SKIP_SENSITIVE;
    }
    cache.set(file, reason);
    return reason;
  };
}

const MAX_CONTENT_BYTES = 60_000;
const MAX_DIFF_BYTES = 20_000;
const MAX_DIFF_CHANGED_LINES = 4_000;

/** Read the CURRENT (working-tree) content of a file, bounded and truncation-flagged. */
export function readCurrentFileForVerification(repoRoot, file) {
  try {
    const buf = fs.readFileSync(path.join(repoRoot, file));
    if (buf.length > MAX_CONTENT_BYTES) {
      return { exists: true, content: buf.subarray(0, MAX_CONTENT_BYTES).toString('utf-8'), truncated: true };
    }
    return { exists: true, content: buf.toString('utf-8'), truncated: false };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, content: null, truncated: false };
    // Unreadable for any other reason (permissions, a directory, binary
    // decode trouble) — conservative: no content shown, flagged truncated so
    // the verifier's own "truncated + defect not visible ⇒ uncertain" rule
    // applies rather than silently omitting the file.
    return { exists: true, content: null, truncated: true };
  }
}

/** The unified diff since `sinceCommit`, numstat-preflighted per the project's bound-before-materialise convention. */
export function readDiffForVerification(repoRoot, sinceCommit) {
  const numstat = gitNumstatWithWorkingTree(repoRoot, sinceCommit);
  if (!numstat.ok || numstat.totalChangedLines > MAX_DIFF_CHANGED_LINES) {
    return { diffText: '', truncated: true };
  }
  const diff = gitUnifiedDiffWithWorkingTree(repoRoot, sinceCommit, { maxBytes: MAX_DIFF_BYTES });
  if (!diff.ok) return { diffText: '', truncated: true };
  return { diffText: diff.diffText, truncated: false };
}

// ── The verification contract (pure schema/prompt, mirrors campaign/adjudicate.mjs) ──

export const VerificationVerdictSchema = z.object({
  fingerprint: z.string().min(1),
  verdict: z.enum(['resolved', 'still-present', 'uncertain']),
  rationale: z.string().min(1),
}).strict();

/** The tool the verifier is FORCED to call. No other tool is offered. */
export const VERIFICATION_RESULT_TOOL = Object.freeze({
  name: 'record_remediation_verdicts',
  description: 'Record, for every listed finding, whether it is still present in the current file content shown.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['fingerprint', 'verdict', 'rationale'],
          properties: {
            fingerprint: { type: 'string' },
            verdict: { type: 'string', enum: ['resolved', 'still-present', 'uncertain'] },
            rationale: { type: 'string' },
          },
        },
      },
    },
  },
});

export const VERIFICATION_SYSTEM_PROMPT = [
  'You VERIFY whether previously-accepted code-audit findings are STILL PRESENT in the CURRENT version',
  'of one file. You do not judge whether a finding is worth fixing, and you do not re-audit the file for',
  'new issues — only the specific findings listed.',
  '',
  'You are shown, per finding: its category, severity, and a snapshot of its description at the time it',
  'was accepted. You are shown the file: either its full current content, or a diff since the commit the',
  'finding was accepted at (or both). A `truncated: true` file or diff means you were NOT shown the whole',
  'picture.',
  '',
  'For EACH finding, in ONE call, return exactly one verdict:',
  '  - "resolved" — the described defect is clearly no longer present; the code was changed in a way that',
  '    addresses it.',
  '  - "still-present" — the defect is still there, unchanged, or the file changed in ways unrelated to it.',
  '  - "uncertain" — you cannot tell from what you were shown. This is the DEFAULT when in doubt.',
  '',
  'Rules, in order of precedence:',
  '1. If `truncated: true` (file or diff) and the defect is not visible in what you were shown, answer',
  '   "uncertain" — never "resolved". A partial view is not evidence of absence.',
  '2. If the finding\'s description is too vague to check against the code shown, answer "uncertain".',
  '3. Default to "uncertain" rather than guessing "resolved" — a wrong "resolved" verdict silently drops a',
  '   real defect from tracking, with no re-audit to catch the mistake.',
  '',
  'Every finding in the input MUST get exactly one verdict, keyed by its `fingerprint`.',
].join('\n');

/**
 * PURE. Validate a raw tool-call payload against `expectedFingerprints`,
 * downgrading every gap to `uncertain` rather than dropping it — a malformed
 * or partial model response must never silently leave a finding un-actioned
 * (it stays exactly where it was: `pending`/`planned`, tracking columns
 * bumped so it is not re-asked until the file changes again).
 *
 * @param {unknown} raw - the tool call's `.input`, or null/undefined on failure
 * @param {{expectedFingerprints: string[]}} ctx
 * @returns {Array<{fingerprint: string, verdict: 'resolved'|'still-present'|'uncertain', rationale: string}>}
 */
export function normaliseVerificationVerdicts(raw, { expectedFingerprints }) {
  const parsed = z.object({ verdicts: z.array(VerificationVerdictSchema) }).safeParse(raw);
  const byFingerprint = new Map();
  if (parsed.success) {
    for (const v of parsed.data.verdicts) {
      if (expectedFingerprints.includes(v.fingerprint)) byFingerprint.set(v.fingerprint, v);
    }
  }
  const fallbackReason = parsed.success
    ? 'model did not return a verdict for this finding'
    : `schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
  return expectedFingerprints.map((fp) => byFingerprint.get(fp) || {
    fingerprint: fp, verdict: 'uncertain', rationale: fallbackReason,
  });
}

/**
 * The one impure LLM-call function — everything else in this module is pure.
 * Any failure (no tool call, thrown error, network) degrades to `uncertain`
 * for every finding in the batch via `normaliseVerificationVerdicts(null, …)`,
 * never a thrown exception the caller must separately handle.
 *
 * @param {{client: object, model: string, file: string, findings: object[],
 *           diffText: string, currentContent: string|null, truncated: boolean}} args
 * @returns {Promise<{ok: boolean, verdicts: object[], usage: object|null, error: string|null}>}
 */
export async function callVerifier({ client, model, file, findings, diffText, currentContent, truncated }) {
  const expectedFingerprints = findings.map((f) => f.finding_fingerprint);
  const userPayload = {
    file,
    truncated,
    diff: diffText || null,
    currentContent: currentContent ?? null,
    findings: findings.map((f) => ({
      fingerprint: f.finding_fingerprint,
      category: f.category,
      severity: f.severity,
      detail: f.detail_snapshot,
    })),
  };
  // Forced only where the model accepts it: `--model latest-opus` resolves to
  // Opus 5.5, which 400s on a forced tool_choice (anthropic-tool-choice.mjs).
  const toolUse = buildToolUseRequest(model, VERIFICATION_RESULT_TOOL);
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 4000,
      system: withToolInstruction(VERIFICATION_SYSTEM_PROMPT, toolUse.instruction),
      messages: [{ role: 'user', content: JSON.stringify(userPayload, null, 2) }],
      tools: toolUse.tools,
      tool_choice: toolUse.tool_choice,
    });
    const call = resp?.content?.find((b) => b.type === 'tool_use' && b.name === VERIFICATION_RESULT_TOOL.name);
    if (!call) {
      return {
        ok: false, error: 'model did not call the verdict tool',
        verdicts: normaliseVerificationVerdicts(null, { expectedFingerprints }), usage: resp?.usage ?? null,
      };
    }
    return {
      ok: true, error: null,
      verdicts: normaliseVerificationVerdicts(call.input, { expectedFingerprints }), usage: resp?.usage ?? null,
    };
  } catch (err) {
    return {
      ok: false, error: err?.message || String(err),
      verdicts: normaliseVerificationVerdicts(null, { expectedFingerprints }), usage: null,
    };
  }
}

// ── Verdict → store-action planning (pure) ─────────────────────────────────

/**
 * PURE. Maps a batch's verdicts (keyed by fingerprint) back onto their
 * `audit_finding_id`s and the terminal-vs-tracking-only write shape
 * `applyRemediationVerificationResults` expects. A verdict whose fingerprint
 * matches no row in the batch is dropped — unrepresentable, logged by the
 * caller, never guessed at.
 *
 * @param {object[]} findingsBatch - the rows passed to callVerifier
 * @param {Array<{fingerprint: string, verdict: string, rationale: string}>} verdicts
 * @param {string} checkedAtCommit - HEAD sha at verification time
 * @returns {Array<{findingId: string, outcome: 'resolved'|'still-present'|'uncertain', checkedAtCommit: string, rationale: string}>}
 */
export function planWriteActions(findingsBatch, verdicts, checkedAtCommit) {
  const byFingerprint = new Map((findingsBatch || []).map((f) => [f.finding_fingerprint, f]));
  const actions = [];
  for (const v of verdicts || []) {
    const row = byFingerprint.get(v.fingerprint);
    if (!row) continue;
    actions.push({
      findingId: row.audit_finding_id,
      outcome: v.verdict,
      checkedAtCommit,
      rationale: v.rationale,
    });
  }
  return actions;
}

/** The write action for a mechanically-resolved row (its file no longer exists) — no LLM call needed. */
export function mechanicalResolvedAction(row, checkedAtCommit) {
  return {
    findingId: row.audit_finding_id,
    outcome: 'resolved',
    checkedAtCommit,
    rationale: 'primary_file no longer exists in the working tree (mechanical — no LLM call)',
  };
}
