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
 *   node scripts/solo-control-audit.mjs run   [--model <id>] [--label <S-x>] [--commits <sha,sha>] [--max-chars N]
 *   node scripts/solo-control-audit.mjs merge [--severity high[,medium,low]] [--seed N]
 *   node scripts/solo-control-audit.mjs score
 *   node scripts/solo-control-audit.mjs --selfcheck-relocation
 *
 * Multi-model: run `run` once per author model (e.g. --model claude-sonnet-5, then
 * --model claude-fable-5). Each writes S-findings-<label>.json (arm S-sonnet /
 * S-fable). `merge` unions ALL of them + the ledger's A/B/C into one blind sheet;
 * `score` reports each solo arm vs the apparatus AND against each other (the cost-
 * frontier three-way: clean Sonnet vs the A/B/C apparatus vs clean Fable).
 *
 * @module scripts/solo-control-audit
 */

import 'dotenv/config'; // load repo-local .env (CLAUDE_BACKEND, AUDIT_DB_URL, keys)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { createAnthropicClient } from './lib/anthropic-client.mjs';
import { resolveModel } from './lib/model-resolver.mjs';
import { PASS_PROMPTS } from './lib/prompt-seeds.mjs';
import { ShadowPassSchema, seededShuffle } from './lib/audit-shadow.mjs';
import { assertEgressSafe } from './lib/sensitive-egress-gate.mjs';
import { resolveShadowArmsWithToggle } from './lib/arm-eval/toggle.mjs';
import { classifyPath } from './lib/sensitive-paths.mjs';
import { redactSecrets } from './lib/secret-patterns.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';

// The 5 generation passes an arm runs (audit-shadow.mjs::SHADOW_PASSES == the
// PASS_PROMPTS keys minus quickfix). Re-derived here so the control can't drift
// from the baseline pass set.
const PASSES = Object.freeze(Object.keys(PASS_PROMPTS).filter((p) => p !== 'quickfix'));

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

function log(msg) { process.stderr.write(msg + '\n'); }
function argOption(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}
function hasFlag(name) { return process.argv.includes(`--${name}`); }
function git(root, args) {
  // Capture (not inherit) stderr so a benign `cat-file -e` miss doesn't leak
  // git's "fatal: not a valid object" to our stderr; the throw still carries it.
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function tryGit(root, args) {
  try { return git(root, args); } catch { return null; }
}
/** Stable dedup/cluster HINT hash — category|file|detail, consistent across S and
 * DB findings so `merge` can pre-group VERBATIM duplicates. NOT semantic dedup;
 * the human does that in the `cluster` column (semanticId can't cluster reworded
 * findings — brainstorm point 1). */
function dupHash(category, file, detail) {
  const s = `${category || ''}|${file || ''}|${detail || ''}`.toLowerCase().trim();
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);
}
function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── target-commit discovery ──────────────────────────────────────────────────

/** The audit-code units that already have a B/C shadow assignment — the paired
 * set the control must cover for an apples-to-apples comparison. */
async function discoverCommits() {
  const { query } = await import('./lib/db/query.mjs');
  const r = await query(
    `SELECT DISTINCT ar.commit_sha
       FROM audit_findings f JOIN audit_runs ar ON ar.id = f.run_id
      WHERE f.arm IN ('B','C') AND ar.stage_type = $1 AND ar.commit_sha IS NOT NULL
      ORDER BY ar.commit_sha`,
    [STAGE_TYPE],
  );
  return r.rows.map((x) => x.commit_sha);
}

/** Find which local repo root contains `sha` (as a real commit). */
function locateCommit(sha) {
  for (const root of REPO_ROOTS) {
    if (!fs.existsSync(root)) continue;
    if (tryGit(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null) return root;
  }
  return null;
}

/**
 * Extract the redacted, sensitive-file-filtered diff for a commit. Returns
 * { diff, files, skippedSensitive } or throws on an egress-gate refusal (a secret
 * in the diff — surface loudly, never send). `-U8` local context (NOT `-W` whole-
 * function, which inflates 2× on large commits without matching what the arms
 * audited — they map-reduce large diffs, they don't read whole function bodies).
 * NO truncation here: large diffs are CHUNKED at audit time (chunkDiff) so S gets
 * full coverage, mirroring the arms' map-reduce rather than seeing only a slice.
 */
function extractDiff(root, sha) {
  const nameOut = git(root, ['show', '--pretty=format:', '--name-only', sha]).trim();
  const allFiles = nameOut.split('\n').map((s) => s.trim()).filter(Boolean);
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
  let diff = git(root, ['show', sha, '-U8', '--', ...clean]);
  diff = redactSecrets(diff).text; // {text, redacted} — take the redacted string
  assertEgressSafe(diff, { label: `solo-control:${sha.slice(0, 8)}` });
  return { diff, files: clean, skippedSensitive };
}

/** Split a diff into ≤maxChars blocks at file (`diff --git`) boundaries so each
 * audit chunk is coherent; a single file larger than maxChars is hard-split. */
function chunkDiff(diff, maxChars) {
  if (diff.length <= maxChars) return [diff];
  const perFile = diff.split(/(?=^diff --git )/m).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (let part of perFile) {
    while (part.length > maxChars) { chunks.push(part.slice(0, maxChars)); part = part.slice(maxChars); }
    if (cur.length + part.length > maxChars && cur) { chunks.push(cur); cur = ''; }
    cur += part;
  }
  if (cur) chunks.push(cur);
  return chunks;
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

/** Run one audit pass with the author model over the cold diff. Mirrors
 * audit-shadow.mjs::runStage's per-pass prompt shape (system = PASS_PROMPTS[pass],
 * user = task + code), minus the reservation/cost machinery (offline, uncapped —
 * this is a bounded 20-call batch, not the live spend path). */
async function runPass(client, model, passName, diff) {
  // system = the arm's pass prompt VERBATIM (fairness); JSON contract goes last in user.
  const system = PASS_PROMPTS[passName] || `Audit the code for ${passName} issues.`;
  const user = [
    `## Task\nAudit the code CHANGE below for the "${passName}" concern.`,
    `## Diff\n${diff}`,
    JSON_CONTRACT,
  ].join('\n\n');
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let resp;
    try {
      resp = await client.messages.create({
        model, max_tokens: 8000, system,
        messages: [{ role: 'user', content: attempt === 1 ? user : user + '\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.' }],
      }, { timeoutMs: 300000 }); // a 45k-char audit prompt runs ~60-90s via claude -p; 120s default is too tight
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
      return { findings: check.data.findings, usage: resp.usage || null };
    }
    lastErr = check.error?.issues?.map((i) => i.message).join('; ') || 'unparseable';
  }
  log(`      ! pass ${passName} produced no conformant JSON (${lastErr}) — recorded 0 findings`);
  return { findings: [], usage: null, conformanceMiss: true };
}

// ── subcommands ──────────────────────────────────────────────────────────────

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
  const force = hasFlag('force');

  // SELF-GATE on the arm-eval/shadow toggle: the standing policy is "run the solo
  // control WHENEVER the shadow is on". So the audit skills fire `solo-control:
  // catchup` UNCONDITIONALLY (backgrounded) and this no-ops when the toggle is off
  // — the on/off decision lives in ONE place (the toggle), not duplicated in each
  // SKILL. An explicit --commits / --force is a manual override that bypasses the gate.
  if (!commitsArg && !force) {
    const shadow = resolveShadowArmsWithToggle();
    if (!shadow.enabled) { log('arm-eval/shadow toggle is OFF — solo control no-op (use --force or --commits to run anyway).'); process.exit(0); }
  }
  const requested = commitsArg ? commitsArg.split(',').map((s) => s.trim()).filter(Boolean) : await discoverCommits();
  if (requested.length === 0) { log('No target commits found (no B/C audit-code shadow units yet).'); process.exit(0); }

  const label = armLabelFor(model, argOption('label'));
  const dest = sFindingsPath(label);

  // INCREMENTAL accumulation (standing-policy use): merge onto any prior file for
  // this arm and skip commits already successfully audited, so repeated/scheduled
  // runs only cover NEW shadow commits and data grows monotonically. `--force`
  // re-audits everything.
  const prior = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, 'utf8')) : null;
  const covered = new Set(force || !prior ? [] : prior.perCommit.filter((c) => c.state === 'ran').map((c) => c.sha));
  const commits = requested.filter((sha) => !covered.has(sha));
  const out = prior && !force
    ? { ...prior, model, modelArg, generatedFor: [...new Set([...(prior.generatedFor || []), ...requested])] }
    : { armLabel: label, model, modelArg, stageType: STAGE_TYPE, generatedFor: requested, findings: [], perCommit: [] };
  out.armLabel = label;

  if (commits.length === 0) { log(`All ${requested.length} commit(s) already covered for ${label} — nothing to do (use --force to re-audit).`); process.exit(0); }
  log(`Solo control — arm=${label} · model=${model} (${modelArg}), ${commits.length} new commit(s)${covered.size ? ` (${covered.size} already covered)` : ''}, stage=${STAGE_TYPE}`);
  const client = await createAnthropicClient();
  let totalIn = 0, totalOut = 0;

  for (const sha of commits) {
    const short = sha.slice(0, 8);
    const root = locateCommit(sha);
    if (!root) { log(`  ${short}: NOT FOUND in any local repo root — skipped`); out.perCommit.push({ sha, state: 'not-found' }); continue; }
    let ext;
    try { ext = extractDiff(root, sha); }
    catch (err) {
      if (String(err?.message).includes('[egress-gate]')) { log(`  ${short}: EGRESS REFUSAL (${err.message}) — skipped, not sent`); out.perCommit.push({ sha, state: 'egress-refused' }); continue; }
      log(`  ${short}: diff extraction failed (${err.message}) — skipped`); out.perCommit.push({ sha, state: 'diff-error', error: err.message }); continue;
    }
    if (!ext.diff) { log(`  ${short}: no auditable (non-sensitive) files — skipped`); out.perCommit.push({ sha, state: 'no-clean-files', skippedSensitive: ext.skippedSensitive }); continue; }
    const chunks = chunkDiff(ext.diff, maxChars);
    log(`  ${short}: ${path.basename(root)} · ${ext.files.length} file(s) · ${ext.diff.length} chars${chunks.length > 1 ? ` · ${chunks.length} chunks` : ''}${ext.skippedSensitive.length ? ` · ${ext.skippedSensitive.length} sensitive skipped` : ''}`);

    // 5 passes × N chunks, unioned + deduped by _dup so a finding re-raised across
    // chunks/passes counts once (light map-reduce — full coverage, no truncation bias).
    const seen = new Set();
    let commitFindings = 0;
    for (const passName of PASSES) {
      for (const chunk of chunks) {
        const { findings, usage } = await runPass(client, model, passName, chunk);
        if (usage) { totalIn += usage.input_tokens || 0; totalOut += usage.output_tokens || 0; }
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
    log(`      → ${commitFindings} finding(s)`);
    out.perCommit.push({ sha, repo: path.basename(root), state: 'ran', findings: commitFindings, chunks: chunks.length, skippedSensitive: ext.skippedSensitive });
  }

  // Accumulate token usage across incremental runs.
  const priorUsage = out.usage || { input_tokens: 0, output_tokens: 0 };
  out.usage = { input_tokens: (priorUsage.input_tokens || 0) + totalIn, output_tokens: (priorUsage.output_tokens || 0) + totalOut };
  atomicWriteFileSync(dest, JSON.stringify(out, null, 2));
  log(`\nWrote ${out.findings.length} total ${label} findings (${covered.size ? '+' + covered.size + ' prior commits' : 'fresh'}) → ${path.relative(process.cwd(), dest)}`);
  log(`Tokens this run: ${totalIn} in / ${totalOut} out. Next: run other author models, then \`merge\`.`);
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
  // Union of covered commits across all solo runs (normally identical).
  const commits = [...new Set(soloRuns.flatMap((r) => r.generatedFor))];
  const seed = Number.parseInt(argOption('seed', '20260704'), 10);
  // Severity scope — applied UNIFORMLY to S and A/B/C so it can't bias the
  // comparison. Default HIGH only: the smallest sheet that answers the core ROI
  // question ("does S catch the SERIOUS bugs the apparatus catches?") and guards
  // against the adjudication-bloat failure mode. Broaden with
  // `--severity high,medium` (or add `,low`) once the HIGH picture is in.
  const sevSet = new Set((argOption('severity', 'high').split(',').map((x) => x.trim().toUpperCase())));
  const inScope = (sev) => sevSet.has(String(sev || '').toUpperCase());

  // Uniform blind rows. `detail` is truncated to ONE length for every arm so
  // verbosity/style can't leak arm identity (brainstorm: finding-style mismatch).
  const DETAIL_CAP = 220;
  const rows = [];
  for (const run of soloRuns) {
    for (const f of run.findings) {
      if (!inScope(f.severity)) continue;
      rows.push({ arm: run.armLabel || 'S', commit: f.commit, severity: f.severity, category: f.category, file: f.section, detail: (f.detail || '').slice(0, DETAIL_CAP), dup: f._dup, fingerprint: null });
    }
  }
  const ext = await fetchExternalFindings(commits);
  for (const e of ext) {
    if (!inScope(e.severity)) continue;
    rows.push({ arm: e.arm, commit: e.commit_sha, severity: e.severity, category: e.category, file: e.primary_file, detail: (e.detail || '').slice(0, DETAIL_CAP), dup: dupHash(e.category, e.primary_file, e.detail), fingerprint: e.finding_fingerprint });
  }

  // Assign blind ids, then shuffle deterministically (seededShuffle — replayable).
  rows.forEach((r, i) => { r._i = i; });
  const order = seededShuffle(rows.map((_, i) => i), seed);
  const blind = order.map((origIdx, pos) => ({ blindId: `F${String(pos + 1).padStart(3, '0')}`, ...rows[origIdx] }));

  // Public sheet — NO arm/fingerprint columns. Pre-fill `cluster` with the dup-hash
  // HINT so verbatim dups share a value; the human RE-clusters semantically and
  // fills `verdict` (accept|dismiss|uncertain).
  const header = ['blind_id', 'commit', 'severity', 'category', 'file', 'detail', 'verdict', 'cluster'];
  const lines = [header.join(',')];
  for (const b of blind) {
    lines.push([b.blindId, b.commit.slice(0, 8), b.severity, b.category, b.file, b.detail, '', b.dup].map(csvField).join(','));
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  atomicWriteFileSync(BLIND_CSV, lines.join('\n') + '\n');

  // Private mapping (blindId → real arm + fingerprint) for `score`. Written
  // separately so you can label the CSV without seeing the arm.
  const map = {};
  for (const b of blind) map[b.blindId] = { arm: b.arm, commit: b.commit, fingerprint: b.fingerprint, dup: b.dup };
  atomicWriteFileSync(BLIND_MAP, JSON.stringify({ seed, detailCap: DETAIL_CAP, commits, map }, null, 2));

  const byArm = blind.reduce((a, b) => ((a[b.arm] = (a[b.arm] || 0) + 1), a), {});
  log(`Blind sheet: ${blind.length} findings (${Object.entries(byArm).map(([k, v]) => `${k}:${v}`).join(' ')}) → ${path.relative(process.cwd(), BLIND_CSV)}`);
  log('Label the `verdict` column (accept|dismiss|uncertain) and merge dupes in `cluster`.');
  log('Do NOT open .blind-map.json while labeling. Then: node scripts/solo-control-audit.mjs score');
}

async function cmdScore() {
  if (!fs.existsSync(BLIND_CSV) || !fs.existsSync(BLIND_MAP)) { log('Run `merge` and label the CSV first.'); process.exit(1); }
  const { map, commits } = JSON.parse(fs.readFileSync(BLIND_MAP, 'utf8'));
  const csv = fs.readFileSync(BLIND_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  const header = csv[0].split(',');
  const iId = header.indexOf('blind_id'), iVerdict = header.indexOf('verdict'), iCluster = header.indexOf('cluster');

  // Parse labeled rows (simple CSV; detail may be quoted — split on the fixed
  // leading/trailing columns rather than naive comma-split of the whole line).
  const parseRow = (line) => {
    const out = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); return out;
  };

  const clusters = new Map(); // clusterKey → { arms:Set, verdict }
  let unlabeled = 0;
  for (let i = 1; i < csv.length; i++) {
    const cols = parseRow(csv[i]);
    const blindId = cols[iId];
    const verdict = (cols[iVerdict] || '').trim().toLowerCase();
    const clusterKey = (cols[iCluster] || blindId).trim() || blindId;
    const m = map[blindId];
    if (!m) continue;
    if (!verdict) { unlabeled++; continue; }
    if (!clusters.has(clusterKey)) clusters.set(clusterKey, { arms: new Set(), verdict: 'dismiss' });
    const c = clusters.get(clusterKey);
    c.arms.add(m.arm);
    // Cluster is accepted if ANY member row is accepted; uncertain if any uncertain and none accept.
    if (verdict === 'accept') c.verdict = 'accept';
    else if (verdict === 'uncertain' && c.verdict !== 'accept') c.verdict = 'uncertain';
  }
  if (unlabeled > 0) log(`⚠ ${unlabeled} row(s) have no verdict — label them for a complete score.`);

  const accepted = [...clusters.values()].filter((c) => c.verdict === 'accept');
  const has = (c, arm) => c.arms.has(arm);
  const hasExt = (c) => EXTERNAL_ARMS.some((a) => c.arms.has(a));

  // Arms actually present in the labeled data → solo arms = anything not A/B/C
  // (e.g. S-sonnet, S-fable). The apparatus = A/B/C.
  const allArms = [...new Set(Object.values(map).map((m) => m.arm))].sort();
  const soloArms = allArms.filter((a) => !EXTERNAL_ARMS.includes(a));

  const acceptedByArm = {};
  const uniqueByArm = {};
  for (const arm of allArms) {
    acceptedByArm[arm] = accepted.filter((c) => has(c, arm)).length;
    uniqueByArm[arm] = accepted.filter((c) => c.arms.size === 1 && has(c, arm)).length;
  }

  // Per-solo-arm vs the apparatus: recall of externally-accepted clusters, and how
  // many accepted clusters that solo arm found ALONE (no apparatus arm).
  const extAccepted = accepted.filter(hasExt);
  const soloVsApparatus = {};
  for (const sa of soloArms) {
    const recallNum = extAccepted.filter((c) => has(c, sa)).length;
    soloVsApparatus[sa] = {
      recallOfApparatusAccepted: extAccepted.length ? +(recallNum / extAccepted.length).toFixed(3) : null,
      recallFraction: `${recallNum}/${extAccepted.length}`,
      soloOnlyAccepted: accepted.filter((c) => has(c, sa) && !hasExt(c)).length,
    };
  }
  const apparatusOnlyAccepted = accepted.filter((c) => hasExt(c) && !soloArms.some((sa) => has(c, sa))).length;

  const soloMeta = {};
  for (const f of listSFindings()) {
    const r = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), 'utf8'));
    soloMeta[r.armLabel || 'S'] = { model: r.model, tokens: r.usage || null };
  }

  const report = {
    commitsCovered: commits.length,
    acceptedClusters: accepted.length,
    acceptedByArm,
    uniqueAcceptedByArm: uniqueByArm,
    soloVsApparatus,
    apparatusOnlyAccepted,
    soloArmModels: soloMeta,
    caveat: 'Parallel frozen-diff — apparatus-only accepted is an UPPER BOUND on external marginal value (in prod, a solo review would fix bugs before the apparatus saw the diff).',
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  log('\nInterpretation: a solo arm with high recallOfApparatusAccepted + nonzero soloOnlyAccepted puts the apparatus on notice; '
    + 'apparatusOnlyAccepted dominating → it earns its keep. Compare solo arms to each other (e.g. S-fable vs S-sonnet) for the cost-frontier call.');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  const cmd = process.argv[2];
  try {
    if (cmd === 'run') await cmdRun();
    else if (cmd === 'merge') await cmdMerge();
    else if (cmd === 'score') await cmdScore();
    else { log('Usage: solo-control-audit.mjs run|merge|score  (see file header)'); process.exit(2); }
  } catch (err) {
    log(`FATAL: ${err?.stack || err?.message || err}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
