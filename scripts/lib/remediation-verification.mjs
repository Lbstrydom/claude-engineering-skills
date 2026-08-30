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
 * @param {(file: string, sinceCommit: string) => 'changed'|'unchanged'|'deleted'|'unknown'} fileState
 * @param {(file: string) => boolean} [isSensitivePath] - classifies `primary_file`
 *   BEFORE any git/LLM work is attempted on it; defaults to "never sensitive"
 *   only for callers that supply their own gate — production wiring always
 *   passes `scripts/lib/sensitive-paths.mjs`-backed classification (see the
 *   CLI), since a finding's file content and diff are about to be quoted into
 *   an external LLM prompt if this gate does not stop it here.
 * @returns {{needsLlmCheck: object[], mechanicallyResolved: object[],
 *            sensitivePathSkipped: object[], skipped: Array<{row: object, reason: string}>}}
 */
export function selectFindingsNeedingCheck(rows, fileState, isSensitivePath = () => false) {
  const needsLlmCheck = [];
  const mechanicallyResolved = [];
  const sensitivePathSkipped = [];
  const skipped = [];
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
    if (isSensitivePath(row.primary_file)) {
      sensitivePathSkipped.push(row);
      continue;
    }
    const state = fileState(row.primary_file, sinceCommit);
    if (state === 'deleted') { mechanicallyResolved.push(row); continue; }
    if (state === 'changed') { needsLlmCheck.push(row); continue; }
    if (state === 'unchanged') { skipped.push({ row, reason: 'unchanged-since-last-check' }); continue; }
    skipped.push({ row, reason: 'commit-unresolvable' });
  }
  return { needsLlmCheck, mechanicallyResolved, sensitivePathSkipped, skipped };
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
 * Build a memoised `(file, sinceCommit) => 'changed'|'unchanged'|'deleted'|'unknown'`
 * predicate for `selectFindingsNeedingCheck`. One `git diff --name-status`
 * subprocess call per DISTINCT `sinceCommit` seen (findings sharing an
 * acceptance commit — the common case, since many stuck findings come from
 * one run — never re-pay the git call).
 *
 * @param {string} repoRoot
 * @returns {(file: string, sinceCommit: string) => 'changed'|'unchanged'|'deleted'|'unknown'}
 */
export function buildFileChangeStateFn(repoRoot) {
  const cache = new Map(); // sinceCommit -> DiffShape | null
  return (file, sinceCommit) => {
    if (!isSafeGitRevision(sinceCommit)) return 'unknown';
    let diff = cache.get(sinceCommit);
    if (diff === undefined) {
      const res = gitDiffWithWorkingTree(repoRoot, sinceCommit);
      diff = res.ok ? res.files : null;
      cache.set(sinceCommit, diff);
    }
    if (!diff) return 'unknown';
    const normalised = String(file).replace(/\\/g, '/');
    if (diff.deleted.includes(normalised)) return 'deleted';
    if (diff.renamed.some((r) => r.to === normalised || r.from === normalised)) return 'changed';
    if (diff.modified.includes(normalised) || diff.added.includes(normalised)) return 'changed';
    return 'unchanged';
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
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 4000,
      system: VERIFICATION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(userPayload, null, 2) }],
      tools: [VERIFICATION_RESULT_TOOL],
      tool_choice: { type: 'tool', name: VERIFICATION_RESULT_TOOL.name },
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
