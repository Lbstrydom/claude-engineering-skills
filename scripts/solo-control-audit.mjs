#!/usr/bin/env node
/**
 * @fileoverview Solo author-model control ("arm S") — the NULL-HYPOTHESIS baseline
 * the A/B/C code-audit experiment lacks. A/B/C all compare heavyweight EXTERNAL
 * auditor pipelines against each other; none measures what the author-class model
 * (Sonnet-5) catches reviewing the same diff COLD, solo, with no GPT/OSS/Gemini
 * layer. If Sonnet-solo recovers most externally-accepted findings AND surfaces
 * real ones the apparatus missed, the external stack needs justification; if
 * external-only accepted findings dominate, it earns its keep.
 *
 * Design (from /brainstorm --with-gemini, 2026-07-04 — sessions 1783178984262 +
 * 1783179213097). Deliberately an OFFLINE script over the ledger diffs, NOT a 4th
 * arm in the shared-stage shadow harness (audit-shadow.mjs), for three reasons the
 * two external models converged on:
 *   1. COLD-DIFF, not in-context self-review — isolates author bias from context-
 *      window pollution; the true sibling to A/B/C (same frozen artifact + audit
 *      framing). In-context "did the coding session catch itself" is a later study.
 *   2. BLIND UNION RE-ADJUDICATION by a HUMAN — the existing accept/dismiss labels
 *      were produced BY the external pipeline, so grading S against them makes S a
 *      structural subset of the incumbent. `merge` emits a source-stripped, shuffled
 *      sheet; a human labels it; `score` unblinds. No LLM judge (Claude-judging-
 *      Claude / model-preference bias).
 *   3. PARALLEL FROZEN-DIFF is an UPPER BOUND on external marginal value (in prod,
 *      self-review would fix bugs first and change what the auditor sees). We do NOT
 *      model the sequential pipeline; we caveat it.
 *
 * FAIRNESS to A/B/C: runs the SAME 5 generation passes the arms run
 * (structure/wiring/backend/frontend/sustainability, from PASS_PROMPTS) with the
 * SAME per-pass system prompt + user-prompt shape as audit-shadow.mjs::runStage,
 * differing only in the model (Sonnet via the author-model backend) and the absence
 * of any downstream GPT-round / Gemini gate. Known asymmetries (caveated, not
 * corrected — smallest honest version): (a) input is the commit diff with `-W`
 * whole-function context, not the arms' full audit-context assembly; (b) no
 * extended-thinking effort parity with the arms' PASS_REASONING tiers.
 *
 * Outputs live under .audit-loop/solo-control/ (gitignored — category-A derived
 * artifact: a function of DB + git + an LLM call, not committed source).
 *
 * Usage:
 *   node scripts/solo-control-audit.mjs run   [--model <id>] [--label <S-x>] [--commits <sha,sha> | --corpus <path>] [--max-chars N] [--repeats N] [--sdk] [--resume]
 *                                             [--reasoning-effort <tier>] [--budget-usd N]
 *     --label is REQUIRED for any non-anthropic recipient (exp-5); optional for anthropic (auto-derived, unchanged).
 *     --corpus <path>: exp-5 pre-registered corpus JSON, filtered to entries eligible for the resolved recipient.
 *     --reasoning-effort: validated per recipient (anthropic low|medium|high|xhigh|max; deepseek low|high|max) — see REASONING_TIERS.
 *     --budget-usd: experiment-wide ceiling read from the shared call ledger before every cell (default 350).
 *   node scripts/solo-control-audit.mjs apparatus --commits <sha,sha> | --corpus <path> [--max-chars N] [--gpt-model <id>] [--gate-model <id>]
 *                                             [--gate-reasoning-effort <tier>] [--gate-only] [--resume] [--budget-usd N]
 *     --gpt-model defaults to the CONCRETE gpt-5.6-terra pin (never latest-gpt — the live catalog would silently upgrade it).
 *   node scripts/solo-control-audit.mjs score [--decide]   (--decide: exp-5 decision over the call ledger; drops partial commits cohort-wide)
 *   node scripts/solo-control-audit.mjs apparatus-bc --commits <sha,sha> [--max-chars N] [--force]
 *   node scripts/solo-control-audit.mjs merge [--severity high[,medium,low]] [--commits <sha,sha>]
 *                                             [--kd-candidates] [--medium-sample N] [--seed N] [--allow-apparatus-gaps]
 *   node scripts/solo-control-audit.mjs score
 *   node scripts/solo-control-audit.mjs judge-gpt [--csv <path>] [--out <name>] [--model <id>] [--batch-size N] [--max-diff-chars N]
 *   node scripts/solo-control-audit.mjs --selfcheck-relocation
 *
 * Multi-model: run `run` once per author model (e.g. --model claude-sonnet-5, then
 * --model claude-fable-5). Each writes S-findings-<label>.json (arm S-sonnet /
 * S-fable). `merge` unions ALL of them + the apparatus (A) into one blind sheet;
 * `score` reports each solo arm vs the apparatus AND against each other (the cost-
 * frontier three-way: clean Sonnet vs the apparatus vs clean Fable).
 *
 * Severity tiers (merge, all additive/opt-in beyond the HIGH default — converged
 * design from /brainstorm --with-gemini, 2026-07-06; HIGH-only alone was found
 * structurally biased by both external models):
 *   --severity high        (default) the auto-include tier — every cluster counted
 *                           directly via scoreArms.
 *   --kd-candidates         ADDS any-severity findings whose (commit,file) plausibly
 *                           match a curated docs/experiments/.../known-defects.json
 *                           rubric — recall-biased (path overlap only), protects the
 *                           one metric with real ground truth from a severity cutoff.
 *   --medium-sample <N>     ADDS a stratified, capped, seeded sample of N MEDIUM-only
 *                           clusters (commit x multi-arm strata) — Horvitz-Thompson-
 *                           weighted with a bootstrap 95% CI in `score`, not counted
 *                           directly (it's a sample, not the full population).
 *
 * @module scripts/solo-control-audit
 */

import './lib/load-env.mjs'; // load repo-local .env (CLAUDE_BACKEND, AUDIT_DB_URL, keys)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import { createAnthropicClient } from './lib/anthropic-client.mjs';
import { resolveModel } from './lib/model-resolver.mjs';
import { PASS_PROMPTS } from './lib/prompt-seeds.mjs';
import { ShadowPassSchema, seededShuffle, SHADOW_PASSES } from './lib/audit-shadow.mjs';
import { assertEgressSafe } from './lib/sensitive-egress-gate.mjs';
import { resolveShadowArmsWithToggle } from './lib/arm-eval/toggle.mjs';
import { classifyPath } from './lib/sensitive-paths.mjs';
import { redactSecrets } from './lib/secret-patterns.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { log, argOption, hasFlag } from './lib/cli-io.mjs';
import { dupHash } from './lib/solo-control/cluster-propose.mjs';
import { classifyRecipient } from './lib/solo-control/recipient.mjs';
import { zodToOpenAiJsonSchema } from './lib/oss-structured-output.mjs';
import { loadRecipientPolicy, resolveAndAuthorize } from './lib/solo-control/policy.mjs';
import { loadCorpus, entriesEligibleForRecipient } from './lib/solo-control/corpus.mjs';
import { computeCallId, appendLedgerRow } from './lib/solo-control/ledger.mjs';
import { canonicaliseRemoteUrl } from './lib/repo-identity.mjs';
import { costFromUsage, PRICING_VERSION } from './lib/model-pricing.mjs';
import { normalizeGeminiUsage } from './lib/gemini-usage.mjs';
import { readLedger, aggregateBudgetSpent, aggregateCostForArm } from './lib/solo-control/ledger.mjs';
import { commitsCompleteForAllArms } from './lib/solo-control/completion.mjs';
import { resolveDeepseekCreds } from './lib/model-resolver.mjs';

// The generation passes an arm runs — IMPORTED from audit-shadow.mjs, never
// re-derived. The previous line here was `PASS_PROMPTS keys minus quickfix`,
// written when quickfix was the only mechanical wave; `duplication` and
// `adjacency` were later added to PASS_PROMPTS as MECHANICAL waves (regex /
// index lookups, not model calls) and this file kept sending them to every
// model as paid LLM passes: 7 calls per chunk against a baseline of 5 — 40%
// over-spend AND a fairness break against the very apparatus the control
// exists to mirror. Found 2026-09-21 by a pre-spend expectedCells check
// reading 7 where the plan said 5. AGENTS.md names this trap ("a new
// mechanical wave must be declared in MECHANICAL_WAVES, or PASS_PROMPTS
// silently enrols it in the paid comparison"); the fix is one oracle.
const PASSES = SHADOW_PASSES;

// Candidate local repo roots a ledger commit could live in. Always the current
// repo (cwd), plus any extra roots from SOLO_CONTROL_REPO_ROOTS (comma-separated
// absolute paths in your local .env) so a single source-repo catch-up can also
// sweep sibling repos' shadow commits (wine-cellar, ai-organiser). NO hardcoded
// machine paths — this is a public repo (personal paths live in .env).
const REPO_ROOTS = Object.freeze([
  process.cwd(),
  ...((process.env.SOLO_CONTROL_REPO_ROOTS || '').split(',').map((s) => s.trim()).filter(Boolean)),
].filter((v, i, a) => a.indexOf(v) === i));

const OUT_DIR = path.resolve('.audit-loop/solo-control');
const BLIND_CSV = path.join(OUT_DIR, 'blind-adjudication.csv');
const BLIND_MAP = path.join(OUT_DIR, '.blind-map.json'); // private — never open while labeling
const STAGE_TYPE = 'audit-code'; // cold-diff is a code concept; plan-audit's subject is a doc, not a git diff

// exp-5 (docs/plans/reviewer-cost-value-experiment.md) — the ONE recipient-policy
// file every entry path (--corpus, --commits, discoverCommits) consults, and the
// shared call ledger every provider call appends to via recordCall().
// The env override exists ONLY so a test can point a real subprocess at an
// isolated fixture instead of mutating the committed file on disk — mutating a
// shared, committed file as a test fixture races every OTHER test file reading
// it concurrently (Node's test runner parallelises across files by default;
// this raced tests/solo-control-dispatch.test.mjs the first time it shipped).
const RECIPIENT_POLICY_PATH = process.env.SOLO_CONTROL_RECIPIENT_POLICY_PATH
  ? path.resolve(process.env.SOLO_CONTROL_RECIPIENT_POLICY_PATH)
  : path.resolve('docs/experiments/audit-effectiveness/recipient-policy.json');
const CALL_LEDGER_PATH = path.join(OUT_DIR, 'call-ledger.jsonl');

/** Per-solo-arm findings file. One per author model so Sonnet + Fable can coexist
 * as SEPARATE solo arms (S-sonnet, S-fable) compared against A/B/C — the cost-
 * frontier three-way. */
const sFindingsPath = (label) => path.join(OUT_DIR, `S-findings-${label}.json`);
const listSFindings = () => (fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).filter((f) => /^S-findings-.+\.json$/.test(f)) : []);

/** Short, stable arm label for a resolved model id (used ONLY in the private map,
 * never in the blind CSV — so it can name the model without breaking blindness). */
function armLabelFor(model, override) {
  if (override) return override;
  if (/fable/i.test(model)) return 'S-fable';
  if (/sonnet/i.test(model)) return 'S-sonnet';
  if (/opus/i.test(model)) return 'S-opus';
  if (/haiku/i.test(model)) return 'S-haiku';
  return 'S';
}
const EXTERNAL_ARMS = Object.freeze(['A', 'B', 'C']);

// ── small utils ──────────────────────────────────────────────────────────────

function git(root, args) {
  // Capture (not inherit) stderr so a benign `cat-file -e` miss doesn't leak
  // git's "fatal: not a valid object" to our stderr; the throw still carries it.
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function tryGit(root, args) {
  try { return git(root, args); } catch { return null; }
}

/** Canonical `repoIdentity` (e.g. "github.com/x/wine") for a repo root, in the
 * exact form recipient-policy.json keys on. `null` for no/unresolvable remote
 * — assertRecipientAllowed then refuses (absence means refuse), never a crash. */
function repoIdentityFor(root) {
  return canonicaliseRemoteUrl(tryGit(root, ['config', '--get', 'remote.origin.url'])?.trim() || null);
}

/**
 * Append one row to the shared exp-5 call ledger (docs/plans/reviewer-cost-
 * value-experiment.md §2) — every provider call this file makes for exp-5
 * arms goes through this ONE helper so a caller can never forget a row.
 * Derives costUsd from `usage` + `resolvedModel` via costFromUsage — never
 * hand-computed, so an unpriced model stays null-honest rather than reading
 * as free. `sharedBy` marks a row credited to more than one arm (the
 * apparatus's shared 5-pass compute behind both A and A+).
 */
/**
 * The exp-5 budget ceiling (plan §8: "$350 API, enforced from the call
 * ledger's running Σ costUsd at preflight of each cell"). Reads the SHARED
 * ledger — every arm's spend, each callId once — so the cap is experiment-wide,
 * not per-invocation. Returns the spend when the ceiling is breached, else
 * null. An unpriced row cannot be summed, so `complete:false` is reported
 * alongside: the floor is then a floor, and the caller logs that.
 */
function budgetBreached(budgetUsd) {
  const { spentUsd, complete } = aggregateBudgetSpent(readLedger(CALL_LEDGER_PATH));
  return spentUsd >= budgetUsd ? { spentUsd, complete } : null;
}

function recordCall({ arm, sharedBy = null, commit, purpose, pass, chunkIndex, repeatIndex, resolvedModel, recipient, usage, state }) {
  const callId = computeCallId({ commit, purpose, pass, chunkIndex, repeatIndex, resolvedModel });
  const priced = usage ? costFromUsage(usage, resolvedModel) : null;
  return appendLedgerRow(CALL_LEDGER_PATH, {
    callId, arm, sharedBy, commit, repeat: repeatIndex, chunk: chunkIndex, pass, purpose,
    resolvedModel, recipient,
    usage: usage ? { input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0, output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0 } : null,
    costUsd: priced?.priced && !priced.unmeterable ? priced.totalUsd : null,
    pricingVersion: priced?.priced && !priced.unmeterable ? PRICING_VERSION : null,
    state,
  });
}
// dupHash (stable dedup/cluster hint — category|file|detail, consistent
// across S and DB findings so `merge` can pre-group VERBATIM duplicates; NOT
// semantic dedup) now imported from lib/solo-control/cluster-propose.mjs —
// this file's copy was byte-identical (flagged by `arch:duplicates`).
function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── target-commit discovery ──────────────────────────────────────────────────

/**
 * The audit-code units that already have a B/C shadow assignment — the paired
 * set the control must cover for an apples-to-apples comparison.
 *
 * `commit_sha` is HEAD at audit-capture time — the PARENT of a dirty-tree audit,
 * not the diff the arms actually read (see AGENTS.md's Postgres-Parity-Store
 * section). `audited_sha`/`audited_tree` (added 20260719120000) are the real
 * target identity. A row needs BOTH to be a usable audit unit, but a `WHERE ...
 * IS NOT NULL` filter and an in-process count of what it excluded are mutually
 * exclusive from one query (caught by the Gemini gate on this plan) — so this
 * relaxes to `OR`, dedups by `ar.id` (never by the identity columns, which a
 * partial-null row doesn't have yet), and partitions in JS.
 *
 * @returns {Promise<{resolved: {commitSha:string, auditedSha:string, auditedTree:string}[], unresolvedIncompleteIdentityCount: number}>}
 */
/**
 * Partition raw `{commit_sha, audited_sha, audited_tree}` rows into usable
 * audit units vs. incomplete-identity rows, and dedup units by the COMPOSITE
 * `(audited_sha, audited_tree)` pair — never `audited_tree` alone, which would
 * collapse two genuinely different diffs that happen to land on the same
 * resulting tree from different starting HEADs (e.g. one run changing file
 * `f`, another changing `g`, both ending at tree `T`). Pure — no DB, no git —
 * so it is unit-testable without either.
 *
 * @param {{commit_sha:string, audited_sha:string|null, audited_tree:string|null}[]} rows
 * @returns {{resolved: {commitSha:string, auditedSha:string, auditedTree:string}[], unresolvedIncompleteIdentityCount: number}}
 */
function partitionDiscoveredRows(rows) {
  let unresolvedIncompleteIdentityCount = 0;
  const seen = new Set();
  const resolved = [];
  for (const row of rows) {
    if (!row.audited_sha || !row.audited_tree) { unresolvedIncompleteIdentityCount++; continue; }
    const key = `${row.audited_sha}:${row.audited_tree}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ commitSha: row.commit_sha, auditedSha: row.audited_sha, auditedTree: row.audited_tree });
  }
  return { resolved, unresolvedIncompleteIdentityCount };
}

async function discoverCommits() {
  const { query } = await import('./lib/db/query.mjs');
  const r = await query(
    `SELECT DISTINCT ON (ar.id) ar.id, ar.commit_sha, ar.audited_sha, ar.audited_tree
       FROM audit_findings f JOIN audit_runs ar ON ar.id = f.run_id
      WHERE f.arm IN ('B','C') AND ar.stage_type = $1
        AND (ar.audited_sha IS NOT NULL OR ar.audited_tree IS NOT NULL)
      ORDER BY ar.id`,
    [STAGE_TYPE],
  );
  return partitionDiscoveredRows(r.rows);
}

/** Find which local repo root contains `sha` (as a real commit). */
function locateCommit(sha) {
  for (const root of REPO_ROOTS) {
    if (!fs.existsSync(root)) continue;
    if (tryGit(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null) return root;
  }
  return null;
}

/** True when `tree` (a git tree object id) also resolves as a real tree object
 * in `root`'s object database — false for a tree captured on another machine/
 * clone or since garbage-collected.
 *
 * `audited_tree` has no durable retention mechanism (no ref pins it, since it
 * was written via a throwaway index — see `gitWorktreeTree`, `scripts/lib/
 * vcs.mjs`), so `git gc` could in principle prune it as an unreachable dangling
 * object before a solo-control replay reads it. Accepted risk, not eliminated:
 * this function is exactly the honest degrade for that case (a missing tree
 * becomes `unresolved-object-missing`, never a crash and never a silently wrong
 * diff) rather than a guarantee the object survives forever. */
function treeExists(root, tree) {
  return tryGit(root, ['cat-file', '-e', `${tree}^{tree}`]) !== null;
}

/** Shared tail of `extractDiff`/`extractAuditedDiff`: classify files, drop
 * sensitive/generated-noise ones, redact, egress-check. `nameListOut` is the
 * raw `\n`-separated file list; `rawDiffForFiles(cleanFiles)` produces the raw
 * diff text for exactly those files (deferred so a sensitive-only diff never
 * runs the full `git diff`/`git show` invocation at all). */
function finalizeDiff(nameListOut, rawDiffForFiles, label) {
  const allFiles = nameListOut.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  const clean = [];
  const skippedSensitive = [];
  for (const f of allFiles) {
    // Drop credentials/keys/.env AND generated noise (lockfiles/min.js/maps) —
    // the same classifier the audit egress path uses.
    const cls = classifyPath(f);
    if (cls === null) clean.push(f);
    else skippedSensitive.push(`${f} (${cls})`);
  }
  if (clean.length === 0) return { diff: '', files: [], skippedSensitive };
  let diff = rawDiffForFiles(clean);
  diff = redactSecrets(diff).text; // {text, redacted} — take the redacted string
  assertEgressSafe(diff, { label });
  return { diff, files: clean, skippedSensitive };
}

/**
 * Extract the redacted, sensitive-file-filtered diff for a commit. Returns
 * { diff, files, skippedSensitive } or throws on an egress-gate refusal (a secret
 * in the diff — surface loudly, never send). `-U8` local context (NOT `-W` whole-
 * function, which inflates 2× on large commits without matching what the arms
 * audited — they map-reduce large diffs, they don't read whole function bodies).
 * NO truncation here: large diffs are CHUNKED at audit time (chunkDiff) so S gets
 * full coverage, mirroring the arms' map-reduce rather than seeing only a slice.
 *
 * For a REAL historical commit (`cmdApparatus`/`cmdApparatusBC`/`cmdJudgeGpt`/
 * `cmdPassRetro`'s manual `--commits`) — never called from the `discoverCommits`
 * auto-discovery path, which needs `extractAuditedDiff` below instead (a bare
 * `git show <sha>` is wrong when `sha` is HEAD at a dirty-tree audit's capture
 * time, not the commit containing the audited change).
 */
function extractDiff(root, sha) {
  const nameOut = git(root, ['show', '--pretty=format:', '--name-only', sha]);
  return finalizeDiff(nameOut, (files) => git(root, ['show', sha, '-U8', '--', ...files]), `solo-control:${sha.slice(0, 8)}`);
}

/**
 * Reconstruct the diff a `discoverCommits`-discovered audit unit actually
 * audited, from `{auditedSha, auditedTree}` (see `discoverCommits`'s docstring
 * for why `commit_sha`/a bare `git show` is wrong here). Self-evidencing
 * dirty/clean branch — no persisted flag needed:
 *
 *   - `auditedTree === git rev-parse <auditedSha>^{tree}` (worktree matched the
 *     committed tree) → the dirty-aware base rule put the diff base at
 *     `auditedSha~1`, i.e. the audited diff IS `git show <auditedSha>`.
 *   - Otherwise (worktree was dirty at capture) → the base WAS `auditedSha`, so
 *     the audited diff is `git diff <auditedSha> <auditedTree>`.
 *
 * Known, accepted limitation (see the plan's Risk register): an explicit
 * `--base` run (e.g. `/cycle`'s clustered `--cluster` resume) whose tree is
 * clean relative to its own HEAD is indistinguishable from the ordinary
 * clean-tree case and silently takes the `git show` branch, which is wrong for
 * that run — no column records the real base, so this is not detectable here.
 *
 * @returns {{diff:string, files:string[], skippedSensitive:string[]}}
 */
function extractAuditedDiff(root, { auditedSha, auditedTree }) {
  const cleanTreeSha = git(root, ['rev-parse', `${auditedSha}^{tree}`]).trim();
  const label = `solo-control:${auditedSha.slice(0, 8)}`;
  if (cleanTreeSha === auditedTree) {
    const nameOut = git(root, ['show', '--pretty=format:', '--name-only', auditedSha]);
    return finalizeDiff(nameOut, (files) => git(root, ['show', auditedSha, '-U8', '--', ...files]), label);
  }
  const nameOut = git(root, ['diff', '--name-only', auditedSha, auditedTree]);
  return finalizeDiff(nameOut, (files) => git(root, ['diff', auditedSha, auditedTree, '-U8', '--', ...files]), label);
}

/** Split a diff into ≤maxChars blocks at file (`diff --git`) boundaries so each
 * audit chunk is coherent; a single file larger than maxChars is hard-split.
 *
 * A hard-split slice after the first loses the `diff --git a/x b/x` header —
 * the audit pass sees ONLY a mid-file hunk fragment with no filename and no
 * indication it's a partial view. An arm reading that fragment in isolation
 * (e.g. a run of `-` lines whose matching `+` lines landed in the NEXT chunk)
 * can misread it as a whole-file deletion — confirmed root cause of the
 * split-misread-as-deletion / phantom-missing-file false-positive family in
 * the 2026-07 solo-control run (docs/experiments/audit-effectiveness). Every
 * slice after the first is prefixed with a synthetic marker line naming the
 * file and stating this is a continuation, not a deletion. */
function chunkDiff(diff, maxChars) {
  if (diff.length <= maxChars) return [diff];
  const perFile = diff.split(/(?=^diff --git )/m).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (let part of perFile) {
    const headerMatch = part.match(/^diff --git a\/(.+?) b\/(.+?)\n/);
    const fileLabel = headerMatch ? headerMatch[2] : null;
    let sliceIndex = 0;
    while (part.length > maxChars) {
      const slice = part.slice(0, maxChars);
      part = part.slice(maxChars);
      sliceIndex += 1;
      chunks.push(sliceIndex > 1 && fileLabel ? continuationMarker(fileLabel, sliceIndex) + slice : slice);
    }
    if (sliceIndex > 0 && fileLabel && part) part = continuationMarker(fileLabel, sliceIndex + 1) + part;
    if (cur.length + part.length > maxChars && cur) { chunks.push(cur); cur = ''; }
    cur += part;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Synthetic marker prepended to a hard-split diff continuation — see chunkDiff. */
function continuationMarker(fileLabel, partNumber) {
  return `# [diff continuation: ${fileLabel}, part ${partNumber} — earlier/later hunks of this SAME file `
    + `are in a different audit chunk; this fragment alone is NOT evidence the file was deleted or is missing]\n`;
}

// ── Sonnet cold-diff pass ────────────────────────────────────────────────────

/** JSON-output contract — placed LAST in the USER turn (not the system prompt), so
 * `system` stays byte-identical to what the arms' passes receive (PASS_PROMPTS[pass])
 * for fairness. The agentic `claude -p` CLI defaults to conversational markdown, so
 * the directive must be forceful and final to force raw JSON (empirically Sonnet-5
 * emits a table otherwise). Validated against ShadowPassSchema — the exact schema the
 * arms' passes conform to. */
const JSON_CONTRACT = [
  'CRITICAL OUTPUT REQUIREMENT: Respond with a SINGLE raw JSON object and NOTHING else —',
  'no markdown, no tables, no code fences, no prose before or after. Your entire response',
  'must be valid JSON parseable by JSON.parse. Begin your response with { immediately.',
  'Schema: {"findings":[{"id":string,"severity":"HIGH"|"MEDIUM"|"LOW","category":string,',
  '"section":"file or code section","detail":"what is wrong and why","risk":"what breaks if unfixed",',
  '"recommendation":"a sustainable fix, not a band-aid","is_quick_fix":boolean,"is_mechanical":boolean,',
  '"principle":"which engineering principle","classification":{"sonarType":"BUG"|"VULNERABILITY"|"CODE_SMELL"|"SECURITY_HOTSPOT",',
  '"effort":"TRIVIAL"|"EASY"|"MEDIUM"|"MAJOR"|"CRITICAL","sourceKind":"MODEL","sourceName":"solo-control"}}],"summary":string}',
  'Return {"findings":[],"summary":"..."} if the diff is clean for this concern. Max 50 findings.',
  // Field budgets MATCH the A/B/C arms\' schema (they conform natively via enforced structured',
  // output). State each point COMPLETELY but CONCISELY within budget — do not pad, and do not',
  // run past it and get cut off: detail ≤600 chars, risk ≤500, recommendation ≤600, category ≤80,',
  // section ≤120, principle ≤150, summary ≤1000. Put the WHAT + WHERE first so the point is whole.',
  'Field limits (write a complete point within each — the arms use the same budget): detail ≤600 chars, '
    + 'risk ≤500, recommendation ≤600, category ≤80, section ≤120, principle ≤150, summary ≤1000. '
    + 'Lead each field with the essential point (what is wrong + where) so it is self-contained.',
].join('\n');

/** Clamp verbose free-JSON string fields to the ShadowPassSchema/ProducerFinding
 * caps so a valid-but-too-long finding is KEPT (truncated), not dropped. The arms
 * conform natively (enforced structured output); `claude -p` writes free JSON and
 * routinely exceeds detail(600)/summary(1000). Same principle as gemini-review's
 * truncateToSchema — a real finding shouldn't be discarded over prose length. */
const FIELD_CAPS = { id: 10, category: 80, section: 120, detail: 600, risk: 500, recommendation: 600, principle: 150 };
/** Truncate at a WORD boundary within the cap (not mid-word) and mark it with an
 * ellipsis, so the rare overflow reads as clearly-cut, never severed mid-word. The
 * PROMPT already tells the model to write within budget (matching the arms), so this
 * fires rarely — it's a safety net, not the routine path. */
function clampField(s, cap) {
  if (typeof s !== 'string' || s.length <= cap) return s;
  const head = s.slice(0, cap - 1);
  const lastSpace = head.lastIndexOf(' ');
  return (lastSpace > cap * 0.6 ? head.slice(0, lastSpace) : head).replace(/[\s.,;:]+$/, '') + '…';
}
function clampToSchema(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (typeof parsed.summary === 'string') parsed.summary = clampField(parsed.summary, 1000);
  if (Array.isArray(parsed.findings)) {
    for (const f of parsed.findings) {
      if (!f || typeof f !== 'object') continue;
      for (const [k, cap] of Object.entries(FIELD_CAPS)) f[k] = clampField(f[k], cap);
      if (f.classification) f.classification.sourceName = clampField(f.classification.sourceName, 64);
    }
  }
  return parsed;
}

function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try { return JSON.parse(t); } catch { return null; }
}

/**
 * The ONE cold-pass prompt builder — exp-5's fairness axis for Arms B/C/D
 * (anthropic, via runPass) vs Arm E (deepseek, via runDeepseekPass) rests on
 * these two functions sending IDENTICAL text for the same (passName, diff),
 * so this is factored out rather than duplicated: a structural guarantee, not
 * a copy-paste hope. Mirrors audit-shadow.mjs::runStage's per-pass prompt
 * shape (system = PASS_PROMPTS[pass], user = task + code + JSON contract).
 * @returns {{system: string, user: string}}
 */
function buildColdPassPrompt(passName, diff) {
  const system = PASS_PROMPTS[passName] || `Audit the code for ${passName} issues.`;
  const user = [
    `## Task\nAudit the code CHANGE below for the "${passName}" concern.`,
    `## Diff\n${diff}`,
    JSON_CONTRACT,
  ].join('\n\n');
  return { system, user };
}
const JSON_RETRY_SUFFIX = '\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.';

/**
 * Reasoning-effort tiers per recipient, verified against each vendor's docs
 * 2026-09-21. The tables are deliberately NOT unified: DeepSeek silently
 * aliases `xhigh` → `high` and `medium` → `high`, so passing an Anthropic tier
 * through would record one effort in the manifest and run another. A tier
 * not in the recipient's table is refused at the CLI, never remapped.
 *
 * - anthropic: `output_config.effort`; `high` is the API default (identical to
 *   omitting it); `max` is documented to overthink structured output, so
 *   `xhigh` is the above-default tier exp-5 uses.
 * - deepseek: `thinking.reasoning_effort`; thinking is ON by default at `high`;
 *   `max` is the only above-default tier. Thinking mode IGNORES `temperature`.
 *
 * `maxTokens` is the vendor-documented ceiling that thinking shares with the
 * answer — raising effort without raising it truncates the chain of thought
 * and reads as a conformance miss, an instrument artifact the experiment
 * would then mis-score as "the model found less".
 */
const REASONING_TIERS = Object.freeze({
  anthropic: Object.freeze({ low: 8000, medium: 8000, high: 8000, xhigh: 64000, max: 64000 }),
  deepseek: Object.freeze({ low: 65536, high: 65536, max: 131072 }),
});
function assertReasoningTier(recipient, tier) {
  if (tier == null) return null;
  const table = REASONING_TIERS[recipient];
  if (!table) throw new Error(`--reasoning-effort is not supported for recipient "${recipient}"`);
  if (!Object.hasOwn(table, tier)) {
    throw new Error(`--reasoning-effort "${tier}" is not a ${recipient} tier (valid: ${Object.keys(table).join('|')}) — refusing rather than letting the provider silently remap it`);
  }
  return tier;
}

/** Run one audit pass with the author model over the cold diff, minus the
 * reservation/cost machinery (offline, uncapped — this is a bounded 20-call
 * batch, not the live spend path). See buildColdPassPrompt for the shared
 * prompt shape. `reasoningEffort` null ⇒ omit `output_config` entirely (the
 * API default, `high`) so the pre-exp-5 solo-control:catchup request body
 * stays byte-identical. */
async function runPass(client, model, passName, diff, { temperature, reasoningEffort = null } = {}) {
  const { system, user } = buildColdPassPrompt(passName, diff);
  const maxTokens = reasoningEffort ? REASONING_TIERS.anthropic[reasoningEffort] : 8000;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let resp;
    try {
      const params = {
        model, max_tokens: maxTokens, system,
        messages: [{ role: 'user', content: attempt === 1 ? user : user + JSON_RETRY_SUFFIX }],
      };
      // temperature only meaningful on the SDK backend (cli `claude -p` ignores it);
      // pinned non-zero for --repeats so the N samples are genuinely independent.
      if (temperature != null) params.temperature = temperature;
      if (reasoningEffort) params.output_config = { effort: reasoningEffort };
      resp = await client.messages.create(params, { timeoutMs: 300000 });
    } catch (err) {
      // A provider/backend failure on ONE pass must NOT crash the whole run —
      // degrade to a conformance miss (0 findings) and move on.
      lastErr = (err?.message || String(err)).slice(0, 160);
      continue;
    }
    const text = Array.isArray(resp.content) ? resp.content.map((c) => c.text || '').join('') : '';
    const parsed = clampToSchema(parseJsonLoose(text));
    const check = ShadowPassSchema.safeParse(parsed);
    if (check.success) {
      return { findings: check.data.findings, usage: resp.usage || null, rawText: text };
    }
    lastErr = check.error?.issues?.map((i) => i.message).join('; ') || 'unparseable';
  }
  log(`      ! pass ${passName} produced no conformant JSON (${lastErr}) — recorded 0 findings`);
  return { findings: [], usage: null, conformanceMiss: true, rawText: null };
}

/**
 * DeepSeek's exp-5 Arm-E counterpart to runPass — deliberately mirrors it
 * (buildColdPassPrompt, loose JSON parse, 2-attempt retry, no schema-forcing)
 * rather than the OSS-structured-output shape runOssPass/runGeminiPass use,
 * so a comparison against cold Sonnet/Opus (Arms B/C/D) isolates the MODEL as
 * the only variable — neither arm gets provider-enforced structured output as
 * an assist the other lacks. Captures `system_fingerprint` (DeepSeek-only;
 * absent from Anthropic's response) for the alias-drift pin (plan §2/§8):
 * `deepseek-flash` is an unversioned alias and could silently start serving a
 * different snapshot mid-run.
 *
 * No `temperature` parameter, deliberately: `deepseek-flash` runs in thinking
 * mode (on by default), and DeepSeek documents that thinking mode ignores
 * `temperature` without error. Sending it would put a value in the manifest
 * the provider never honoured. The ×3 union's sample variance comes from the
 * model's own stochastic decoding, and cmdRun's existing samplingDegenerate
 * guard is what verifies the repeats actually differed.
 * @param {import('openai').OpenAI} client - createOpenAIClient({oss:{baseURL,apiKey}}) pointed at DeepSeek
 */
async function runDeepseekPass(client, model, passName, diff, { reasoningEffort = null } = {}) {
  const { system, user } = buildColdPassPrompt(passName, diff);
  // Thinking is on by default at `high`; a null tier leaves the provider default
  // in place but still sets the documented 64K ceiling (max_tokens spans
  // reasoning + answer — an 8K cap would truncate the chain of thought).
  const maxTokens = REASONING_TIERS.deepseek[reasoningEffort ?? 'high'];
  let lastErr = null;
  let lastFingerprint = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let resp;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: attempt === 1 ? user : user + JSON_RETRY_SUFFIX },
    ];
    assertEgressSafe(messages, { label: `deepseek:${passName}` });
    try {
      const params = { model, max_tokens: maxTokens, messages };
      if (reasoningEffort) params.thinking = { type: 'enabled', reasoning_effort: reasoningEffort };
      resp = await client.chat.completions.create(params);
    } catch (err) {
      lastErr = (err?.error?.message || err?.message || String(err)).slice(0, 160);
      continue;
    }
    lastFingerprint = resp.system_fingerprint || null;
    const text = resp.choices?.[0]?.message?.content || '';
    const parsed = clampToSchema(parseJsonLoose(text));
    const check = ShadowPassSchema.safeParse(parsed);
    if (check.success) {
      const u = resp.usage || null;
      const usage = u ? { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 } : null;
      return { findings: check.data.findings, usage, rawText: text, systemFingerprint: lastFingerprint };
    }
    lastErr = check.error?.issues?.map((i) => i.message).join('; ') || 'unparseable';
  }
  log(`      ! pass ${passName} produced no conformant JSON (${lastErr}) — recorded 0 findings`);
  return { findings: [], usage: null, conformanceMiss: true, rawText: null, systemFingerprint: lastFingerprint };
}

// ── subcommands ──────────────────────────────────────────────────────────────

/** Pure resume/incremental decision (tests/solo-control-dispatch.test.mjs):
 * which requested units still need a run, given what perCommit already
 * records as 'ran'. Resume key is `unit.resumeKey`, matched against a
 * perCommit entry's `unitKey` (falling back to the legacy `.sha` field for
 * entries written before this composite key existed, where `sha` alone WAS
 * the resume key). --force ignores prior coverage entirely; --resume is
 * documented sugar for the (already-incremental) default and additionally
 * refuses to combine with --force (starting over and resuming are opposites). */
function planIncrementalRun({ units, prior, force, resume }) {
  if (force && resume) throw new Error('--force and --resume are mutually exclusive (start over vs continue from checkpoint)');
  const covered = new Set(force || !prior ? [] : prior.perCommit.filter((c) => c.state === 'ran').map((c) => c.unitKey || c.sha));
  return { commits: units.filter((u) => !covered.has(u.resumeKey)), covered };
}

async function cmdRun() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const modelArg = argOption('model') || 'latest-sonnet';
  // Refresh the live catalog so a sentinel picks up a newly-shipped author model
  // (e.g. Sonnet 5) automatically — same as the heavy audit entry points. Best-
  // effort: offline → silent fallback to the static pool.
  try { const mr = await import('./lib/model-resolver.mjs'); await mr.refreshModelCatalog?.(); } catch { /* offline */ }
  const model = resolveModel(modelArg);
  const maxChars = Number.parseInt(argOption('max-chars', '45000'), 10); // per-chunk cap (~11k tok); larger chunks slow claude -p past its timeout
  const commitsArg = argOption('commits');
  const corpusArg = argOption('corpus');
  const force = hasFlag('force');
  const resume = hasFlag('resume');
  // xN arm (the confound-breaker). N sequential samples per pass×chunk. A non-zero
  // temperature is MANDATORY (Gemini-R2-HIGH): at temp 0 the N samples are identical
  // and collapse to x1. temperature only works on the SDK backend (cli claude -p
  // can't set it), so --repeats>1 forces the sdk backend.
  const repeats = Math.max(1, Number.parseInt(argOption('repeats', '1'), 10) || 1);
  const temperature = repeats > 1 ? Number.parseFloat(argOption('temperature', '1.0')) : null;
  // Diff-size sanity cap: a mega-commit (repo-import / 2000-file initial release)
  // would grind for hours across dozens of chunks. Skip + RECORD (state
  // 'diff-too-large', listed in perCommit — never silently dropped) so scoring can
  // report the defect as unscored-by-refusal rather than missed.
  const maxDiffChars = Number.parseInt(argOption('max-diff-chars', '600000'), 10);
  const useSdk = hasFlag('sdk'); // force the fast SDK backend for x1 runs too (real API spend)
  const budgetUsd = Number.parseFloat(argOption('budget-usd', '350')); // plan §8 ceiling, experiment-wide

  // exp-5: preflight-load the recipient policy ALWAYS (Security Considerations
  // §2 — "missing policy ⇒ refuse", below every entry path, before any client is
  // constructed). Fatal for the whole run: a missing/malformed policy file is an
  // operator setup error, not a per-commit condition.
  let recipientPolicy;
  try { recipientPolicy = loadRecipientPolicy(RECIPIENT_POLICY_PATH); }
  catch (err) { log(`FATAL: recipient policy unavailable (${err.message})`); process.exit(2); }
  const recipient = classifyRecipient(model);

  // --reasoning-effort: validated against THIS recipient's tier table, so a
  // tier the provider would silently alias never lands in the manifest as
  // something it was not (see REASONING_TIERS). Null ⇒ provider default.
  let reasoningEffort;
  try { reasoningEffort = assertReasoningTier(recipient, argOption('reasoning-effort') || null); }
  catch (err) { log(`FATAL: ${err.message}`); process.exit(2); }
  // DeepSeek thinking mode ignores temperature (documented, no error) — the
  // manifest must say so rather than carry a pinned value the provider dropped.
  const effectiveTemperature = recipient === 'deepseek' ? null : temperature;
  if (recipient === 'deepseek' && repeats > 1) {
    log('  note: deepseek thinking mode ignores temperature — the x' + repeats + ' union relies on the model\'s own stochastic decoding; samplingDegenerate will report if the repeats did not vary.');
  }

  // --label: armLabelFor only knows how to derive a distinct label for the
  // Anthropic sub-families (sonnet/opus/haiku/fable) this file's original
  // solo-control experiment uses — every other recipient collapses to the
  // generic 'S' bucket, which is a silent cross-experiment collision, not a
  // cosmetic gap. So --label is required for every NON-anthropic recipient
  // (exp-5's DeepSeek arm and beyond); the pre-existing anthropic-only
  // `solo-control:catchup` npm script and its documented invocation are
  // unaffected (armLabelFor already gives them a safe, distinct label).
  const labelArg = argOption('label');
  if (recipient !== 'anthropic' && !labelArg) {
    log(`FATAL: --label is required for recipient "${recipient}" (armLabelFor has no safe auto-derivation outside the anthropic family — every unlabelled non-anthropic run would collide on the generic "S" bucket).`);
    process.exit(2);
  }

  // Normalize every entry path into ONE `units` shape so the rest of this
  // function doesn't branch per-item. Manual `--commits`/`--corpus` give bare
  // real-commit shas (unchanged legacy shape, `git show` is correct for them —
  // see `extractDiff`'s docstring). Auto-discovery gives
  // `{commitSha, auditedSha, auditedTree}` records needing the dirty/clean-
  // branching `extractAuditedDiff` below (the audited-tree identity fix — a
  // bare `git show <sha>` is wrong when the audit ran against a dirty tree).
  let units, unresolvedIncompleteIdentityCount = 0;
  if (corpusArg) {
    const corpus = loadCorpus(corpusArg, recipientPolicy);
    // entriesEligibleForRecipient returns corpus entry IDS, not shas — map
    // back through the entries themselves to the field this runner needs.
    const eligibleIds = new Set(entriesEligibleForRecipient(corpus, recipient));
    const eligibleEntries = corpus.entries.filter((e) => eligibleIds.has(e.id));
    units = eligibleEntries.map((e) => ({ mode: 'manual', resumeKey: e.sha, commitSha: e.sha, auditedSha: null, auditedTree: null }));
    if (commitsArg) log(`  (--corpus given — ignoring --commits; ${units.length}/${corpus.entries.length} corpus entries are eligible for recipient "${recipient}")`);
  } else if (commitsArg) {
    units = commitsArg.split(',').map((s) => s.trim()).filter(Boolean)
      .map((sha) => ({ mode: 'manual', resumeKey: sha, commitSha: sha, auditedSha: null, auditedTree: null }));
  } else {
    // SELF-GATE on the arm-eval/shadow toggle: the standing policy is "run the
    // solo control WHENEVER the shadow is on". So the audit skills fire
    // `solo-control:catchup` UNCONDITIONALLY (backgrounded) and this no-ops
    // when the toggle is off — the on/off decision lives in ONE place (the
    // toggle), not duplicated in each SKILL. An explicit --commits / --corpus /
    // --force is a manual override that bypasses the gate.
    if (!force) {
      const shadow = resolveShadowArmsWithToggle();
      if (!shadow.enabled) { log('arm-eval/shadow toggle is OFF — solo control no-op (use --force, --commits, or --corpus to run anyway).'); process.exit(0); }
    }
    const discovered = await discoverCommits();
    unresolvedIncompleteIdentityCount = discovered.unresolvedIncompleteIdentityCount;
    units = discovered.resolved.map((u) => ({ mode: 'discovered', resumeKey: `${u.auditedSha}:${u.auditedTree}`, ...u }));
  }
  if (units.length === 0) { log('No target commits found (no B/C audit-code shadow units yet, or no corpus entries eligible for this recipient).'); process.exit(0); }
  if (unresolvedIncompleteIdentityCount > 0) {
    log(`⚠ ${unresolvedIncompleteIdentityCount} B/C shadow row(s) have only one of audited_sha/audited_tree captured — excluded (unresolved-incomplete-identity), not audited.`);
  }

  // The -xN suffix disambiguates AUTO-DERIVED labels (S-sonnet vs S-sonnet-x3).
  // An explicit --label is the operator naming the arm — exp-5's registry says
  // `--label C --repeats 3` and scores arm "C", not "C-x3".
  const baseLabel = armLabelFor(model, labelArg);
  const label = (!labelArg && repeats > 1) ? `${baseLabel}-x${repeats}` : baseLabel;
  const dest = sFindingsPath(label);

  // INCREMENTAL accumulation (standing-policy use): merge onto any prior file for
  // this arm and skip commits already successfully audited, so repeated/scheduled
  // runs only cover NEW shadow commits and data grows monotonically. `--force`
  // re-audits everything; `--resume` is the same skip logic, named explicitly for
  // the "continuing an interrupted run" case (mutually exclusive with --force).
  const prior = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, 'utf8')) : null;
  let plan;
  try { plan = planIncrementalRun({ units, prior, force, resume }); }
  catch (err) { log(`FATAL: ${err.message}`); process.exit(2); }
  const { commits, covered } = plan;
  const requestedCommitShas = units.map((u) => u.commitSha);
  const out = prior && !force
    ? { ...prior, model, modelArg, generatedFor: [...new Set([...(prior.generatedFor || []), ...requestedCommitShas])] }
    : { armLabel: label, model, modelArg, stageType: STAGE_TYPE, generatedFor: requestedCommitShas, findings: [], perCommit: [] };
  out.armLabel = label;
  out.manifest = { ...(out.manifest || {}), resolvedModel: model, recipient, systemFingerprint: (out.manifest && out.manifest.systemFingerprint) || null };

  if (commits.length === 0) { log(`All ${units.length} commit(s) already covered for ${label} — nothing to do (use --force to re-audit).`); process.exit(0); }

  // ── recipient-specific client construction (AFTER the policy preflight
  // above, BEFORE any per-commit dispatch — no client for a refused recipient
  // is ever constructed) ─────────────────────────────────────────────────────
  // sdk backend is needed for temperature AND for output_config.effort (the cli
  // backend reads only {model,max_tokens,system,messages} and drops the rest
  // silently — AGENTS.md "Anthropic Backend Routing"); opt-in via --sdk for speed.
  const backend = (repeats > 1 || useSdk || reasoningEffort) ? 'sdk' : undefined;
  let anthropicClient = null, deepseekClient = null;
  if (recipient === 'anthropic') {
    try { anthropicClient = await createAnthropicClient(backend ? { backend } : {}); }
    catch (err) {
      log(`FATAL: cannot create ${backend || 'default'} client${backend === 'sdk' ? ' (repeats>1 / --reasoning-effort need ANTHROPIC_API_KEY for the SDK backend — cli claude -p cannot set temperature or effort)' : ''}: ${err.message}`);
      process.exit(2);
    }
  } else if (recipient === 'deepseek') {
    const { createOpenAIClient } = await import('./lib/openai-client.mjs');
    const creds = resolveDeepseekCreds();
    if (!creds.apiKey) { log('FATAL: recipient "deepseek" needs DEEPSEEK_API_KEY.'); process.exit(2); }
    deepseekClient = await createOpenAIClient({ oss: { baseURL: creds.baseUrl, apiKey: creds.apiKey } });
  } else {
    log(`FATAL: recipient "${recipient}" has no cold-dispatch adapter wired in cmdRun yet (only anthropic/deepseek today).`);
    process.exit(2);
  }
  log(`Solo control — arm=${label} · model=${model} (${modelArg}) · recipient=${recipient}, ${commits.length} new commit(s)${covered.size ? ` (${covered.size} already covered)` : ''}${repeats > 1 ? ` · repeats=${repeats} temp=${effectiveTemperature ?? 'n/a'}` : ''}${reasoningEffort ? ` · effort=${reasoningEffort}` : ''}${backend === 'sdk' ? ' · backend=sdk' : ''} · budget=$${budgetUsd}, stage=${STAGE_TYPE}`);

  // Provenance (§12.5): pin what actually ran so the experiment is reproducible + fair.
  out.provenance = {
    repeats, temperature: effectiveTemperature,
    temperatureNote: recipient === 'deepseek' && repeats > 1 ? 'deepseek thinking mode ignores temperature; variance is the model\'s own stochastic decoding (see samplingDegenerate)' : null,
    reasoningEffort: reasoningEffort ?? null,
    backend: recipient === 'anthropic' ? (backend || 'cli(default)') : recipient, maxChars, resolvedModel: model, budgetUsd,
  };
  let totalIn = 0, totalOut = 0, samplingVariedUnits = 0, samplingTotalUnits = 0;

  for (const unit of commits) {
    const sha = unit.commitSha; // display/label — the join key `cmdMerge`/`fetchExternalFindings` expect, unchanged
    const short = sha.slice(0, 8);
    const root = locateCommit(unit.auditedSha || sha);
    if (!root) { log(`  ${short}: NOT FOUND in any local repo root — skipped`); out.perCommit.push({ sha, unitKey: unit.resumeKey, state: 'not-found' }); continue; }
    if (unit.mode === 'discovered' && !treeExists(root, unit.auditedTree)) {
      log(`  ${short}: audited_tree ${unit.auditedTree.slice(0, 8)} not resolvable in ${path.basename(root)} — skipped (unresolved-object-missing)`);
      out.perCommit.push({ sha, unitKey: unit.resumeKey, state: 'unresolved-object-missing' });
      continue;
    }

    // exp-5 recipient-policy check — per commit, so a run spanning REPO_ROOTS
    // that resolve to different repos is authorized (or refused) individually,
    // never blanket-approved off the first commit's repo.
    const repoIdentity = repoIdentityFor(root);
    try { resolveAndAuthorize({ model, repoIdentity, policy: recipientPolicy }); }
    catch (err) { log(`  ${short}: POLICY REFUSED (${err.message}) — skipped, not sent`); out.perCommit.push({ sha, unitKey: unit.resumeKey, repo: path.basename(root), state: 'policy-refused', error: err.message }); continue; }

    let ext;
    try { ext = unit.mode === 'discovered' ? extractAuditedDiff(root, unit) : extractDiff(root, sha); }
    catch (err) {
      if (String(err?.message).includes('[egress-gate]')) { log(`  ${short}: EGRESS REFUSAL (${err.message}) — skipped, not sent`); out.perCommit.push({ sha, unitKey: unit.resumeKey, state: 'egress-refused' }); continue; }
      log(`  ${short}: diff extraction failed (${err.message}) — skipped`); out.perCommit.push({ sha, unitKey: unit.resumeKey, state: 'diff-error', error: err.message }); continue;
    }
    if (!ext.diff) { log(`  ${short}: no auditable (non-sensitive) files — skipped`); out.perCommit.push({ sha, unitKey: unit.resumeKey, state: 'no-clean-files', skippedSensitive: ext.skippedSensitive }); continue; }
    if (ext.diff.length > maxDiffChars) {
      log(`  ${short}: diff ${ext.diff.length} chars exceeds --max-diff-chars ${maxDiffChars} — RECORDED as diff-too-large (unscored-by-refusal, not missed)`);
      out.perCommit.push({ sha, unitKey: unit.resumeKey, repo: path.basename(root), state: 'diff-too-large', diffChars: ext.diff.length });
      continue;
    }
    const chunks = chunkDiff(ext.diff, maxChars);
    log(`  ${short}: ${path.basename(root)} · ${ext.files.length} file(s) · ${ext.diff.length} chars${chunks.length > 1 ? ` · ${chunks.length} chunks` : ''}${ext.skippedSensitive.length ? ` · ${ext.skippedSensitive.length} sensitive skipped` : ''}`);

    // 5 passes × N chunks, unioned + deduped by _dup so a finding re-raised across
    // chunks/passes counts once (light map-reduce — full coverage, no truncation bias).
    const seen = new Set();
    let commitFindings = 0;
    const commitConformance = {}; // passName -> {attempts, misses} — surfaced in perCommit
    // for post-hoc eval: a temperature-driven conformance miss degrades to 0
    // findings for that repeat (never crashes), but a skewed miss rate on one pass
    // should be visible in scoring, not silently absorbed as "the model found less".
    let fingerprintDrift = false;
    let budgetHit = null;
    cells: for (const passName of PASSES) {
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        // xN: N sequential samples per pass×chunk (never concurrent — Gemini-R1-MEDIUM,
        // avoids 429s). Union their findings; detect sampling degeneracy.
        const rawTexts = [];
        const findings = [];
        for (let rep = 0; rep < repeats; rep++) {
          // Budget ceiling at the preflight of EVERY cell (plan §8) — this cell is
          // recorded as provider-error, the commit as budget-exceeded (a partial,
          // so score drops it cohort-wide), and the run stops. Never spent past.
          budgetHit = budgetBreached(budgetUsd);
          if (budgetHit) {
            recordCall({ arm: label, commit: sha, purpose: 'pass', pass: passName, chunkIndex, repeatIndex: rep, resolvedModel: model, recipient, usage: null, state: 'provider-error' });
            break cells;
          }
          const r = recipient === 'anthropic'
            ? await runPass(anthropicClient, model, passName, chunk, { temperature: effectiveTemperature, reasoningEffort })
            : await runDeepseekPass(deepseekClient, model, passName, chunk, { reasoningEffort });
          if (r.usage) { totalIn += r.usage.input_tokens || 0; totalOut += r.usage.output_tokens || 0; }
          if (r.rawText != null) rawTexts.push(r.rawText);
          const cc = (commitConformance[passName] ||= { attempts: 0, misses: 0 });
          cc.attempts++;
          if (r.conformanceMiss) cc.misses++;

          // DeepSeek fingerprint pin (plan §2/§8): `deepseek-flash` is an
          // unversioned alias — the FIRST successful call this run seeds the
          // manifest's pin (doubling as the "one preflight call"); every
          // subsequent call is checked against it. A drift refuses just this
          // cell (provider-error, findings discarded), never crashes the run
          // or silently mixes two snapshots into one arm.
          let cellState = r.conformanceMiss ? 'conformance-miss' : 'ok';
          if (recipient === 'deepseek' && r.systemFingerprint) {
            if (!out.manifest.systemFingerprint) out.manifest.systemFingerprint = r.systemFingerprint;
            else if (r.systemFingerprint !== out.manifest.systemFingerprint) {
              log(`      ⚠ FINGERPRINT DRIFT on ${passName} chunk ${chunkIndex} rep ${rep}: manifest pinned "${out.manifest.systemFingerprint}", got "${r.systemFingerprint}" — refusing this cell, not mixing snapshots.`);
              cellState = 'provider-error';
              fingerprintDrift = true;
            }
          }
          recordCall({
            arm: label, commit: sha, purpose: 'pass', pass: passName, chunkIndex, repeatIndex: rep,
            resolvedModel: model, recipient, usage: r.usage, state: cellState,
          });
          if (cellState !== 'provider-error') findings.push(...r.findings);
        }
        if (repeats > 1) {
          samplingTotalUnits++;
          if (new Set(rawTexts).size > 1) samplingVariedUnits++; // outputs actually varied
        }
        for (const f of findings) {
          const file = f.section || (ext.files[0] || '');
          const h = dupHash(f.category, file, f.detail);
          if (seen.has(h)) continue;
          seen.add(h);
          out.findings.push({
            commit: sha, repo: path.basename(root), model, pass: passName,
            severity: f.severity, category: f.category, section: file,
            detail: f.detail, risk: f.risk, recommendation: f.recommendation,
            is_quick_fix: !!f.is_quick_fix, _dup: h,
          });
          commitFindings++;
        }
      }
    }
    const misses = Object.values(commitConformance).reduce((a, c) => a + c.misses, 0);
    const attempts = Object.values(commitConformance).reduce((a, c) => a + c.attempts, 0);
    log(`      → ${commitFindings} finding(s)${misses ? ` (${misses}/${attempts} conformance misses — see perCommit.conformanceByPass)` : ''}`);
    const state = budgetHit ? 'budget-exceeded' : fingerprintDrift ? 'provider-error' : 'ran';
    out.perCommit.push({
      sha, unitKey: unit.resumeKey, repo: path.basename(root), state, findings: commitFindings,
      chunks: chunks.length, skippedSensitive: ext.skippedSensitive, conformanceByPass: commitConformance,
      // The DENOMINATOR score's completion check derives cell-completeness
      // against (plan §3 "Execution contract"): passes × chunks × repeats for
      // THIS commit — a structural fact only the runner knows.
      expectedCells: PASSES.length * chunks.length * repeats,
      ...(fingerprintDrift ? { error: 'fingerprint-drift' } : {}),
      ...(budgetHit ? { error: 'budget', spentUsd: budgetHit.spentUsd } : {}),
    });
    // Per-commit checkpoint (matches cmdApparatus's existing pattern) — a run
    // spanning many commits survives an interruption having lost at most the
    // ONE commit in flight, not everything since the last invocation.
    atomicWriteFileSync(dest, JSON.stringify(out, null, 2));
    if (budgetHit) {
      log(`\n✗ BUDGET CEILING: $${budgetHit.spentUsd.toFixed(2)} spent across the ledger ≥ $${budgetUsd} cap${budgetHit.complete ? '' : ' (a FLOOR — some rows are unpriced)'}. Stopped at ${short}; it and every later commit are partial and will be dropped cohort-wide by score.`);
      process.exit(3);
    }
  }

  // Accumulate token usage across incremental runs.
  const priorUsage = out.usage || { input_tokens: 0, output_tokens: 0 };
  out.usage = { input_tokens: (priorUsage.input_tokens || 0) + totalIn, output_tokens: (priorUsage.output_tokens || 0) + totalOut };

  // Degeneracy guard (Gemini-R2-HIGH): if NO pass×chunk produced varied samples, the
  // xN arm never actually iterated (temperature ineffective) — flag it so scoring
  // treats it as x1, never as if it had iterated.
  if (repeats > 1) {
    out.samplingDegenerate = samplingTotalUnits > 0 && samplingVariedUnits === 0;
    out.samplingVariedUnits = samplingVariedUnits;
    out.samplingTotalUnits = samplingTotalUnits;
    if (out.samplingDegenerate) {
      log(`⚠ SAMPLING DEGENERATE: all ${samplingTotalUnits} pass×chunk unit(s) returned byte-identical repeats — the x${repeats} arm did NOT iterate (temperature ineffective). It is effectively x1; scoring must not credit iteration.`);
    } else {
      log(`sampling varied on ${samplingVariedUnits}/${samplingTotalUnits} unit(s).`);
    }
  }
  // File-level conformance rollup by pass, across ALL commits (this run + prior
  // incremental ones) — one place to read "was this arm's data thinner on pass X"
  // rather than scanning every perCommit entry.
  const rollup = {};
  for (const pc of out.perCommit) {
    if (!pc.conformanceByPass) continue;
    for (const [passName, c] of Object.entries(pc.conformanceByPass)) {
      const r = (rollup[passName] ||= { attempts: 0, misses: 0 });
      r.attempts += c.attempts; r.misses += c.misses;
    }
  }
  for (const r of Object.values(rollup)) r.missRate = r.attempts > 0 ? +(r.misses / r.attempts).toFixed(3) : 0;
  out.conformanceByPass = rollup;
  const worstPass = Object.entries(rollup).sort((a, b) => b[1].missRate - a[1].missRate)[0];
  if (worstPass && worstPass[1].missRate > 0.15) {
    log(`⚠ Conformance skew: '${worstPass[0]}' pass missed ${(worstPass[1].missRate * 100).toFixed(0)}% of attempts (${worstPass[1].misses}/${worstPass[1].attempts}) — that pass's recall for this arm should be read with this caveat.`);
  }

  atomicWriteFileSync(dest, JSON.stringify(out, null, 2));
  log(`\nWrote ${out.findings.length} total ${label} findings (${covered.size ? '+' + covered.size + ' prior commits' : 'fresh'}) → ${path.relative(process.cwd(), dest)}`);
  log(`Tokens this run: ${totalIn} in / ${totalOut} out. Next: run other author models, then \`merge\`.`);
}

// ── apparatus retro-run (arm A on historical known-defect commits) ───────────
//
// Git-mined known-defect commits have NO rows in the shadow view (they predate the
// experiment), so `merge` would refuse. This subcommand runs the ARM-A COMPOSITION
// (GPT 5-pass gen → Gemini net-new review) over the SAME extracted diffs the solo
// arms audit (identical context = fairness) and writes S-findings-A.json — which
// `merge` ingests through the same solo-file path (armLabel 'A').
//
// DELIBERATE plan deviation (documented): findings are NOT persisted to the
// production audit_findings store. Injecting retro experiment runs into the live
// ledger would contaminate the Phase-1 ledger-decomposition (every future
// kill-criterion query would count synthetic re-runs). Local file keeps the
// experiment out of production telemetry; the store stays production-only.

/** One GPT audit pass over a chunk (mirrors audit-shadow callModelDefault's GPT
 * path: Responses API + zodTextFormat over ShadowPassSchema, PASS_REASONING parity). */
async function runGptPass(client, zodTextFormat, gptModel, passName, diff, reasoning) {
  const system = PASS_PROMPTS[passName] || `Audit the code for ${passName} issues.`;
  const userPrompt = [
    `## Task\nAudit the code CHANGE below for the "${passName}" concern. Return findings per the schema.`,
    `## Diff\n${diff}`,
  ].join('\n\n');
  assertEgressSafe(userPrompt, { label: `apparatus:${passName}` });
  const params = {
    model: gptModel,
    input: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }],
    text: { format: zodTextFormat(ShadowPassSchema, 'shadow_pass') },
    max_output_tokens: 8000,
  };
  if (reasoning) params.reasoning = { effort: reasoning };
  const resp = await client.responses.parse(params);
  return { findings: resp.output_parsed?.findings || [], usage: resp.usage || null };
}

/**
 * The ONE gate-review prompt builder — every gate candidate (Flash, Pro,
 * Sonnet-<effort>, ...) sends BYTE-IDENTICAL text for the same (collected,
 * diff), so the ablation compares gate MODELS, not prompt wording. Factored
 * out for the same reason as buildColdPassPrompt: a structural guarantee via
 * one shared function, not a maintained coincidence between two copies.
 */
function buildGateReviewPrompt(collected, diff) {
  const priorList = collected.slice(0, 40).map((f) => `- [${f.severity}] ${f.category}: ${(f.detail || '').slice(0, 160)}`).join('\n');
  return [
    'You are the final-gate reviewer. Below are findings already raised by a prior audit.',
    'Emit ONLY NET-NEW findings the prior audit MISSED (do not restate). Return per the schema.',
    `## Prior findings\n${priorList || '(none)'}`,
    `## Subject under audit\n${diff}`,
  ].join('\n\n');
}

/** Gemini net-new review over the collected GPT findings (mirrors callGeminiDefault). */
async function runGeminiReview(geminiModel, collected, diff) {
  if (!process.env.GEMINI_API_KEY) return { findings: [], skipped: 'no-key' };
  const { GoogleGenAI } = await import('@google/genai');
  const { zodToGeminiSchema } = await import('./lib/schemas.mjs');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const prompt = buildGateReviewPrompt(collected, diff);
  assertEgressSafe(prompt, { label: 'apparatus:gemini' });
  const resp = await ai.models.generateContent({
    model: geminiModel, contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: zodToGeminiSchema(ShadowPassSchema) },
  });
  let parsed = null; try { parsed = JSON.parse(resp.text); } catch { /* conformance miss */ }
  return { findings: parsed?.findings || [], usage: geminiUsageOrNull(resp) };
}

/** Gemini's `usageMetadata` → the ledger's `{input_tokens, output_tokens}`,
 * or null when the provider reported nothing usable — never a fabricated 0,
 * which costFromUsage would price as FREE (the "always-null column reads as
 * free" defect). Reuses the shared normaliser so thoughts vs candidates are
 * billed the way Google bills them. */
function geminiUsageOrNull(resp) {
  const g = normalizeGeminiUsage(resp?.usageMetadata);
  return g.usageMissing ? null : { input_tokens: g.input_tokens, output_tokens: g.output_tokens };
}

/**
 * Claude's gate-ablation counterpart to runGeminiReview — a third candidate
 * (Flash vs Pro vs Sonnet-<effort>) in the gate ablation, paired against the
 * SAME immutable pre-gate artifact and never ranked in decide() (plan §3
 * "Gate ablation (not a candidate)"). Mirrors runGeminiReview's prompt text
 * VERBATIM (same "emit only net-new" framing, same priorList/diff shape) so
 * the ablation compares GATE MODELS, not prompt wording — but uses Claude's
 * OWN structured-output mechanism (forced tool-use), matching how
 * runGeminiReview/runGptPass each use their model's best mechanism rather
 * than a shared lowest-common-denominator one. This is deliberately NOT the
 * buildColdPassPrompt fairness rule (that isolates the MODEL for the cold-
 * arm comparison); the gate ablation asks "which model, at its best, makes
 * a better gate", so each gate gets its native structured-output path.
 *
 * @param {import('@anthropic-ai/sdk').default} client - createAnthropicClient({backend:'sdk'})
 * @param {string} model - resolved Claude model id (e.g. claude-sonnet-5)
 * @param {Array} collected - the GPT 5-pass deduped union
 * @param {string} diff - chunks[0] — same "gate sees chunk 0 only" limitation as the Gemini gates
 * @param {{reasoningEffort?: keyof typeof REASONING_TIERS.anthropic}} [opts] - an
 *   Anthropic `output_config.effort` tier; `high` is the API default. max_tokens
 *   follows the tier (REASONING_TIERS) because thinking shares that budget.
 */
async function runClaudeGateReview(client, model, collected, diff, { reasoningEffort = 'high' } = {}) {
  const prompt = buildGateReviewPrompt(collected, diff);
  assertEgressSafe(prompt, { label: 'apparatus:claude-gate' });

  const params = {
    model, max_tokens: REASONING_TIERS.anthropic[reasoningEffort] ?? 8000,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ name: 'emit_findings', description: 'Return the net-new findings.', input_schema: zodToOpenAiJsonSchema(ShadowPassSchema) }],
    tool_choice: { type: 'tool', name: 'emit_findings' },
  };
  if (reasoningEffort) params.output_config = { effort: reasoningEffort };

  let resp;
  try { resp = await client.messages.create(params, { timeoutMs: 300000 }); }
  catch (err) { return { findings: [], skipped: `error: ${String(err?.message || err).slice(0, 160)}` }; }

  const toolUse = Array.isArray(resp.content) ? resp.content.find((c) => c.type === 'tool_use') : null;
  const check = ShadowPassSchema.safeParse(clampToSchema(toolUse?.input ?? null));
  return { findings: check.success ? check.data.findings : [], usage: resp.usage || null };
}

/** Gemini as a FROM-SCRATCH generator — same open-ended "audit this diff" task
 * and prompt shape as runGptPass/runOssPass (PASS_PROMPTS system + the diff,
 * no prior findings to react to). Everywhere else in this experiment Gemini
 * only ever did the easier "find what's missing from this list" job
 * (runGeminiReview above) — this is the missing apples-to-apples comparison:
 * is Gemini actually a better cold auditor than GPT, or does it only look
 * clean because it always got the constrained review task? */
async function runGeminiPass(geminiModel, passName, diff) {
  if (!process.env.GEMINI_API_KEY) return { findings: [], skipped: 'no-key' };
  const { GoogleGenAI } = await import('@google/genai');
  const { zodToGeminiSchema } = await import('./lib/schemas.mjs');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const system = PASS_PROMPTS[passName] || `Audit the code for ${passName} issues.`;
  const userPrompt = [
    `## Task\nAudit the code below for the "${passName}" concern. Return findings per the schema.`,
    `## Code (redacted)\n${diff}`,
  ].join('\n\n');
  const prompt = `${system}\n\n${userPrompt}`;
  assertEgressSafe(prompt, { label: `gemini-solo:${passName}` });
  const resp = await ai.models.generateContent({
    model: geminiModel, contents: prompt,
    config: { responseMimeType: 'application/json', responseSchema: zodToGeminiSchema(ShadowPassSchema) },
  });
  let parsed = null; try { parsed = JSON.parse(resp.text); } catch { /* conformance miss */ }
  return { findings: parsed?.findings || [], usage: geminiUsageOrNull(resp) };
}

/** Run the apparatus (arm A) retro over --commits. Incremental like cmdRun. */
/** The immutable pre-gate artifact path for one commit (plan §7: written BEFORE
 * any gate call, so --gate-only can replay the exact bytes the first gate saw). */
const pregatePath = (sha) => path.join(OUT_DIR, `S-pregate-A-${sha}.json`);
/** Gate-output artifact path, tagged by a short gate label derived from the
 * resolved model id (falls back to a sanitised full id for an unrecognised gate). */
function gatePath(sha, resolvedGateModel) {
  // Scoped to the known gate-vendor id SHAPES (gemini-*/claude-*), not a bare
  // substring match — "flash"/"pro" alone would also match a non-gate model
  // that happens to contain the word (e.g. deepseek-flash, the exp-5 cold-arm
  // challenger), colliding two unrelated models onto one gate-output filename.
  const tag = /^gemini-.*flash/i.test(resolvedGateModel) ? 'flash'
    : /^gemini-.*pro/i.test(resolvedGateModel) ? 'pro'
    : /^claude-.*sonnet/i.test(resolvedGateModel) ? 'sonnet'
    : /^claude-.*opus/i.test(resolvedGateModel) ? 'opus'
    : resolvedGateModel.replace(/[^a-z0-9]+/gi, '-');
  return path.join(OUT_DIR, `G-${tag}-A-${sha}.json`);
}
function sha256hex(text) {
  return createHash('sha256').update(text || '').digest('hex');
}

async function cmdApparatus() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const commitsArg = argOption('commits');
  const corpusArg = argOption('corpus');
  const maxChars = Number.parseInt(argOption('max-chars', '45000'), 10);
  const maxDiffChars = Number.parseInt(argOption('max-diff-chars', '600000'), 10);
  const force = hasFlag('force');
  const resume = hasFlag('resume');
  const gateOnly = hasFlag('gate-only');
  const label = argOption('label', 'A'); // legacy default 'A' preserved for the pre-exp-5 caller

  let recipientPolicy;
  try { recipientPolicy = loadRecipientPolicy(RECIPIENT_POLICY_PATH); }
  catch (err) { log(`FATAL: recipient policy unavailable (${err.message})`); process.exit(2); }

  const { createOpenAIClient } = await import('./lib/openai-client.mjs');
  const { zodTextFormat } = await import('openai/helpers/zod');
  const { PASS_REASONING } = await import('./lib/config.mjs');
  try { const mr = await import('./lib/model-resolver.mjs'); await mr.refreshModelCatalog?.(); } catch { /* offline */ }
  // The incumbent's GPT is a CONCRETE PIN, not `latest-gpt`: the live-catalog
  // refresh above would resolve the sentinel to whatever OpenAI shipped most
  // recently (gpt-6-astra at the time of writing — pricier, unpriced in this
  // repo, and not the model exp-3 validated the apparatus against). Arm A is
  // "what production ran when the prior results were measured", so the id is
  // fixed here and recorded in provenance; a sentinel is still accepted for a
  // deliberate override.
  const gptModelArg = argOption('gpt-model', 'gpt-5.6-terra');
  const gptModel = resolveModel(gptModelArg);
  const gateModelArg = argOption('gate-model', 'latest-pro'); // legacy default preserved
  const gateModel = resolveModel(gateModelArg);
  // Gate ablation (plan §3): Flash/Pro (gemini) or Sonnet/Opus-class (anthropic)
  // — a third gate vendor would need a new branch below, same shape as cmdRun's
  // recipient dispatch. Never construct a client for a recipient not being used.
  const gateRecipient = classifyRecipient(gateModel);
  let gateReasoningEffort = null;
  if (gateRecipient === 'anthropic') {
    try { gateReasoningEffort = assertReasoningTier('anthropic', argOption('gate-reasoning-effort', 'high')); }
    catch (err) { log(`FATAL: ${err.message.replace('--reasoning-effort', '--gate-reasoning-effort')}`); process.exit(2); }
  } else if (argOption('gate-reasoning-effort')) {
    log(`FATAL: --gate-reasoning-effort applies to an anthropic gate only; "${gateModel}" is ${gateRecipient}.`); process.exit(2);
  }
  const budgetUsd = Number.parseFloat(argOption('budget-usd', '350')); // plan §8 ceiling, experiment-wide
  const client = await createOpenAIClient({ purpose: 'gpt' });
  const anthropicGateClient = gateRecipient === 'anthropic' ? await createAnthropicClient({ backend: 'sdk' }) : null;
  if (gateRecipient !== 'gemini' && gateRecipient !== 'anthropic') {
    log(`FATAL: gate recipient "${gateRecipient}" has no adapter yet (gemini/anthropic only).`); process.exit(2);
  }

  let requested;
  if (corpusArg) {
    const corpus = loadCorpus(corpusArg, recipientPolicy);
    // apparatus dispatches to BOTH openai (5-pass) and the gate's recipient per
    // commit — an entry must be eligible for the FULL pipeline, not just one leg.
    // entriesEligibleForRecipient returns entry IDS, not shas — map back
    // through the entries to the sha this runner needs (same fix as cmdRun).
    const openaiEligible = new Set(entriesEligibleForRecipient(corpus, 'openai'));
    const eligibleIds = new Set(entriesEligibleForRecipient(corpus, gateRecipient).filter((id) => openaiEligible.has(id)));
    requested = corpus.entries.filter((e) => eligibleIds.has(e.id)).map((e) => e.sha);
    if (commitsArg) log(`  (--corpus given — ignoring --commits; ${requested.length}/${corpus.entries.length} corpus entries are eligible for both openai and ${gateRecipient})`);
  } else if (commitsArg) {
    requested = commitsArg.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    log('apparatus requires --commits <sha,sha,...> or --corpus <path>.'); process.exit(2);
  }

  const dest = sFindingsPath(label);
  const prior = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, 'utf8')) : null;
  // cmdApparatus has no auto-discovery path (always manual --commits/--corpus),
  // so every unit's resumeKey is just its sha — wrap/unwrap around the shared
  // planIncrementalRun contract without changing this function's own sha-based loop body.
  const requestedUnits = requested.map((sha) => ({ mode: 'manual', resumeKey: sha, commitSha: sha, auditedSha: null, auditedTree: null }));
  let plan;
  try { plan = planIncrementalRun({ units: requestedUnits, prior, force, resume }); }
  catch (err) { log(`FATAL: ${err.message}`); process.exit(2); }
  const commits = plan.commits.map((u) => u.commitSha);
  const out = prior && !force
    ? { ...prior, generatedFor: [...new Set([...(prior.generatedFor || []), ...requested])] }
    : { armLabel: label, model: `${gptModel}+${gateModel}`, modelArg: `apparatus(latest-gpt→${gateModelArg})`, stageType: STAGE_TYPE, generatedFor: requested, findings: [], perCommit: [] };
  out.armLabel = label;
  out.provenance = {
    composition: gateOnly ? 'gate-only(reuses saved pre-gate artifact)' : `gpt-5pass→${gateRecipient}-review`,
    gptModel, gptModelArg, gateModel, gateModelArg, gateRecipient, gateReasoningEffort, maxChars, budgetUsd, retro: true,
    note: 'NOT persisted to audit_findings — experiment-local (keeps Phase-1 ledger clean)',
  };

  if (commits.length === 0) { log(`All ${requested.length} commit(s) already covered for ${label} — nothing to do.`); process.exit(0); }
  log(`Apparatus retro — arm=${label} · ${gateOnly ? 'GATE-ONLY over saved pre-gate' : gptModel + ' 5-pass'} → ${gateModel} review · ${commits.length} new commit(s)`);

  /** Budget preflight for one apparatus cell (plan §8). On breach: record the
   * cell as provider-error, the commit as budget-exceeded, checkpoint, stop. */
  const guardBudget = (sha, purpose, pass, chunkIndex, resolvedModel, recipient, sharedBy = null) => {
    const hit = budgetBreached(budgetUsd);
    if (!hit) return false;
    recordCall({ arm: label, sharedBy, commit: sha, purpose, pass, chunkIndex, repeatIndex: 0, resolvedModel, recipient, usage: null, state: 'provider-error' });
    out.perCommit.push({ sha, state: 'budget-exceeded', error: 'budget', spentUsd: hit.spentUsd });
    atomicWriteFileSync(dest, JSON.stringify(out, null, 2));
    log(`\n✗ BUDGET CEILING: $${hit.spentUsd.toFixed(2)} spent across the ledger ≥ $${budgetUsd} cap${hit.complete ? '' : ' (a FLOOR — some rows are unpriced)'}. Stopped at ${sha.slice(0, 8)}; it and every later commit are partial and will be dropped cohort-wide by score.`);
    process.exit(3);
  };

  for (const sha of commits) {
    const short = sha.slice(0, 8);
    let ext, chunks, collected, repoBasename, passChunks;

    if (gateOnly) {
      const pgPath = pregatePath(sha);
      if (!fs.existsSync(pgPath)) { log(`  ${short}: --gate-only but no pre-gate artifact at ${pgPath} — skipped (run without --gate-only first)`); out.perCommit.push({ sha, state: 'no-pregate' }); continue; }
      const pregate = JSON.parse(fs.readFileSync(pgPath, 'utf8'));
      const recomputed = sha256hex(pregate.gateContext);
      if (recomputed !== pregate.gateContextSha256) {
        log(`  ${short}: PRE-GATE INTEGRITY MISMATCH (recorded ${pregate.gateContextSha256}, recomputed ${recomputed}) — refusing, not gating a possibly-altered artifact`);
        out.perCommit.push({ sha, state: 'pregate-integrity-mismatch' });
        continue;
      }
      collected = pregate.findings;
      ext = { files: pregate.files || [] };
      chunks = [pregate.gateContext];
      passChunks = pregate.passChunks ?? null; // how many chunks the SHARED 5-pass rows span
      repoBasename = pregate.repo || null;
      log(`  ${short}: gate-only, reusing pre-gate (${collected.length} finding(s), verified sha256)`);
    } else {
      const root = locateCommit(sha);
      if (!root) { log(`  ${short}: NOT FOUND — skipped`); out.perCommit.push({ sha, state: 'not-found' }); continue; }
      const repoIdentity = repoIdentityFor(root);
      try { resolveAndAuthorize({ model: gptModel, repoIdentity, policy: recipientPolicy }); resolveAndAuthorize({ model: gateModel, repoIdentity, policy: recipientPolicy }); }
      catch (err) { log(`  ${short}: POLICY REFUSED (${err.message}) — skipped, not sent`); out.perCommit.push({ sha, repo: path.basename(root), state: 'policy-refused', error: err.message }); continue; }
      try { ext = extractDiff(root, sha); }
      catch (err) {
        if (String(err?.message).includes('[egress-gate]')) { log(`  ${short}: EGRESS REFUSAL — skipped`); out.perCommit.push({ sha, state: 'egress-refused' }); continue; }
        log(`  ${short}: diff extraction failed (${err.message})`); out.perCommit.push({ sha, state: 'diff-error', error: err.message }); continue;
      }
      if (!ext.diff) { out.perCommit.push({ sha, state: 'no-clean-files' }); continue; }
      if (ext.diff.length > maxDiffChars) {
        log(`  ${short}: diff ${ext.diff.length} chars > cap — RECORDED diff-too-large`);
        out.perCommit.push({ sha, repo: path.basename(root), state: 'diff-too-large', diffChars: ext.diff.length });
        continue;
      }
      repoBasename = path.basename(root);
      chunks = chunkDiff(ext.diff, maxChars);
      passChunks = chunks.length;
      log(`  ${short}: ${repoBasename} · ${ext.diff.length} chars · ${chunks.length} chunk(s)`);
      const raw = [];
      for (const passName of PASSES) {
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunk = chunks[chunkIndex];
          guardBudget(sha, 'pass', passName, chunkIndex, gptModel, 'openai', ['A', 'A+']);
          let r;
          try { r = await runGptPass(client, zodTextFormat, gptModel, passName, chunk, PASS_REASONING[passName] ?? null); }
          catch (err) {
            log(`      ! gpt ${passName} failed: ${String(err?.message).slice(0, 120)} — 0 findings`);
            recordCall({ arm: label, sharedBy: ['A', 'A+'], commit: sha, purpose: 'pass', pass: passName, chunkIndex, repeatIndex: 0, resolvedModel: gptModel, recipient: 'openai', usage: null, state: 'provider-error' });
            continue;
          }
          // 5-pass compute is SHARED between A and A+ (A+'s --gate-only reuses
          // this exact pregate artifact) — tagged sharedBy regardless of which
          // gate this specific invocation runs, so aggregateCostForArm credits
          // both configurations and aggregateBudgetSpent still counts it once.
          recordCall({ arm: label, sharedBy: ['A', 'A+'], commit: sha, purpose: 'pass', pass: passName, chunkIndex, repeatIndex: 0, resolvedModel: gptModel, recipient: 'openai', usage: r.usage, state: 'ok' });
          for (const f of r.findings) raw.push(f);
        }
      }
      collected = dedupeFindings(raw); // "deduped 5-pass union" per plan §7
      // Write the immutable pre-gate artifact BEFORE calling any gate.
      const gateContext = chunks[0] || '';
      atomicWriteFileSync(pregatePath(sha), JSON.stringify({
        sha, repo: repoBasename, files: ext.files, findings: collected, passChunks,
        gateContext, gateContextSha256: sha256hex(gateContext), writtenAt: new Date().toISOString(),
      }, null, 2));
    }

    // Gate — net-new over the deduped union (whichever way it was produced).
    guardBudget(sha, 'gate', 'apparatus-gate', 0, gateModel, gateRecipient);
    let gateFindings = [];
    try {
      const r = gateRecipient === 'anthropic'
        ? await runClaudeGateReview(anthropicGateClient, gateModel, collected, chunks[0] || '', { reasoningEffort: gateReasoningEffort })
        : await runGeminiReview(gateModel, collected, chunks[0] || '');
      gateFindings = r.findings;
      recordCall({ arm: label, commit: sha, purpose: 'gate', pass: 'apparatus-gate', chunkIndex: 0, repeatIndex: 0, resolvedModel: gateModel, recipient: gateRecipient, usage: r.usage || null, state: 'ok' });
    } catch (err) {
      log(`      ! ${gateRecipient} gate review failed: ${String(err?.message).slice(0, 120)}`);
      recordCall({ arm: label, commit: sha, purpose: 'gate', pass: 'apparatus-gate', chunkIndex: 0, repeatIndex: 0, resolvedModel: gateModel, recipient: gateRecipient, usage: null, state: 'provider-error' });
    }
    atomicWriteFileSync(gatePath(sha, gateModel), JSON.stringify({ sha, gateModel, findings: gateFindings }, null, 2));

    // Composite assembly: pre-gate union ∪ this gate's output, tagged stage.
    const seen = new Set();
    let commitFindings = 0;
    for (const f of collected) {
      const file = f.section || (ext.files[0] || '');
      const h = dupHash(f.category, file, f.detail);
      if (seen.has(h)) continue;
      seen.add(h);
      out.findings.push({ commit: sha, repo: repoBasename, model: out.model, pass: 'apparatus', stage: 'pregate', severity: f.severity, category: f.category, section: file, detail: f.detail, risk: f.risk, recommendation: f.recommendation, is_quick_fix: !!f.is_quick_fix, _dup: h });
      commitFindings++;
    }
    for (const f of gateFindings) {
      const file = f.section || (ext.files[0] || '');
      const h = dupHash(f.category, file, f.detail);
      if (seen.has(h)) continue;
      seen.add(h);
      out.findings.push({ commit: sha, repo: repoBasename, model: out.model, pass: 'apparatus', stage: 'gate', gateModel, severity: f.severity, category: f.category, section: file, detail: f.detail, risk: f.risk, recommendation: f.recommendation, is_quick_fix: !!f.is_quick_fix, _dup: h });
      commitFindings++;
    }
    log(`      → ${commitFindings} finding(s)`);
    out.perCommit.push({
      sha, repo: repoBasename, state: 'ran', findings: commitFindings, chunks: chunks.length,
      // Denominator for score's completion check: the shared 5-pass rows (over
      // the chunk count the passes actually ran on — for a gate-only run that is
      // the ORIGINAL run's count, carried in the pregate artifact) + this gate.
      // null when a legacy pregate artifact predates passChunks: score then
      // treats the commit as partial rather than guessing a denominator.
      expectedCells: passChunks == null ? null : PASSES.length * passChunks + 1,
    });
    atomicWriteFileSync(dest, JSON.stringify(out, null, 2)); // checkpoint per commit
  }
  atomicWriteFileSync(dest, JSON.stringify(out, null, 2));
  log(`\nWrote ${out.findings.length} total ${label} findings → ${path.relative(process.cwd(), dest)}`);
}

// ── B/C retro (OSS-gen + optional GPT-round + per-arm Gemini) ────────────────
//
// Companion to `apparatus` (arm A retro) — generates LOCAL retro findings for
// arms B and C over the SAME known-defect commits, using the EXACT B/C
// composition the live model-A/B/C shadow harness runs (lib/audit-arms.mjs
// CANONICAL_ARMS): oss-gen (currently GLM-5.2 via OpenRouter, SHARED compute
// between B and C) → [B only] one independent GPT round → EACH arm's own
// Gemini review (B reviews the deduped oss-gen+gpt-round union; C reviews
// oss-gen alone). Same deliberate deviation as `apparatus`: local files only,
// never persisted to audit_findings — keeps this retro study out of the live
// ledger's bookkeeping (spend caps, per-arm cost accounting are all real-audit
// concepts this offline comparison must not contaminate).

/** Dedupe a finding list by (category, file, detail) — mirrors dupHash's key. */
function dedupeFindings(list) {
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const h = dupHash(f.category, f.section, f.detail);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(f);
  }
  return out;
}

/** One OSS structured-output pass over a chunk (mirrors audit-shadow's
 * callModelDefault OSS path — same schema, same prompt shape as the GPT pass). */
async function runOssPass(client, ossModel, passName, diff, reasoning) {
  const system = PASS_PROMPTS[passName] || `Audit the code for ${passName} issues.`;
  const userPrompt = [
    `## Task\nAudit the code below for the "${passName}" concern. Return findings per the schema.`,
    `## Code (redacted)\n${diff}`,
  ].join('\n\n');
  assertEgressSafe(userPrompt, { label: `bc-retro:oss:${passName}` });
  const { ossStructuredCall } = await import('./lib/oss-structured-output.mjs');
  const r = await ossStructuredCall(client, {
    model: ossModel, system, userPrompt, schema: ShadowPassSchema, schemaName: 'shadow_pass',
    reasoningEffort: reasoning, passName: `oss-${passName}`,
  });
  return { findings: r.result?.findings || [], usage: r.usage, conformant: r.conformant, failed: r.failed, error: r.error };
}

async function cmdApparatusBC() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const commitsArg = argOption('commits');
  if (!commitsArg) { log('apparatus-bc requires --commits <sha,sha,...> (the known-defect commits).'); process.exit(2); }
  const requested = commitsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const maxChars = Number.parseInt(argOption('max-chars', '45000'), 10);
  const maxDiffChars = Number.parseInt(argOption('max-diff-chars', '600000'), 10);
  const force = hasFlag('force');

  const { createOpenAIClient, createOpenRouterClient } = await import('./lib/openai-client.mjs');
  const { zodTextFormat } = await import('openai/helpers/zod');
  const { PASS_REASONING } = await import('./lib/config.mjs');
  try { const mr = await import('./lib/model-resolver.mjs'); await mr.refreshModelCatalog?.(); } catch { /* offline */ }
  const ossModel = resolveModel('latest-oss-reasoner');
  const gptModel = resolveModel('latest-gpt');
  const geminiModel = resolveModel('latest-pro');
  const gptClient = await createOpenAIClient({ purpose: 'gpt' });
  const ossClient = await createOpenRouterClient();

  const destB = sFindingsPath('B');
  const destC = sFindingsPath('C');
  const priorB = fs.existsSync(destB) ? JSON.parse(fs.readFileSync(destB, 'utf8')) : null;
  const priorC = fs.existsSync(destC) ? JSON.parse(fs.readFileSync(destC, 'utf8')) : null;
  const covered = new Set(force || !priorB ? [] : priorB.perCommit.filter((c) => c.state === 'ran').map((c) => c.sha));
  const commits = requested.filter((sha) => !covered.has(sha));
  const outB = (priorB && !force) ? { ...priorB, findings: [...priorB.findings], perCommit: [...priorB.perCommit] }
    : { armLabel: 'B', model: 'oss(pending)+gpt-round+gemini', stageType: STAGE_TYPE, generatedFor: [], findings: [], perCommit: [] };
  const outC = (priorC && !force) ? { ...priorC, findings: [...priorC.findings], perCommit: [...priorC.perCommit] }
    : { armLabel: 'C', model: 'oss(pending)+gemini', stageType: STAGE_TYPE, generatedFor: [], findings: [], perCommit: [] };
  outB.model = `oss(${ossModel})+gpt-round(${gptModel})+gemini(${geminiModel})`;
  outC.model = `oss(${ossModel})+gemini(${geminiModel})`;
  outB.generatedFor = [...new Set([...(outB.generatedFor || []), ...requested])];
  outC.generatedFor = [...new Set([...(outC.generatedFor || []), ...requested])];

  if (commits.length === 0) { log(`All ${requested.length} commit(s) already covered for B/C — nothing to do (use --force to re-audit).`); process.exit(0); }
  log(`Apparatus B/C retro — oss=${ossModel} (shared) · gpt-round=${gptModel} (B only) · gemini=${geminiModel} · ${commits.length} new commit(s)`);

  for (const sha of commits) {
    const short = sha.slice(0, 8);
    const root = locateCommit(sha);
    if (!root) { log(`  ${short}: NOT FOUND in any local repo root — skipped`); outB.perCommit.push({ sha, state: 'not-found' }); outC.perCommit.push({ sha, state: 'not-found' }); continue; }
    let ext;
    try { ext = extractDiff(root, sha); }
    catch (err) {
      const state = String(err?.message).includes('[egress-gate]') ? 'egress-refused' : 'diff-error';
      log(`  ${short}: ${state} (${err.message}) — skipped`);
      outB.perCommit.push({ sha, state }); outC.perCommit.push({ sha, state });
      continue;
    }
    if (!ext.diff) { log(`  ${short}: no auditable (non-sensitive) files — skipped`); outB.perCommit.push({ sha, state: 'no-clean-files' }); outC.perCommit.push({ sha, state: 'no-clean-files' }); continue; }
    if (ext.diff.length > maxDiffChars) {
      log(`  ${short}: diff ${ext.diff.length} chars exceeds --max-diff-chars ${maxDiffChars} — RECORDED as diff-too-large`);
      outB.perCommit.push({ sha, repo: path.basename(root), state: 'diff-too-large', diffChars: ext.diff.length });
      outC.perCommit.push({ sha, repo: path.basename(root), state: 'diff-too-large', diffChars: ext.diff.length });
      continue;
    }
    const chunks = chunkDiff(ext.diff, maxChars);
    log(`  ${short}: ${path.basename(root)} · ${ext.diff.length} chars${chunks.length > 1 ? ` · ${chunks.length} chunks` : ''}`);

    // Shared oss-gen — ONE execution serves both B and C (compute-sharing,
    // matches the live harness's own DAG — decision 1/§ generation stages).
    const ossFindings = [];
    for (const passName of PASSES) {
      for (const chunk of chunks) {
        try {
          const r = await runOssPass(ossClient, ossModel, passName, chunk, PASS_REASONING[passName] ?? null);
          ossFindings.push(...r.findings);
        } catch (err) {
          if (String(err?.message).includes('[egress-gate]')) throw err;
          log(`      ! oss ${passName} failed: ${String(err?.message).slice(0, 120)} — 0 findings`);
        }
      }
    }

    // B-only: one independent GPT round over the SAME chunks (the diversity probe).
    const gptRoundFindings = [];
    for (const passName of PASSES) {
      for (const chunk of chunks) {
        try {
          const r = await runGptPass(gptClient, zodTextFormat, gptModel, passName, chunk, PASS_REASONING[passName] ?? null);
          gptRoundFindings.push(...r.findings);
        } catch (err) { log(`      ! gpt-round ${passName} failed: ${String(err?.message).slice(0, 120)} — 0 findings`); }
      }
    }

    // Per-arm Gemini: B reviews oss+gpt-round union; C reviews oss-gen alone.
    const bUpstream = dedupeFindings([...ossFindings, ...gptRoundFindings]);
    const cUpstream = dedupeFindings(ossFindings);
    let bGemini = [], cGemini = [];
    try { bGemini = (await runGeminiReview(geminiModel, bUpstream, chunks[0] || '')).findings; }
    catch (err) { log(`      ! gemini(B) failed: ${String(err?.message).slice(0, 120)}`); }
    try { cGemini = (await runGeminiReview(geminiModel, cUpstream, chunks[0] || '')).findings; }
    catch (err) { log(`      ! gemini(C) failed: ${String(err?.message).slice(0, 120)}`); }

    const bAll = dedupeFindings([...ossFindings, ...gptRoundFindings, ...bGemini]);
    const cAll = dedupeFindings([...ossFindings, ...cGemini]);
    const toRow = (f, model) => ({
      commit: sha, repo: path.basename(root), model, pass: 'apparatus-bc',
      severity: f.severity, category: f.category, section: f.section || (ext.files[0] || ''),
      detail: f.detail, risk: f.risk, recommendation: f.recommendation, is_quick_fix: !!f.is_quick_fix,
      _dup: dupHash(f.category, f.section, f.detail),
    });
    for (const f of bAll) outB.findings.push(toRow(f, outB.model));
    for (const f of cAll) outC.findings.push(toRow(f, outC.model));
    log(`      → B: ${bAll.length} finding(s), C: ${cAll.length} finding(s)`);
    outB.perCommit.push({ sha, repo: path.basename(root), state: 'ran', findings: bAll.length, chunks: chunks.length });
    outC.perCommit.push({ sha, repo: path.basename(root), state: 'ran', findings: cAll.length, chunks: chunks.length });
    atomicWriteFileSync(destB, JSON.stringify(outB, null, 2)); // checkpoint per commit
    atomicWriteFileSync(destC, JSON.stringify(outC, null, 2));
  }
  atomicWriteFileSync(destB, JSON.stringify(outB, null, 2));
  atomicWriteFileSync(destC, JSON.stringify(outC, null, 2));
  log(`\nWrote ${outB.findings.length} total arm-B findings → ${path.relative(process.cwd(), destB)}`);
  log(`Wrote ${outC.findings.length} total arm-C findings → ${path.relative(process.cwd(), destC)}`);
}

// ── Sonnet+Gemini retro (net-new only) — a targeted, cost-minimal follow-up ──
//
// Answers a specific question that arose from discussing the main result: is
// "Sonnet writes/audits, Gemini reviews" (2 distinct models) meaningfully
// different from "GLM audits, Gemini reviews" (arm C — also 2 distinct
// models, but neither is the likely author model)? Deliberately CHEAP: reuses
// the EXISTING S-sonnet findings as the baseline (zero regen cost) and only
// spends on ONE Gemini net-new pass per commit — never regenerates Sonnet's
// side. Writes ONLY Gemini's incremental additions (armLabel 'SG-gemini-only')
// so the caller can combine them with S-sonnet's ALREADY-BLIND-GRADED rows
// instead of re-grading everything from scratch.

async function cmdSonnetGeminiRetro() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const commitsArg = argOption('commits');
  if (!commitsArg) { log('sonnet-gemini-retro requires --commits <sha,sha,...>.'); process.exit(2); }
  const requested = commitsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const force = hasFlag('force');

  const sonnetPath = sFindingsPath('S-sonnet');
  if (!fs.existsSync(sonnetPath)) { log('No S-findings-S-sonnet.json — run `run --model claude-sonnet-5` first.'); process.exit(1); }
  const sonnetData = JSON.parse(fs.readFileSync(sonnetPath, 'utf8'));
  const sonnetByCommit = new Map();
  for (const f of sonnetData.findings) { if (!sonnetByCommit.has(f.commit)) sonnetByCommit.set(f.commit, []); sonnetByCommit.get(f.commit).push(f); }

  try { const mr = await import('./lib/model-resolver.mjs'); await mr.refreshModelCatalog?.(); } catch { /* offline */ }
  const geminiModel = resolveModel('latest-pro');

  const dest = sFindingsPath('SG-gemini-only');
  const prior = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, 'utf8')) : null;
  const covered = new Set(force || !prior ? [] : prior.perCommit.filter((c) => c.state === 'ran').map((c) => c.sha));
  const commits = requested.filter((sha) => !covered.has(sha));
  const out = (prior && !force) ? { ...prior, findings: [...prior.findings], perCommit: [...prior.perCommit] }
    : { armLabel: 'SG-gemini-only', model: `gemini(${geminiModel})-net-new-over-sonnet`, stageType: STAGE_TYPE, generatedFor: [], findings: [], perCommit: [] };
  out.model = `gemini(${geminiModel})-net-new-over-sonnet`;
  out.generatedFor = [...new Set([...(out.generatedFor || []), ...requested])];

  if (commits.length === 0) { log(`All ${requested.length} commit(s) already covered — nothing to do (use --force to re-run).`); process.exit(0); }
  log(`Sonnet+Gemini retro (net-new only) — baseline=S-sonnet (reused, no regen) · gemini=${geminiModel} · ${commits.length} commit(s)`);

  for (const sha of commits) {
    const short = sha.slice(0, 8);
    const sonnetFindings = sonnetByCommit.get(sha) || [];
    if (sonnetFindings.length === 0) { log(`  ${short}: no S-sonnet baseline on record — skipped`); out.perCommit.push({ sha, state: 'no-sonnet-baseline' }); continue; }
    const root = locateCommit(sha);
    if (!root) { log(`  ${short}: NOT FOUND in any repo root — skipped`); out.perCommit.push({ sha, state: 'not-found' }); continue; }
    let ext;
    try { ext = extractDiff(root, sha); }
    catch (err) {
      const state = String(err?.message).includes('[egress-gate]') ? 'egress-refused' : 'diff-error';
      log(`  ${short}: ${state} — skipped`); out.perCommit.push({ sha, state }); continue;
    }
    let geminiFindings = [];
    try { geminiFindings = (await runGeminiReview(geminiModel, sonnetFindings, ext.diff)).findings; }
    catch (err) { log(`      ! gemini failed: ${String(err?.message).slice(0, 120)}`); }
    for (const f of geminiFindings) {
      out.findings.push({
        commit: sha, repo: path.basename(root), model: out.model, pass: 'gemini-net-new',
        severity: f.severity, category: f.category, section: f.section || (ext.files[0] || ''),
        detail: f.detail, risk: f.risk, recommendation: f.recommendation, is_quick_fix: !!f.is_quick_fix,
      });
    }
    log(`  ${short}: sonnet baseline ${sonnetFindings.length} (reused) → gemini net-new ${geminiFindings.length}`);
    out.perCommit.push({ sha, repo: path.basename(root), state: 'ran', sonnetBaseline: sonnetFindings.length, geminiNetNew: geminiFindings.length });
    atomicWriteFileSync(dest, JSON.stringify(out, null, 2));
  }
  atomicWriteFileSync(dest, JSON.stringify(out, null, 2));
  log(`\nWrote ${out.findings.length} total gemini-net-new finding(s) → ${path.relative(process.cwd(), dest)}`);
  log('Combine with S-sonnet\'s EXISTING (already blind-graded) findings for these commits to get the full "SG" arm — do not re-grade the reused Sonnet rows.');
}

// ── Solo-pass retro (GPT alone / Gemini alone, no review layer) ──────────────
//
// The missing apples-to-apples test: arm A's saved data blends GPT's 5-pass
// generation with Gemini's net-new review under ONE tag ('apparatus') — the
// two can't be separated after the fact. And everywhere Gemini appears in
// this experiment (arm A/B/C, the Sonnet+Gemini follow-up) it only ever did
// the constrained "find what's missing" job, never the SAME open-ended
// "audit this diff cold" task GPT/GLM/Sonnet all got. This runs BOTH models
// through the identical from-scratch 5-pass task, no review step, so their
// standalone generator quality is directly comparable for the first time.

async function cmdSoloPassRetro() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const commitsArg = argOption('commits');
  const engine = argOption('engine');
  if (!commitsArg || (engine !== 'gpt' && engine !== 'gemini')) {
    log('solo-pass-retro requires --commits <sha,sha,...> and --engine gpt|gemini.'); process.exit(2);
  }
  const requested = commitsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const maxChars = Number.parseInt(argOption('max-chars', '45000'), 10);
  const maxDiffChars = Number.parseInt(argOption('max-diff-chars', '600000'), 10);
  const force = hasFlag('force');

  try { const mr = await import('./lib/model-resolver.mjs'); await mr.refreshModelCatalog?.(); } catch { /* offline */ }
  const { PASS_REASONING } = await import('./lib/config.mjs');
  let gptClient = null, zodTextFormat = null, model;
  if (engine === 'gpt') {
    const { createOpenAIClient } = await import('./lib/openai-client.mjs');
    ({ zodTextFormat } = await import('openai/helpers/zod'));
    gptClient = await createOpenAIClient({ purpose: 'gpt' });
    model = resolveModel('latest-gpt');
  } else {
    model = resolveModel('latest-pro');
  }

  const label = engine === 'gpt' ? 'GPT-alone' : 'Gemini-alone';
  const dest = sFindingsPath(label);
  const prior = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, 'utf8')) : null;
  const covered = new Set(force || !prior ? [] : prior.perCommit.filter((c) => c.state === 'ran').map((c) => c.sha));
  const commits = requested.filter((sha) => !covered.has(sha));
  const out = (prior && !force) ? { ...prior, findings: [...prior.findings], perCommit: [...prior.perCommit] }
    : { armLabel: label, model, stageType: STAGE_TYPE, generatedFor: [], findings: [], perCommit: [] };
  out.model = model;
  out.generatedFor = [...new Set([...(out.generatedFor || []), ...requested])];

  if (commits.length === 0) { log(`All ${requested.length} commit(s) already covered — nothing to do (use --force).`); process.exit(0); }
  log(`Solo-pass retro (${label}, no review layer) — model=${model} · ${commits.length} commit(s)`);

  for (const sha of commits) {
    const short = sha.slice(0, 8);
    const root = locateCommit(sha);
    if (!root) { log(`  ${short}: NOT FOUND in any repo root — skipped`); out.perCommit.push({ sha, state: 'not-found' }); continue; }
    let ext;
    try { ext = extractDiff(root, sha); }
    catch (err) {
      const state = String(err?.message).includes('[egress-gate]') ? 'egress-refused' : 'diff-error';
      log(`  ${short}: ${state} — skipped`); out.perCommit.push({ sha, state }); continue;
    }
    if (!ext.diff) { log(`  ${short}: no auditable (non-sensitive) files — skipped`); out.perCommit.push({ sha, state: 'no-clean-files' }); continue; }
    if (ext.diff.length > maxDiffChars) {
      log(`  ${short}: diff ${ext.diff.length} chars exceeds --max-diff-chars ${maxDiffChars} — RECORDED as diff-too-large`);
      out.perCommit.push({ sha, repo: path.basename(root), state: 'diff-too-large', diffChars: ext.diff.length });
      continue;
    }
    const chunks = chunkDiff(ext.diff, maxChars);
    log(`  ${short}: ${path.basename(root)} · ${ext.diff.length} chars${chunks.length > 1 ? ` · ${chunks.length} chunks` : ''}`);

    const collected = [];
    for (const passName of PASSES) {
      for (const chunk of chunks) {
        try {
          const r = engine === 'gpt'
            ? await runGptPass(gptClient, zodTextFormat, model, passName, chunk, PASS_REASONING[passName] ?? null)
            : await runGeminiPass(model, passName, chunk);
          collected.push(...r.findings);
        } catch (err) {
          if (String(err?.message).includes('[egress-gate]')) throw err;
          log(`      ! ${passName} failed: ${String(err?.message).slice(0, 120)} — 0 findings`);
        }
      }
    }
    for (const f of collected) {
      out.findings.push({
        commit: sha, repo: path.basename(root), model, pass: 'solo-generator',
        severity: f.severity, category: f.category, section: f.section || (ext.files[0] || ''),
        detail: f.detail, risk: f.risk, recommendation: f.recommendation, is_quick_fix: !!f.is_quick_fix,
      });
    }
    log(`      → ${collected.length} finding(s)`);
    out.perCommit.push({ sha, repo: path.basename(root), state: 'ran', findings: collected.length, chunks: chunks.length });
    atomicWriteFileSync(dest, JSON.stringify(out, null, 2));
  }
  atomicWriteFileSync(dest, JSON.stringify(out, null, 2));
  log(`\nWrote ${out.findings.length} total ${label} finding(s) → ${path.relative(process.cwd(), dest)}`);
}

// ── GPT independent judge (blind adjudication, second rater) ─────────────────
//
// Companion to `apparatus` (which uses GPT to GENERATE findings) — this uses GPT
// to GRADE the blind sheet, an independent second rater alongside the Claude-
// subagent pass. Directly tests the "Claude-judging-Claude" bias concern
// (docs/research/runbooks/solo-control-experiment.md design point 2) by having a different model
// family blind-grade the SAME rows. GPT has no live git access via the API, so
// each commit's FULL diff (the same chunkDiff-fixed evidence the generation
// passes saw, but sent WHOLE here — no re-chunking, so the judge never grades
// against a lone fragment) is embedded directly in the prompt, batched per
// commit (further split by row-count to avoid output truncation on large
// commits).
//
// Reads the UNLABELED blind-adjudication.csv — must NEVER read .blind-map.json
// (the unblind key; leaking it would invalidate the judge's independence).
// Writes a SEPARATE file (default blind-adjudication-gpt.csv) — never touches
// the Claude-judge sheet.

const GradingSchema = z.object({
  gradings: z.array(z.object({
    blind_id: z.string(),
    label: z.enum(['proven', 'actionable', 'plausible', 'false']),
    proof: z.string().optional().default(''),
    cluster: z.string().optional().default(''),
    matches: z.string().optional().default(''),
    pattern: z.string().optional().default(''),
  })),
});

const JUDGE_SYSTEM = [
  'You are a blind code-review adjudicator. You grade a list of findings against',
  'the ACTUAL diff provided below. You do NOT know which of several AI reviewers',
  'produced each finding — grade purely on whether the code supports the claim,',
  'never on writing style or confidence.',
  '',
  'CRITICAL: if the diff below was assembled from multiple chunks, a fragment with',
  'no visible `diff --git` header for a hunk is a CONTINUATION of a file shown',
  'elsewhere in this SAME diff, not evidence the file was deleted or is absent.',
  'Only grade a "file is missing/deleted" claim as proven/actionable if the file',
  'genuinely does not appear ANYWHERE in the diff shown to you.',
  '',
  'Label taxonomy (severity weights LOW=1, MEDIUM=3, HIGH=8):',
  '  proven     (factor 1.0) — direct code evidence confirms the claim exactly; cite file:line in `proof`.',
  '  actionable (factor 0.6) — real, worth-fixing issue, but not a slam-dunk proof; some inference involved.',
  '  plausible  (factor 0)   — could be true, unverifiable from the diff shown.',
  '  false      (factor 0)   — factually wrong against the diff shown.',
  '',
  '`proof` is REQUIRED (file:line or a short repro) whenever severity=HIGH and label is proven or actionable;',
  'otherwise leave it empty. If you cannot produce proof for a HIGH accept, grade it `plausible` instead.',
  '`cluster` — a short tag you choose so that findings describing the SAME underlying defect within this',
  'commit share one value (e.g. "c1", "c2"); reuse a tag across findings you judge to be the same defect.',
  '`matches` — a KD-NNN id from the known-defects rubric below, ONLY if label is proven/actionable AND the',
  'file is in that KD\'s file list AND the finding actually describes that KD\'s defect (not just same file).',
  '`pattern` — optional short tag, ONLY if this finding shares a file/module or violated invariant with',
  'another finding you are ALSO grading in this same batch; otherwise leave empty.',
  '',
  'Grade EVERY blind_id given. Return structured JSON per the schema — nothing else.',
].join('\n');

/** Quoted-CSV row parser (mirrors cmdScore's — kept local, no cross-fn coupling). */
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur); return out;
}

function readBlindSheet(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',');
  const col = (n) => header.indexOf(n);
  const iId = col('blind_id'), iCommit = col('commit'), iSev = col('severity'), iCat = col('category'), iFile = col('file'), iDetail = col('detail');
  const rows = lines.slice(1).map((line) => {
    const c = parseCsvLine(line);
    return { blindId: c[iId], commit: c[iCommit], severity: c[iSev], category: c[iCat], file: c[iFile], detail: c[iDetail] };
  });
  return { header, rows };
}

/** One GPT grading call over a sub-batch of rows for ONE commit's full diff. */
async function runGptJudgeBatch(client, zodTextFormat, gptModel, { shortSha, diff, kdBlock, rowsBatch, reasoning }) {
  const rowsJson = JSON.stringify(rowsBatch.map((r) => ({ blind_id: r.blindId, severity: r.severity, category: r.category, file: r.file, detail: r.detail })), null, 2);
  const userPrompt = [
    `## Commit ${shortSha} — full diff`,
    diff,
    kdBlock ? `## Known-defect rubric for this commit\n${kdBlock}` : '## Known-defect rubric for this commit\n(none)',
    `## Findings to grade (blind — ${rowsBatch.length} row(s))`,
    rowsJson,
  ].join('\n\n');
  assertEgressSafe(userPrompt, { label: `judge-gpt:${shortSha}` });
  const params = {
    model: gptModel,
    input: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: userPrompt }],
    text: { format: zodTextFormat(GradingSchema, 'grading') },
    max_output_tokens: 16000,
  };
  if (reasoning) params.reasoning = { effort: reasoning };
  const resp = await client.responses.parse(params);
  return { gradings: resp.output_parsed?.gradings || [], usage: resp.usage || null };
}

async function cmdJudgeGpt() {
  const srcPath = argOption('csv') ? path.resolve(argOption('csv')) : BLIND_CSV;
  const outPath = path.join(OUT_DIR, argOption('out', 'blind-adjudication-gpt.csv'));
  const rowBatchSize = Number.parseInt(argOption('batch-size', '40'), 10);
  const maxDiffChars = Number.parseInt(argOption('max-diff-chars', '600000'), 10);
  const force = hasFlag('force');
  if (!fs.existsSync(srcPath)) { log(`No blind sheet at ${path.relative(process.cwd(), srcPath)} — run merge first.`); process.exit(1); }

  const { header, rows } = readBlindSheet(srcPath);
  const iLabel = header.indexOf('label'), iProof = header.indexOf('proof'), iCluster = header.indexOf('cluster'), iMatches = header.indexOf('matches'), iPattern = header.indexOf('pattern');
  const rawLines = fs.readFileSync(srcPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(1);

  // RESUME (crash/interruption safety — found live: a session restart killed
  // this process mid-run and the ONLY-write-at-the-end version lost 12 fully-
  // graded commits' worth of real spend). Seed gradingByBlindId from any prior
  // partial output at outPath; every commit checkpoints as it finishes below,
  // so a killed process never loses more than its in-flight commit.
  const gradingByBlindId = new Map();
  if (fs.existsSync(outPath) && !force) {
    const priorLines = fs.readFileSync(outPath, 'utf8').split(/\r?\n/).filter(Boolean);
    const priorHeader = priorLines[0].split(',');
    const pId = priorHeader.indexOf('blind_id'), pLabel = priorHeader.indexOf('label'), pProof = priorHeader.indexOf('proof'), pCluster = priorHeader.indexOf('cluster'), pMatches = priorHeader.indexOf('matches'), pPattern = priorHeader.indexOf('pattern');
    for (const line of priorLines.slice(1)) {
      const c = parseCsvLine(line);
      if (c[pLabel]) gradingByBlindId.set(c[pId], { blind_id: c[pId], label: c[pLabel], proof: c[pProof], cluster: c[pCluster], matches: c[pMatches], pattern: c[pPattern] });
    }
    if (gradingByBlindId.size) log(`Resuming — ${gradingByBlindId.size} row(s) already graded in ${path.relative(process.cwd(), outPath)} (use --force to re-grade everything)`);
  }

  const { createOpenAIClient } = await import('./lib/openai-client.mjs');
  const { zodTextFormat } = await import('openai/helpers/zod');
  try { const mr = await import('./lib/model-resolver.mjs'); await mr.refreshModelCatalog?.(); } catch { /* offline */ }
  const gptModel = resolveModel(argOption('model', 'latest-gpt'));
  const client = await createOpenAIClient({ purpose: 'gpt' });

  const kdPath = path.join('docs/experiments/audit-effectiveness/known-defects.json');
  const knownDefects = fs.existsSync(kdPath) ? (JSON.parse(fs.readFileSync(kdPath, 'utf8')).defects || []) : [];

  const byCommit = new Map();
  for (const r of rows) { if (!byCommit.has(r.commit)) byCommit.set(r.commit, []); byCommit.get(r.commit).push(r); }
  log(`GPT judge — model=${gptModel} · ${rows.length} row(s) across ${byCommit.size} commit(s) → ${path.relative(process.cwd(), outPath)}`);

  /** Write the current gradingByBlindId state to outPath — called after EVERY
   * commit so a kill/restart never loses more than the in-flight commit. */
  const writeCheckpoint = () => {
    const lines = [header.join(',')];
    let ungradedNow = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const g = gradingByBlindId.get(r.blindId);
      const cells = parseCsvLine(rawLines[i]);
      if (g) {
        cells[iLabel] = g.label || ''; cells[iProof] = g.proof || ''; cells[iCluster] = g.cluster || `${r.commit}:${r.blindId}`;
        cells[iMatches] = g.matches || ''; cells[iPattern] = g.pattern || '';
      } else ungradedNow++;
      lines.push(cells.map(csvField).join(','));
    }
    atomicWriteFileSync(outPath, lines.join('\n') + '\n');
    return ungradedNow;
  };

  const failedCommits = [];
  for (const [shortSha, commitRows] of byCommit) {
    if (!force && commitRows.every((r) => gradingByBlindId.has(r.blindId))) {
      log(`  ${shortSha}: already graded (${commitRows.length} row(s)) — skipping (resume)`);
      continue;
    }
    const root = locateCommit(shortSha);
    if (!root) { log(`  ${shortSha}: NOT FOUND in any repo root — ${commitRows.length} row(s) left ungraded`); failedCommits.push(shortSha); continue; }
    let ext;
    try { ext = extractDiff(root, shortSha); }
    catch (err) {
      if (String(err?.message).includes('[egress-gate]')) log(`  ${shortSha}: EGRESS REFUSAL — ${commitRows.length} row(s) left ungraded`);
      else log(`  ${shortSha}: diff extraction failed (${err.message}) — ${commitRows.length} row(s) left ungraded`);
      failedCommits.push(shortSha); continue;
    }
    if (!ext.diff || ext.diff.length > maxDiffChars) {
      log(`  ${shortSha}: diff ${ext.diff ? ext.diff.length : 0} chars unusable (empty or > --max-diff-chars ${maxDiffChars}) — ${commitRows.length} row(s) left ungraded`);
      failedCommits.push(shortSha); continue;
    }
    const kdMatches = knownDefects.filter((d) => (d.buggyCommit || '').slice(0, 8) === shortSha || (d.fixCommit || '').slice(0, 8) === shortSha);
    const kdBlock = kdMatches.map((d) => `- ${d.id} (${d.severity}) files=[${(d.files || []).join(', ')}]: ${d.expectedFindingRubric}`).join('\n');

    let graded = 0;
    for (let i = 0; i < commitRows.length; i += rowBatchSize) {
      const rowsBatch = commitRows.slice(i, i + rowBatchSize);
      try {
        const { gradings } = await runGptJudgeBatch(client, zodTextFormat, gptModel, { shortSha, diff: ext.diff, kdBlock, rowsBatch, reasoning: 'high' });
        for (const g of gradings) gradingByBlindId.set(g.blind_id, g);
        graded += gradings.length;
      } catch (err) {
        log(`      ! judge batch failed for ${shortSha} rows ${i}-${i + rowsBatch.length}: ${String(err?.message).slice(0, 160)}`);
      }
    }
    log(`  ${shortSha}: ${commitRows.length} row(s), ${ext.diff.length} diff chars, ${kdMatches.length} KD hint(s) → ${graded} graded`);
    writeCheckpoint(); // persist after EVERY commit — the whole point of this fix
  }

  const ungraded = writeCheckpoint();
  log(`\nWrote ${rows.length - ungraded}/${rows.length} graded row(s) → ${path.relative(process.cwd(), outPath)}`);
  if (ungraded) log(`⚠ ${ungraded} row(s) ungraded (failed commits: ${failedCommits.join(', ') || 'none — batch call failures'}) — re-run this command (it will resume) or fill in by hand before scoring.`);
  log('This is a SEPARATE sheet from the Claude-judge pass — do not overwrite blind-adjudication.csv with it.');
  log(`To score it: copy over the canonical path then run score, e.g. cp ${path.relative(process.cwd(), outPath)} ${path.relative(process.cwd(), BLIND_CSV)} && node scripts/solo-control-audit.mjs score`);
}

/**
 * Pull A/B/C findings (with text) for the covered commits from the ledger.
 * Reads the `model_ab_finding_scores` VIEW for CORRECT arm attribution — arm A is
 * the baseline production audit whose findings carry `arm=NULL`; the view's
 * `model_ab_attribute_arms(stage, arm)` + `unnest` maps them to A (and a shared
 * oss-gen finding to BOTH B and C). A raw `audit_findings.arm IN ('A','B','C')`
 * filter would silently drop every baseline-A finding. Joined to audit_findings
 * for the detail text (the view has no snapshot), deduped by (arm, canonical_id)
 * so re-audits of the same commit don't inflate an arm's count.
 */
async function fetchExternalFindings(commits) {
  const { query } = await import('./lib/db/query.mjs');
  const r = await query(
    `SELECT DISTINCT ON (v.commit_sha, v.arm, v.canonical_id)
            v.commit_sha, v.arm, v.severity, v.outcome, v.canonical_id, v.finding_fingerprint,
            af.category, af.primary_file, af.detail_snapshot AS detail
       FROM model_ab_finding_scores v
       LEFT JOIN audit_findings af
              ON af.run_id = v.run_id AND af.finding_fingerprint = v.finding_fingerprint
      WHERE v.stage_type = $1 AND v.commit_sha = ANY($2::text[]) AND v.arm IN ('A','B','C')
      ORDER BY v.commit_sha, v.arm, v.canonical_id`,
    [STAGE_TYPE, commits],
  );
  return r.rows;
}

async function cmdMerge() {
  const sFiles = listSFindings();
  if (sFiles.length === 0) { log('No S-findings-*.json — run `solo-control-audit.mjs run` (per author model) first.'); process.exit(1); }
  const soloRuns = sFiles.map((f) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8')));
  // Union of covered commits across all solo runs (normally identical). `--commits`
  // narrows to an explicit subset — e.g. the curated known-defects.json commits,
  // excluding older/unrelated backfill commits that accumulated in the same
  // S-findings files (a real ~26% dilution found live: 447 unrelated rows / 207
  // clusters with zero known-defect ground truth, pure adjudication overhead).
  const commitsFilterArg = argOption('commits');
  const allCommits = [...new Set(soloRuns.flatMap((r) => r.generatedFor))];
  const commitsFilter = commitsFilterArg ? new Set(commitsFilterArg.split(',').map((s) => s.trim())) : null;
  const commits = commitsFilter ? allCommits.filter((c) => [...commitsFilter].some((f) => c.startsWith(f) || f.startsWith(c))) : allCommits;
  if (commitsFilter && commits.length !== commitsFilter.size) {
    log(`⚠ --commits requested ${commitsFilter.size} commit(s), matched ${commits.length} in the solo-run data.`);
  }
  const seed = Number.parseInt(argOption('seed', '20260704'), 10);
  // Severity scope — applied UNIFORMLY to S and A/B/C so it can't bias the
  // comparison. Default HIGH only: the auto-include tier. Two ADDITIVE, opt-in
  // tiers extend this without changing default behaviour (backward compatible —
  // both default off):
  //   --kd-candidates     any-severity findings whose (commit,file) plausibly
  //                       match one of the curated known-defects.json rubrics.
  //                       RECALL-BIASED (path-overlap only, no text/category
  //                       matching) so a severity cutoff can't silently corrupt
  //                       the one metric with real ground truth.
  //   --medium-sample <N> a stratified, capped, seeded sample of N MEDIUM-only
  //                       clusters (commit x multi-arm strata), Horvitz-Thompson-
  //                       weightable in `score`.
  // Converged design from /brainstorm --with-gemini (2026-07-06): HIGH-only was
  // found structurally biased by both external models (the solo arms emit ~2.3x
  // the apparatus's MEDIUM volume, so excluding MEDIUM hides exactly the tier
  // where arm discipline differs most) — but full HIGH+MEDIUM was ~3.2x the
  // adjudication volume (899 clusters short of ~1930). This is the middle design.
  const sevSet = new Set((argOption('severity', 'high').split(',').map((x) => x.trim().toUpperCase())));
  const inScope = (sev) => sevSet.has(String(sev || '').toUpperCase());
  const wantKdCandidates = hasFlag('kd-candidates');
  const mediumSampleTarget = Number.parseInt(argOption('medium-sample', '0'), 10) || 0;

  // Known-defect commits (if curated) — needed now (not just for the `matches`
  // column) because the kd-candidate tier match is computed here.
  const kdPath = path.join('docs/experiments/audit-effectiveness/known-defects.json');
  const knownDefects = fs.existsSync(kdPath) ? (JSON.parse(fs.readFileSync(kdPath, 'utf8')).defects || []) : [];
  const { matchesKnownDefect, stratifiedMediumSample } = await import('./lib/solo-control/stratified-sample.mjs');

  // Uniform blind rows. `detail` is truncated to ONE length for every arm so
  // verbosity/style can't leak arm identity (brainstorm: finding-style mismatch).
  const DETAIL_CAP = 220;
  const commitsSet = new Set(commits);
  const ext = await fetchExternalFindings(commits);
  const extACommits = new Set(ext.filter((e) => e.arm === 'A').map((e) => e.commit_sha));

  // Collect ALL severities (not just in-scope) so the kd-candidate + medium-pool
  // tiers and the free LOW-volume stat all have the data they need; `tier` decides
  // what actually reaches the sheet. Every row still gets a dupHash-derived `_i`-
  // independent `dup` key (used as the cluster-column fallback + LOW-stat scoping).
  const allRows = [];
  const lowVolumeByArm = {};
  for (const run of soloRuns) {
    const isLocalApparatus = (run.armLabel || '') === 'A';
    const arm = run.armLabel || 'S';
    for (const f of run.findings) {
      if (!commitsSet.has(f.commit)) continue;
      if (isLocalApparatus && extACommits.has(f.commit)) continue; // double-count guard
      if (String(f.severity || '').toUpperCase() === 'LOW') lowVolumeByArm[arm] = (lowVolumeByArm[arm] || 0) + 1;
      allRows.push({ arm, commit: f.commit, severity: f.severity, category: f.category, file: f.section, detail: (f.detail || '').slice(0, DETAIL_CAP), dup: f._dup, fingerprint: null });
    }
  }
  for (const e of ext) {
    if (!commitsSet.has(e.commit_sha)) continue;
    if (String(e.severity || '').toUpperCase() === 'LOW') lowVolumeByArm[e.arm] = (lowVolumeByArm[e.arm] || 0) + 1;
    allRows.push({ arm: e.arm, commit: e.commit_sha, severity: e.severity, category: e.category, file: e.primary_file, detail: (e.detail || '').slice(0, DETAIL_CAP), dup: dupHash(e.category, e.primary_file, e.detail), fingerprint: e.finding_fingerprint });
  }

  // kdHint is computed for EVERY row (independent of tier/--kd-candidates) — a
  // HIGH (auto-tier) row that happens to be the ACTUAL known-defect match is the
  // single most valuable hint on the whole sheet; it must not be reserved for the
  // kd-candidate tier only. --kd-candidates instead controls whether a match on a
  // row that ISN'T already auto-included ADDS it to the sheet as a new tier.
  for (const r of allRows) r.kdHint = matchesKnownDefect(r, knownDefects);

  // Tier each row: auto (in --severity scope) > kd-candidate (any severity, opt-in,
  // recall-biased path match) > medium-pool (severity=MEDIUM, sampling candidate)
  // > excluded (mostly LOW; never reaches the sheet, but already counted above).
  for (const r of allRows) {
    if (inScope(r.severity)) { r.tier = 'auto'; continue; }
    if (wantKdCandidates && r.kdHint) { r.tier = 'kd-candidate'; continue; }
    r.tier = String(r.severity || '').toUpperCase() === 'MEDIUM' ? 'medium-pool' : 'excluded';
  }
  const rows = allRows.filter((r) => r.tier !== 'excluded');
  // Coverage preflight (§12.4 / R2-H1): a covered commit with NO apparatus (arm A)
  // findings can't be compared — it would read as "solo won" against an empty
  // apparatus. Coverage can come from EITHER the ledger view (live shadow runs) OR
  // the local retro file S-findings-A.json (the `apparatus` subcommand). Refuse on
  // real gaps; the fix is `solo-control-audit.mjs apparatus --commits <gaps>`.
  const viewACommits = extACommits;
  const localA = soloRuns.find((r) => (r.armLabel || '') === 'A');
  const localACommits = new Set(localA ? localA.perCommit.filter((c) => c.state === 'ran').map((c) => c.sha) : []);
  const gaps = commits.filter((c) => !viewACommits.has(c) && !localACommits.has(c));
  if (gaps.length && !hasFlag('allow-apparatus-gaps')) {
    log(`REFUSING: ${gaps.length}/${commits.length} commit(s) have NO apparatus (arm A) findings (ledger view OR local retro) — an empty apparatus arm would falsely read as "solo won":`);
    for (const g of gaps.slice(0, 14)) log(`  ${g.slice(0, 12)} — run: node scripts/solo-control-audit.mjs apparatus --commits ${g.slice(0, 12)}`);
    log('Or pass --allow-apparatus-gaps to score only the covered commits (documented lower coverage).');
    process.exit(4);
  }
  // Cluster-PROPOSE pre-pass (offline aggregation aid): the LLM suggests duplicate
  // groups (bias to over-split), the human overrides. Sensitive rows never sent;
  // any failure → deterministic dupHash fallback. Proposals seed the `cluster` col.
  //
  // BATCHED PER COMMIT — two independent reasons, not just one: (1) a finding in
  // commit X can never be "the same underlying defect" as one in commit Y, so a
  // global cross-commit cluster call is semantically meaningless; (2) it's also
  // technically infeasible at scale — 1612 rows in one call blew both the input
  // context and the ~4000-token output budget (a full index-partition of 1612 items
  // doesn't fit), so every call silently degraded to the dupHash fallback. Batching
  // by commit fixes both: each batch is small (a few hundred rows at most) AND the
  // only grouping that could ever be correct.
  const { proposeClusters } = await import('./lib/solo-control/cluster-propose.mjs');
  const clusterOf = new Map();
  const clusterModesUsed = new Set();
  const client = await createAnthropicClient().catch(() => null);
  const rowsByCommit = new Map();
  rows.forEach((r, i) => {
    if (!rowsByCommit.has(r.commit)) rowsByCommit.set(r.commit, []);
    rowsByCommit.get(r.commit).push(i);
  });
  for (const [commitSha, idxs] of rowsByCommit) {
    const batch = idxs.map((i) => ({ category: rows[i].category, file: rows[i].file, detail: rows[i].detail }));
    let prop;
    try { prop = await proposeClusters(batch, { client }); }
    catch { prop = { clusters: {}, mode: 'duphash-degraded' }; }
    clusterModesUsed.add(prop.mode);
    for (const [cid, localIdxs] of Object.entries(prop.clusters)) {
      const globalCid = `${commitSha.slice(0, 8)}:${cid}`;
      for (const li of localIdxs) clusterOf.set(idxs[li], globalCid);
    }
  }
  const clusterMode = clusterModesUsed.size === 1 ? [...clusterModesUsed][0] : [...clusterModesUsed].join('+');

  // Cluster-level tier + sampling: a cluster reaches the sheet automatically if
  // ANY member row is tier='auto' or 'kd-candidate'; a PURE medium-pool cluster
  // (every member tier='medium-pool') is only a CANDIDATE — it's included iff the
  // stratified sampler picks it. This is why clustering ran over the tier UNION
  // above (not each tier separately): a HIGH row and a MEDIUM row describing the
  // same underlying defect must land in one cluster so the medium-pool row rides
  // in "for free" via auto-inclusion, rather than being independently sampled.
  const clusterKeyOf = (i) => clusterOf.get(i) || `solo:${rows[i].dup}`;
  const clusterRowIdxs = new Map(); // clusterKey -> [row idx,...]
  rows.forEach((_, i) => {
    const ck = clusterKeyOf(i);
    if (!clusterRowIdxs.has(ck)) clusterRowIdxs.set(ck, []);
    clusterRowIdxs.get(ck).push(i);
  });
  const autoIncludeClusters = new Set();
  const mediumPoolClusters = []; // → stratifiedMediumSample input shape
  for (const [ck, idxs] of clusterRowIdxs) {
    const memberTiers = idxs.map((i) => rows[i].tier);
    if (memberTiers.some((t) => t === 'auto' || t === 'kd-candidate')) { autoIncludeClusters.add(ck); continue; }
    // Pure medium-pool cluster — a sampling candidate.
    mediumPoolClusters.push({ clusterKey: ck, commit: rows[idxs[0]].commit, arms: new Set(idxs.map((i) => rows[i].arm)) });
  }
  const mediumSample = mediumSampleTarget > 0
    ? stratifiedMediumSample(mediumPoolClusters, { targetSize: mediumSampleTarget, seed: seed + 1 })
    : new Map();
  const includedClusters = new Set([...autoIncludeClusters, ...mediumSample.keys()]);
  const includedIdxs = [...clusterRowIdxs.entries()].filter(([ck]) => includedClusters.has(ck)).flatMap(([, idxs]) => idxs);

  // Assign blind ids over the INCLUDED rows only, then shuffle deterministically
  // (seededShuffle — replayable).
  const order = seededShuffle(includedIdxs.slice(), seed);
  const blind = order.map((origIdx, pos) => {
    const ck = clusterKeyOf(origIdx);
    const sampleInfo = mediumSample.get(ck);
    return {
      blindId: `F${String(pos + 1).padStart(3, '0')}`,
      proposedCluster: ck,
      inclusionProb: sampleInfo ? sampleInfo.inclusionProb : 1, // auto-include ⇒ certain (prob 1)
      sheetTier: sampleInfo ? 'medium-sample' : rows[origIdx].tier,
      ...rows[origIdx],
    };
  });

  // Public sheet — NO arm/fingerprint columns. 4-LABEL proof protocol (§12.1/§12.2):
  // `label` = proven|actionable|plausible|false; `proof` = file:line/repro for
  // high-severity; `cluster` = the proposed group (human overrides — merge/split
  // veto); `matches` = the known-defect id this finding proves, if any; `pattern` =
  // OPTIONAL — fill only if you judge this cluster is part of a broader systemic
  // issue (pre-declared criteria: same file/module OR same violated invariant as
  // another labeled cluster — not free-form narrative). Give it a short shared tag
  // (e.g. "reconcile-null-checks") so `score` can group by it later.
  const header = ['blind_id', 'commit', 'severity', 'category', 'file', 'detail', 'label', 'proof', 'cluster', 'matches', 'pattern'];
  const lines = [header.join(',')];
  for (const b of blind) {
    lines.push([b.blindId, b.commit.slice(0, 8), b.severity, b.category, b.file, b.detail, '', '', b.proposedCluster, b.kdHint || '', ''].map(csvField).join(','));
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  atomicWriteFileSync(BLIND_CSV, lines.join('\n') + '\n');

  // Private mapping (blindId → real arm + severity/category for scoreArms, PLUS
  // sheetTier + inclusionProb so `score` knows which rows are exhaustive
  // (auto/kd-candidate — scoreArms) vs a weighted sample (medium-sample —
  // scoreMediumSampleWeighted) for `score`.
  const map = {};
  for (const b of blind) map[b.blindId] = { arm: b.arm, commit: b.commit, severity: b.severity, category: b.category, fingerprint: b.fingerprint, dup: b.dup, sheetTier: b.sheetTier, inclusionProb: b.inclusionProb };
  // Underpowered/degenerate solo arms → carried so scoring can mark them ineligible.
  const armMeta = {};
  for (const run of soloRuns) armMeta[run.armLabel || 'S'] = { samplingDegenerate: !!run.samplingDegenerate, repeats: run.provenance?.repeats ?? 1 };
  atomicWriteFileSync(BLIND_MAP, JSON.stringify({
    seed, detailCap: DETAIL_CAP, commits, clusterMode, armMeta, map,
    knownDefects: knownDefects.map((d) => ({ id: d.id, buggyCommit: d.buggyCommit })),
    lowVolumeByArm, // free descriptive stat — LOW-severity raw finding volume per arm, never graded
    mediumSampleMeta: mediumSampleTarget > 0 ? { targetSize: mediumSampleTarget, poolSize: mediumPoolClusters.length, sampledSize: mediumSample.size } : null,
  }, null, 2));

  const byArm = blind.reduce((a, b) => ((a[b.arm] = (a[b.arm] || 0) + 1), a), {});
  const byTier = blind.reduce((a, b) => ((a[b.sheetTier] = (a[b.sheetTier] || 0) + 1), a), {});
  log(`Blind sheet: ${blind.length} findings (${Object.entries(byArm).map(([k, v]) => `${k}:${v}`).join(' ')}) · tiers(${Object.entries(byTier).map(([k, v]) => `${k}:${v}`).join(' ')}) · clustering=${clusterMode}${knownDefects.length ? ` · ${knownDefects.length} known-defect(s)` : ''} → ${path.relative(process.cwd(), BLIND_CSV)}`);
  if (mediumSampleTarget > 0) log(`  medium-sample: ${mediumSample.size}/${mediumSampleTarget} requested, drawn from a pool of ${mediumPoolClusters.length} pure-MEDIUM clusters.`);
  log(`  LOW-volume per arm (free, unlabeled review-burden stat): ${JSON.stringify(lowVolumeByArm)}`);
  log('Label `label` (proven|actionable|plausible|false); add `proof` (file:line/repro) for high-severity; fix `cluster` (merge/split); confirm/clear `matches` (pre-filled where a known-defect file+commit match was found); optionally set `pattern` for systemic-issue clusters.');
  log('Do NOT open .blind-map.json while labeling. Then: node scripts/solo-control-audit.mjs score');
}

async function cmdScore() {
  if (!fs.existsSync(BLIND_CSV) || !fs.existsSync(BLIND_MAP)) { log('Run `merge` and label the CSV first.'); process.exit(1); }
  const { map, commits, knownDefects = [], armMeta = {}, lowVolumeByArm = {}, mediumSampleMeta = null } = JSON.parse(fs.readFileSync(BLIND_MAP, 'utf8'));
  const csv = fs.readFileSync(BLIND_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = csv[0].split(',');
  const col = (n) => header.indexOf(n);
  const iId = col('blind_id'), iLabel = col('label'), iCluster = col('cluster'), iMatches = col('matches'), iProof = col('proof'), iPattern = col('pattern');

  // Simple quoted-CSV parse.
  const parseRow = (line) => {
    const out = []; let cur = '', q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out;
  };

  const VALID = new Set(['proven', 'actionable', 'plausible', 'false']);
  // Split by sheetTier: 'auto'/'kd-candidate' are EXHAUSTIVE (every cluster on the
  // sheet is counted directly → scoreArms); 'medium-sample' is a STRATIFIED SAMPLE
  // with a known inclusion probability → scoreMediumSampleWeighted (Horvitz-
  // Thompson). Mixing them into one scoreArms call would silently treat sampled
  // rows as if they were the whole population — wrong denominator, wrong precision.
  const exhaustiveRows = [];
  const sampleRows = [];
  const patternGroups = new Map(); // pattern tag -> [{blindId, commit, arm}]
  let unlabeled = 0, invalid = 0, dataRows = 0;
  const highNeedingProof = [];
  for (let i = 1; i < csv.length; i++) {
    const cols = parseRow(csv[i]);
    const blindId = cols[iId];
    const m = map[blindId];
    if (!m) continue;
    dataRows++;
    const label = (cols[iLabel] || '').trim().toLowerCase();
    if (!label) { unlabeled++; continue; }
    if (!VALID.has(label)) { invalid++; log(`  ⚠ ${blindId}: invalid label "${label}" (expected proven|actionable|plausible|false) — excluded`); continue; }
    const humanCluster = (cols[iCluster] || m.dup || blindId).trim() || blindId;
    const matches = iMatches >= 0 ? (cols[iMatches] || '').trim() || null : null;
    const pattern = iPattern >= 0 ? (cols[iPattern] || '').trim() || null : null;
    if (pattern) { if (!patternGroups.has(pattern)) patternGroups.set(pattern, []); patternGroups.get(pattern).push({ blindId, commit: m.commit, arm: m.arm }); }
    if ((m.severity || '').toUpperCase() === 'HIGH' && (label === 'proven' || label === 'actionable') && !(iProof >= 0 && (cols[iProof] || '').trim())) {
      highNeedingProof.push(blindId);
    }
    if (m.sheetTier === 'medium-sample') {
      sampleRows.push({ arm: m.arm, label, inclusionProb: m.inclusionProb ?? 1 });
    } else {
      exhaustiveRows.push({ arm: m.arm, commit: m.commit, severity: m.severity, category: m.category, label, humanCluster, matches });
    }
  }

  const coverage = dataRows > 0 ? (dataRows - unlabeled) / dataRows : 0;
  if (unlabeled > 0) log(`⚠ ${unlabeled}/${dataRows} row(s) unlabeled (coverage ${(coverage * 100).toFixed(0)}%).`);

  const underpowered = Object.entries(armMeta).filter(([, v]) => v.samplingDegenerate).map(([k]) => k);
  const { scoreArms, scoreMediumSampleWeighted } = await import('./lib/solo-control/scoring.mjs');
  const result = scoreArms(exhaustiveRows, { knownDefects, underpowered, apparatusArm: 'A' });
  const mediumEstimate = sampleRows.length > 0 ? scoreMediumSampleWeighted(sampleRows) : null;

  // Pattern report: a pre-declared "part of a broader systemic issue" tag the
  // adjudicator applied — reported as its OWN metric (systemic-issue detection),
  // never folded into ordinary per-finding precision (brainstorm: avoid post-hoc
  // stacking narratives — only pre-declared, human-applied tags count).
  const patternReport = [...patternGroups.entries()].map(([tag, members]) => ({
    tag, count: members.length, arms: [...new Set(members.map((x) => x.arm))], commits: [...new Set(members.map((x) => x.commit.slice(0, 8)))],
  }));

  const soloMeta = {};
  const armFiles = {};
  for (const f of listSFindings()) {
    const r = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
    const arm = r.armLabel || 'S';
    soloMeta[arm] = { model: r.model, repeats: r.provenance?.repeats ?? 1, samplingDegenerate: !!r.samplingDegenerate };
    armFiles[arm] = r;
  }

  // exp-5 `--decide` (plan §3 H5): the decision function over the call ledger.
  // Two things the plain score does not do: (1) drop any commit that is partial
  // for ANY arm from EVERY arm before scoring, so arms are compared on identical
  // commits (plan §3 "Execution contract"), and (2) hand decide() $/diff per arm
  // from the ledger, null-honest when any contributing row is unpriced.
  let decision = null;
  if (hasFlag('decide')) {
    const rows = readLedger(CALL_LEDGER_PATH);
    const arms = Object.keys(result.arms);
    const expectedCellsFor = (commit, arm) => armFiles[arm]?.perCommit?.find((c) => c.sha === commit && c.state === 'ran')?.expectedCells ?? null;
    const { kept, dropped } = commitsCompleteForAllArms(rows, arms, commits, expectedCellsFor);
    const keptSet = new Set(kept);
    const rowsKept = rows.filter((r) => keptSet.has(r.commit));
    const scoredKept = kept.length > 0
      ? scoreArms(exhaustiveRows.filter((r) => keptSet.has(r.commit)), { knownDefects, underpowered, apparatusArm: 'A' })
      : result;
    const ledger = { incumbentArm: 'A', costPerDiff: {}, costComplete: {}, recipients: {}, repeats: {} };
    for (const arm of arms) {
      const agg = aggregateCostForArm(rowsKept, arm);
      ledger.costPerDiff[arm] = agg.complete && kept.length > 0 ? +(agg.costUsd / kept.length).toFixed(4) : null;
      ledger.costComplete[arm] = agg.complete;
      ledger.recipients[arm] = new Set(rowsKept.filter((r) => r.arm === arm || (r.sharedBy || []).includes(arm)).map((r) => r.recipient)).size;
      ledger.repeats[arm] = soloMeta[arm]?.repeats ?? 1;
    }
    const { decide } = await import('./lib/solo-control/scoring.mjs');
    const verdict = decide(scoredKept, ledger);
    // Plan §3: "A verdict may not change the default while any arm in the
    // deciding cohort has > 10% partial cells" — reported, never silently applied.
    const partialFraction = Object.fromEntries(arms.map((arm) => [arm, +(dropped.filter((d) => d.causes.some((c) => c.arm === arm)).length / Math.max(1, commits.length)).toFixed(3)]));
    const worstPartial = Math.max(0, ...Object.values(partialFraction));
    decision = {
      ...verdict, ledger,
      cohort: { commitsScored: commits.length, kept: kept.length, dropped },
      partialFraction,
      verdictBlocked: worstPartial > 0.10 ? `INCOMPLETE — ${(worstPartial * 100).toFixed(0)}% partial in at least one arm exceeds the 10% rule; the default may not change on this run` : null,
    };
  }

  const report = {
    commitsCovered: commits.length,
    labelCoverage: +coverage.toFixed(2),
    decisionStatus: coverage >= 0.9 && highNeedingProof.length === 0 ? 'final' : 'directional-only',
    ...result,
    mediumSample: mediumSampleMeta ? { ...mediumSampleMeta, labeled: sampleRows.length, estimate: mediumEstimate } : null,
    lowVolumeByArm,
    systemicPatterns: patternReport.length ? patternReport : null,
    soloArmModels: soloMeta,
    ...(decision ? { decision } : {}),
    notes: {
      proofGap: highNeedingProof.length ? `${highNeedingProof.length} HIGH accepted finding(s) lack a proof cell → directional-only (§12.3 P4 gate)` : null,
      invalidLabels: invalid || null,
      caveat: 'Parallel frozen-diff — apparatus-unique value is an UPPER BOUND on external marginal value (in prod, a solo review would fix bugs before the apparatus saw the diff).',
    },
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  log('\nInterpretation (§12.2): an eligible solo arm with `matchesApparatus:true` at lower cost puts the apparatus on notice; '
    + 'ineligible (FP/noise ceiling) or under-recall on known defects → the apparatus earns its keep. Compare S-fable vs S-sonnet for the cost frontier.');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  const cmd = process.argv[2];
  try {
    if (cmd === 'run') await cmdRun();
    else if (cmd === 'apparatus') await cmdApparatus();
    else if (cmd === 'apparatus-bc') await cmdApparatusBC();
    else if (cmd === 'sonnet-gemini-retro') await cmdSonnetGeminiRetro();
    else if (cmd === 'solo-pass-retro') await cmdSoloPassRetro();
    else if (cmd === 'merge') await cmdMerge();
    else if (cmd === 'score') await cmdScore();
    else if (cmd === 'judge-gpt') await cmdJudgeGpt();
    else { log('Usage: solo-control-audit.mjs run|apparatus|apparatus-bc|sonnet-gemini-retro|solo-pass-retro|merge|score|judge-gpt  (see file header)'); process.exit(2); }
  } catch (err) {
    log(`FATAL: ${err?.stack || err?.message || err}`);
    process.exit(1);
  }
  process.exit(0);
}

// Guarded so tests can `import` this module for `_internals` (pure helpers
// like chunkDiff) without triggering a live CLI run + process.exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export const _internals = {
  chunkDiff, continuationMarker, planIncrementalRun, repoIdentityFor, buildColdPassPrompt,
  sha256hex, gatePath, pregatePath, extractDiff, extractAuditedDiff, locateCommit, treeExists, partitionDiscoveredRows,
  runClaudeGateReview, runGeminiReview, buildGateReviewPrompt,
  runPass, runDeepseekPass, REASONING_TIERS, assertReasoningTier, geminiUsageOrNull, budgetBreached, PASSES,
};
