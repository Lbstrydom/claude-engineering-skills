#!/usr/bin/env node
/**
 * @fileoverview Single verifier for the engineering-skills isolation contract.
 *
 * Consolidates every migration acceptance gate from plan §9 into one CLI.
 * Operators run this from the CONSUMER side after sync; it reads the
 * consumer's manifest as the source of truth and never scans the source
 * repo's filesystem (plan Gemini v2 G2 fix).
 *
 * Gates (each runnable independently via --gates 1,2A,2B,2C,3,4,5,6,7,8):
 *   1   Pre-migration git status / approval contract (read-only inspection)
 *   2A  Tracked-diff whitelist
 *   2B  Hydration-on-disk manifest hash check (manifest -> disk)
 *   2C  Orphan check (disk -> manifest): files in the isolated tooling dir
 *       that no manifest entry claims — invisible to 2B by construction
 *   3   No-stale-path verification (ownership-aware)
 *   4   Fresh-clone executable contract (CLI smoke + library import test)
 *   5   Consumer package.json npm-run reconciliation
 *   6   Manifest layout === 'isolated'
 *   7   .gitignore managed block presence + well-formedness
 *   8   No other discovered root (.github/skills, .agents/skills) shadows a
 *       skill this bundle deploys in .claude/skills/ — ownership derived from
 *       the consumer's OWN manifest, so their own skills are never gated
 *   9   No SKILL.md under .claude/skills/ carries a known frontmatter key
 *       (disable-model-invocation, allowed-tools, …) indented under a block
 *       scalar — YAML parses that as description TEXT and the declaration is
 *       silently inert. Fails on ANY skill dir, owned or not: unlike gate 8's
 *       foreign names this is never harmless, and the fix is one local edit.
 *
 * @module scripts/lib/sync-isolation-verify
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildOwnedSourceTailsFromConsumerManifest, COMMAND_REGEX as SHARED_COMMAND_REGEX } from './sync-rewriter.mjs';
import { parseGitignoreState } from './sync-gitignore.mjs';
import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';
import { SyncManifestSchema, hashFile } from './sync-manifest.mjs';
import { loadOverrides, matchOverride, OVERRIDES_PATH } from './sync-overrides.mjs';
import { enumerateNpmRunRefs } from './npm-script-enumerator.mjs';
import { listSurfaceNames, compareSkillSurfaces } from './skill-surface-identity.mjs';
import { lintSkillTree } from './skill-frontmatter-layout.mjs';
import { assertKnownFlags, ArgvError } from './cli-io.mjs';

// NOTE: this module intentionally does NOT import sync-inventory.mjs.
// Inventory is source-only (depends on consumer-repos.mjs which uses
// path resolution relative to the source repo's parent). The
// `--selfcheck-inventory` source-side smoke now lives in
// `scripts/check-isolation-inventory.mjs` instead — that script is
// source-only and never shipped to consumers.

// Exported (consumer-friction-doctor plan §2.3a) so the doctor's registry
// filters its own exclusion list (gate1 is migration-only, not a health
// check) from this module's own constant rather than hand-listing gate ids a
// second time — one more single-oracle application.
export const ALL_GATES = ['1', '2A', '2B', '2C', '3', '4', '5', '6', '7', '8', '9'];
// Backlog-triage fix — every flag this CLI's own parseArgs recognizes, fed to
// the shared assertKnownFlags oracle (the same one reconcile-repo-identity.mjs
// and friends use) so an unrecognized flag alongside a recognized one is a
// hard refusal, not a silent no-op.
const KNOWN_FLAGS = ['--consumer-root', '--legacy-manifest', '--gates', '--format', '--selfcheck-relocation', '--selfcheck-inventory'];
// Reuse the single source of truth from sync-rewriter — eliminates
// parser drift between rewrite and detect surfaces (R1 M1 fix).
const COMMAND_REGEX = SHARED_COMMAND_REGEX;

const CLI_SMOKE_SET = [
  'check-setup.mjs',
  'cross-skill.mjs',
  'cache-hitrate-check.mjs',
  'symbol-index/drift.mjs',
  'security-memory/refresh-incidents.mjs',
  'reconcile-repo-identity.mjs',
  'ux-lock-run.mjs', // WS2 deterministic /ux-lock runner
  'nav-audit.mjs',   // /nav-audit CLI orchestrator
  'visual-audit.mjs',// /visual-audit CLI orchestrator
  'persona-consistency-run.mjs', // Phase 4 consistency-mode runner; declared in
                                 // sync-to-repos.mjs (verified before adding —
                                 // see the trap this comment block warns about);
                                 // handler added 2026-08-16 (Gemini final review)

  'doctor.mjs', // consumer-friction doctor — the single door; must survive the scripts/.claude-skills relocation, declared in sync-to-repos.mjs
  'setup-postgres.mjs', // layout-aware repo-root resolution — must survive the scripts/.claude-skills relocation
  'efficacy-lints-check.mjs', // GREEN≠REALIZED Cluster A CLI — relocation-sensitive lib import
  'tiered-shadow-report.mjs', // tiered-recall Close-out shadow-validation report — reads the consumer's own shadow log
  'ship-commit.mjs', // deterministic /ship commit helper — AI-* provenance trailers (docs/reference/commit-provenance.md)
  'ensure-branch-protection.mjs', // strengthen-only main-branch ruleset tool — declared in sync-to-repos.mjs entries; a cloned consumer self-applies
  'maintenance-checks.mjs', // local weekly-maintenance replica — spawns sibling checks, must survive relocation
  'remediation-reconcile.mjs', // remediation-state verification reconciler — spawned by maintenance-checks.mjs AND /ship 0.5e; declared in sync-to-repos.mjs CORE_ENTRY
  // Self-hosted-runner doctor — already declared in sync-to-repos.mjs (plan's
  // Context Summary); its --selfcheck-relocation handler existed but was
  // unverified in consumers until Cluster B (self-hosted-runner-management.md).
  'actions-runner-doctor.mjs',
  // Citation re-resolver. Membership is legitimate ONLY because it is now
  // declared in sync-to-repos.mjs (see the NOTE below): it was deliberately kept
  // OUT while it was source-only, precisely to avoid the gate-4-fails-everywhere
  // failure that note describes.
  'check-doc-citations.mjs',
  // NOTE: `verify-anchor-contract.mjs` is deliberately NOT here. Its plan
  // (evidence-anchor-path-contract §9a) originally demanded membership by
  // reflex and was CORRECTED: this set asserts CONSUMER PRESENCE, so an entry
  // obliges declaring the script in sync-to-repos.mjs — and without that, gate
  // 4 fails in every consumer while this repo's `npm test` stays green. It is
  // also a source-repo ship gate probing live providers against a sha pinned
  // HERE; a consumer has no reason to own it. It keeps its
  // `--selfcheck-relocation` handler regardless (free, and correct).
  //
  // `model-eval-auditor.mjs` / `model-eval-adjudicator.mjs` are NOT here for the
  // same reason, removed 2026-07-19 after the predicted failure actually
  // happened. Commit 8999636 added them to this set without declaring them in
  // sync-to-repos.mjs, so gate 4 failed in every consumer for months while this
  // repo stayed green — exactly the trap the paragraph above describes.
  //
  // Removal (not declaring them in sync) is the right correction: both CLIs read
  // `docs/experiments/audit-effectiveness/known-defects.json`, a corpus graded on
  // THIS repo's finding distribution and deliberately never synced. Shipping the
  // CLIs without it would deliver tools that cannot run.
  //
  // The membership rule is now mechanically enforced by
  // tests/cli-smoke-set-sync-parity.test.mjs — a future entry that isn't in a
  // sync bundle fails HERE, at authoring time, instead of silently in consumers.
];

const LIB_IMPORT_SET = [
  { rel: 'lib/redact.mjs', mustExport: ['redact', 'redactObject'] },
  { rel: 'lib/sync-path-map.mjs', mustExport: ['sourceRelToDestRel', 'destRelToSourceRel'] },
  { rel: 'lib/sync-rewriter.mjs', mustExport: ['rewriteCommandSurface'] },
  { rel: 'security-memory/incident-status.mjs', mustExport: ['classifyMitigation'] },
  { rel: 'lib/nav/extract.mjs', mustExport: ['extractEdges', 'readSources'] },
  { rel: 'lib/nav/model.mjs', mustExport: ['buildModel'] },
  { rel: 'lib/nav/findings.mjs', mustExport: ['runTaxonomy'] },
  { rel: 'lib/nav/drift.mjs', mustExport: ['partitionFindings', 'ageDivergences'] },
  { rel: 'lib/ux-lock/selector-policy.mjs', mustExport: ['scanSpecSource', 'classifySelector', 'resolveTestRoot'] },
  // Gate 8 below classifies through this module rather than its own copy, so in
  // a consumer it is a runtime dependency of this very file. Listed here for the
  // same reason as the rest: a synced lib that did not arrive breaks a gate in a
  // repo we cannot observe.
  { rel: 'lib/skill-surface-identity.mjs', mustExport: ['listSurfaceNames', 'compareSkillSurfaces', 'classifyOrphans'] },
  // Gate 9 lints through this module; same reasoning as the entry above.
  { rel: 'lib/skill-frontmatter-layout.mjs', mustExport: ['lintSkillTree', 'lintSkillFrontmatterLayout'] },
];

const CMD_SCAN_PATHS = [
  '.claude/skills',
  '.claude/hooks',
  '.github/prompts',
  '.vscode',
  '.claude/settings.json',
];

function parseArgs(argv) {
  // `from: 0` — callers pass an already-sliced argv (process.argv.slice(2)),
  // not raw process.argv, so there is no node/script prefix to skip here.
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'sync-isolation-verify', from: 0 });

  const out = {
    consumerRoot: process.cwd(),
    legacyManifest: null,
    gates: ALL_GATES,
    format: 'text',
    selfcheckInventory: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--consumer-root') out.consumerRoot = argv[++i];
    else if (a === '--legacy-manifest') out.legacyManifest = argv[++i];
    else if (a === '--gates') {
      const raw = argv[++i];
      const parsed = (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
      // Backlog-triage fix — `--gates ''` used to collapse (via split+filter)
      // to an empty array, and runGates() over an empty gate list produces
      // zero results, zero failures, and exit 0: a verifier that silently
      // checked NOTHING read as a clean pass. Refuse rather than run zero
      // gates; omitting `--gates` entirely (the common case) still runs
      // everything in ALL_GATES via the default above.
      if (parsed.length === 0) {
        throw new ArgvError(
          `sync-isolation-verify: --gates was given an empty value ("${raw ?? ''}") — that would run ZERO gates `
          + 'and exit 0 having checked nothing. Omit --gates to run every gate, or name at least one '
          + `(${ALL_GATES.join(',')}).`,
        );
      }
      out.gates = parsed;
    }
    else if (a === '--format') out.format = argv[++i];
    else if (a === '--selfcheck-relocation') out.selfcheckRelocation = true;
    else if (a === '--selfcheck-inventory') out.selfcheckInventory = true;
  }
  return out;
}

function loadConsumerManifest(consumerRoot) {
  // M2 fix: validate the manifest shape via SyncManifestSchema before any
  // gate consumes its contents. Malformed `files` map, invalid hashes, or
  // unexpected layout values get reported as structured errors rather
  // than silently passing into gate logic.
  const p = path.join(consumerRoot, LAYOUT_CONSTANTS.MANIFEST_PATH);
  if (!fs.existsSync(p)) return { ok: false, error: `manifest missing at ${p}` };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    return { ok: false, error: `manifest parse failed: ${err.message}` };
  }
  const parsed = SyncManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`);
    return { ok: false, error: `manifest schema invalid:\n  ${issues.join('\n  ')}` };
  }
  return { ok: true, manifest: parsed.data, path: p };
}

function* walkDir(absDir) {
  if (!fs.existsSync(absDir)) return;
  const stack = [absDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    // Fail CLOSED: an unreadable command-bearing directory must abort the
    // walk, not be silently skipped — otherwise the relocation/command-surface
    // gates that consume this walk would pass while never having scanned the
    // directory (a false clean; the green-path-honesty rule).
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch (err) {
      throw new Error(`walkDir: cannot read directory ${cur} — verification aborted rather than silently skipping it (${err.message})`);
    }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) yield abs;
    }
  }
}

function listCommandBearingFiles(consumerRoot) {
  const out = [];
  for (const rel of CMD_SCAN_PATHS) {
    const abs = path.join(consumerRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (stat.isFile()) out.push(abs);
    else if (stat.isDirectory()) for (const f of walkDir(abs)) out.push(f);
  }
  return out;
}

function relativize(consumerRoot, abs) {
  return path.relative(consumerRoot, abs).replace(/\\/g, '/');
}

// ── Gate implementations ────────────────────────────────────────────────────

function gate2A(consumerRoot, manifest) {
  // Tracked-diff whitelist: no scripts/.claude-skills/** in EITHER
  //   (a) `git status --porcelain` — uncommitted/staged entries, OR
  //   (b) `git ls-files -- scripts/.claude-skills` — files that have been
  //       silently committed (R2 M1 fix: clean tracked files don't appear
  //       in `git status` but they DO appear in `git ls-files`).
  const offenders = [];

  // Part A: status entries with -z parsing (M4 fix preserved).
  let porcelain;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain', '-z'], {
      cwd: consumerRoot,
      encoding: 'utf-8',
    });
  } catch (err) {
    return { gate: '2A', pass: false, error: `git status failed: ${err.message}` };
  }
  const records = porcelain.split('\0').filter(Boolean);
  let i = 0;
  while (i < records.length) {
    const r = records[i];
    if (r.length < 3) { i++; continue; }
    const xy = r.slice(0, 2);
    const relPath = r.slice(3);
    const isRename = xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C';
    if (relPath.startsWith('scripts/.claude-skills/')) offenders.push(relPath);
    i++;
    if (isRename) {
      if (i < records.length && records[i].startsWith('scripts/.claude-skills/')) {
        offenders.push(records[i]);
      }
      i++;
    }
  }

  // Part B: clean tracked files under the isolated tree (R2 M1 fix).
  try {
    const lsFiles = execFileSync(
      'git', ['ls-files', '--', 'scripts/.claude-skills'],
      { cwd: consumerRoot, encoding: 'utf-8' },
    );
    for (const line of lsFiles.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && trimmed.startsWith('scripts/.claude-skills/')) {
        offenders.push(`${trimmed} (committed-tracked)`);
      }
    }
  } catch (err) {
    return { gate: '2A', pass: false, error: `git ls-files failed: ${err.message}` };
  }

  if (offenders.length) {
    return {
      gate: '2A',
      pass: false,
      error: `scripts/.claude-skills/ entries appear in tracked git state (${offenders.length}). The tooling tree must be gitignored AND not committed.`,
      details: { offenders: offenders.slice(0, 50) },
    };
  }
  return { gate: '2A', pass: true };
}

function gate2B(consumerRoot, manifest) {
  // Hydration-on-disk hash check.
  //
  // R2 M3 fix: check the FULL set of manifest entries, not only those
  // under `scripts/.claude-skills/`. The manifest also governs
  // .claude/skills/, .claude/hooks/, .github/prompts/, .vscode/mcp.json
  // and .claude/settings.json — those files are written by sync too and
  // their hashes are recorded. Verifying only the isolated tree leaves
  // a coverage gap where a corrupted skill .md would pass the gate.
  //
  // ── Declared overrides are HELD, not corrupt (2026-08-30) ──────────────
  //
  // A path in `.sync-overrides.json` is one the consumer told the sync not to
  // overwrite, and the sync obeys by leaving the file alone and carrying the
  // PRIOR base forward in the manifest. So the manifest deliberately records
  // one thing and the disk deliberately holds another, for ever — and this
  // gate read that as a hash mismatch.
  //
  // The consequence was that the documented remedy defeated the verifier:
  // `storyline` declared four SKILL.md overrides (its `<!-- repo-electron-target -->`
  // adapter blocks, which upstream cannot carry because they are repo-specific),
  // did exactly what the sync's own REFUSED message instructs, and its
  // `sync-isolation-verify` has exited 1 ever since — on precisely the four
  // paths it had just legitimised. A check that fires because you followed its
  // advice trains an operator to ignore it, which costs the other seven gates
  // their credibility too.
  //
  // Held paths are still REPORTED, never hidden: the whole point of an override
  // is that it is a standing, reviewable decision, and a divergence nobody can
  // see is the failure mode the override mechanism exists to end.
  const { overrides, errors: overrideErrors } = loadOverrides(consumerRoot);
  // A malformed overrides file FAILS the gate rather than being ignored. Treating
  // it as "no overrides" would fail-open in the other direction — every declared
  // path would silently become a mismatch again — and the sync itself aborts on
  // a malformed overrides file, so a verifier that shrugged at one would
  // disagree with the tool it verifies.
  if (overrideErrors.length) {
    return {
      gate: '2B',
      pass: false,
      error: `${OVERRIDES_PATH} is unusable, so held paths cannot be told from corrupted ones: ${overrideErrors.join('; ')}`,
      details: { overrideErrors },
    };
  }

  const missing = [];
  const mismatched = [];
  const held = [];
  for (const [destRel, expected] of Object.entries(manifest.files || {})) {
    // The manifest cannot record its own final hash: writing the self-entry
    // mutates the file, which changes the hash (chicken-and-egg). Skip it —
    // gate 2B verifies the files the manifest governs, not the manifest body.
    // Use the layout constant so this never drifts from the actual manifest path.
    if (destRel === LAYOUT_CONSTANTS.MANIFEST_PATH) continue;
    const abs = path.join(consumerRoot, destRel);
    // ABSENCE is still a failure even under an override. An override says "do
    // not overwrite my version", never "I do not need this file" — and since
    // 2026-08-30 the sync omits a held path from the manifest entirely when it
    // is not on disk, so an entry that is both claimed and missing is a real
    // fault whatever the overrides say.
    if (!fs.existsSync(abs)) { missing.push(destRel); continue; }
    let actual;
    try { actual = hashFile(abs); } catch (err) { missing.push(destRel); continue; }
    if (actual === expected) continue;
    if (matchOverride(destRel, overrides)) {
      held.push({ path: destRel, reason: matchOverride(destRel, overrides).reason });
      continue;
    }
    mismatched.push({ path: destRel, expected, actual });
  }
  if (missing.length || mismatched.length) {
    return {
      gate: '2B',
      pass: false,
      error: `${missing.length} missing + ${mismatched.length} hash-mismatched manifest entries.`,
      details: { missing: missing.slice(0, 50), mismatched: mismatched.slice(0, 50), held },
    };
  }
  // Passing, and still saying what it excused — an operator must be able to see
  // that N paths were skipped on the strength of a declaration they can review.
  return held.length
    ? { gate: '2B', pass: true, details: { held } }
    : { gate: '2B', pass: true };
}

/**
 * Gate 2C — the OTHER direction: disk → manifest.
 *
 * THE BLIND SPOT THIS CLOSES (upstream 167084b3, filed from a consumer
 * 2026-08-04). Gate 2B iterates `manifest.files` and asks "is each entry on
 * disk, with the right hash?". A file on disk with NO manifest entry is never
 * iterated, so it can be neither `missing` nor `mismatched` — it is invisible
 * to the gate by construction. The reporting consumer had **531 files in
 * `scripts/.claude-skills/` against 431 manifest entries: 100 orphans**, frozen
 * at whatever version they held when they last shipped, still executable, still
 * on documented command paths — while the bundle stamp read current. It was
 * found only because it forced three claims in an unrelated report to be
 * withdrawn as already-fixed-upstream, i.e. it had already cost review time
 * twice before anyone saw the cause.
 *
 * Scoped to `CONSUMER_TOOLING_DIR` on purpose. The manifest also governs
 * `.claude/skills/`, `.claude/hooks/`, `.vscode/mcp.json` and
 * `.claude/settings.json`, but those directories legitimately hold
 * CONSUMER-OWNED files alongside synced ones, so a reverse walk there would
 * report the consumer's own work as orphaned — a false positive that would earn
 * the gate a bypass. `scripts/.claude-skills/` is upstream-owned by
 * construction (AGENTS.md "Consumer-repo layout"): everything in it came from a
 * sync, so anything the manifest does not claim is stale by definition.
 *
 * This FAILS rather than warns. Every consumer will see it red once, which is
 * correct — the condition is real, has existed for months, and is one command
 * to clear. A stale executable on a documented command path is exactly what the
 * isolation contract exists to prevent.
 */
function gate2C(consumerRoot, manifest) {
  const toolDirRel = LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR;
  const abs = path.join(consumerRoot, toolDirRel);
  if (!fs.existsSync(abs)) return { gate: '2C', pass: true };

  const claimed = new Set(Object.keys(manifest.files || {}));
  const orphans = [];
  for (const fileAbs of walkDir(abs)) {
    const rel = relativize(consumerRoot, fileAbs);
    if (rel === LAYOUT_CONSTANTS.MANIFEST_PATH) continue;  // same self-entry carve-out as 2B
    // The ownership watermark is DECLARED never-in-the-manifest (sync-path-map.mjs:
    // "Never appears in the manifest, so the GC pass … cannot delete it"). Without
    // this carve-out gate 2C reports it on EVERY correctly-synced consumer, so the
    // gate could not be satisfied by doing the work right — the cried-wolf shape
    // that earns --no-verify, in the gate written to catch invisible drift.
    // Measured 2026-08-09: both consumers, freshly rehydrated, 1 orphan each — this file.
    if (rel === LAYOUT_CONSTANTS.OWNERSHIP_WATERMARK) continue;
    if (!claimed.has(rel)) orphans.push(rel);
  }
  if (orphans.length === 0) return { gate: '2C', pass: true };

  orphans.sort();
  return {
    gate: '2C',
    pass: false,
    error: `${orphans.length} orphaned file(s) in ${toolDirRel}/ — present on disk, absent from the manifest, `
      + 'frozen at whatever version they last shipped while the bundle stamp reads current. '
      + `Clear them by deleting ${toolDirRel}/ and re-running the sync from the source repo `
      + '(`npm run sync -- --target <name>`), which rehydrates exactly what the manifest claims.',
    details: { orphans: orphans.slice(0, 50), orphanTotal: orphans.length },
  };
}

function gate3(consumerRoot, manifest) {
  const ownedSourceTails = buildOwnedSourceTailsFromConsumerManifest(manifest);
  const files = listCommandBearingFiles(consumerRoot);
  const stale = [];
  for (const abs of files) {
    let content;
    // Fail CLOSED: an unreadable command-bearing file must abort the gate, not
    // be silently skipped — else a stale synced path hiding in it passes the
    // isolation check unverified (same fail-open class as the old walkDir).
    try { content = fs.readFileSync(abs, 'utf-8'); }
    catch (err) { throw new Error(`gate3: cannot read command-bearing file ${abs} — failing closed rather than skipping it unverified (${err.message})`); }
    let m;
    COMMAND_REGEX.lastIndex = 0;
    while ((m = COMMAND_REGEX.exec(content)) !== null) {
      const tail = m[1];
      if (tail.startsWith('.claude-skills/')) continue;
      if (!ownedSourceTails.has(tail)) continue;
      stale.push({ file: relativize(consumerRoot, abs), invocation: m[0] });
    }
  }
  if (stale.length) {
    return {
      gate: '3',
      pass: false,
      error: `${stale.length} stale ownership-confirmed paths in command-bearing files.`,
      details: { stale: stale.slice(0, 50) },
    };
  }
  return { gate: '3', pass: true };
}

function gate4(consumerRoot) {
  const failures = [];
  const TOOL_DIR = LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR;
  for (const rel of CLI_SMOKE_SET) {
    const abs = path.join(consumerRoot, TOOL_DIR, rel);
    if (!fs.existsSync(abs)) {
      failures.push({ kind: 'cli-missing', rel, path: abs });
      continue;
    }
    const result = spawnSync(process.execPath, [abs, '--selfcheck-relocation'], {
      cwd: consumerRoot,
      timeout: 30_000,
      encoding: 'utf-8',
    });
    if (result.error) {
      failures.push({ kind: 'cli-spawn-error', rel, message: result.error.message });
    } else if (result.status !== 0) {
      failures.push({ kind: 'cli-nonzero-exit', rel, status: result.status, stderr: (result.stderr || '').slice(0, 500) });
    }
  }
  // We can't `await import` synchronously from a sync gate runner without
  // making the whole verifier async; do that with a small sync workaround
  // by spawning a child to attempt the import.
  for (const { rel, mustExport } of LIB_IMPORT_SET) {
    const abs = path.join(consumerRoot, TOOL_DIR, rel);
    if (!fs.existsSync(abs)) {
      failures.push({ kind: 'lib-missing', rel, path: abs });
      continue;
    }
    // M5 fix: pass the target URL via process.argv to the probe child
    // process, eliminating JS source-string interpolation. The probe
    // body is static; only safe JSON literals from mustExport are
    // interpolated, and those are validated by the LIB_IMPORT_SET
    // schema, not from external input.
    const probeBody = `
      const target = process.argv[1];
      const required = ${JSON.stringify(mustExport)};
      import(target).then((mod) => {
        const missing = required.filter((k) => typeof mod[k] === 'undefined');
        if (missing.length) { console.error('missing:' + missing.join(',')); process.exit(2); }
        process.exit(0);
      }).catch((err) => { console.error('import-failed:' + err.message); process.exit(3); });
    `;
    const targetUrl = pathToFileURL(abs).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probeBody, targetUrl], {
      cwd: consumerRoot,
      timeout: 30_000,
      encoding: 'utf-8',
    });
    if (result.error) {
      failures.push({ kind: 'lib-spawn-error', rel, message: result.error.message });
    } else if (result.status !== 0) {
      failures.push({ kind: 'lib-import-failed', rel, status: result.status, stderr: (result.stderr || '').slice(0, 500) });
    }
  }
  if (failures.length) {
    return {
      gate: '4',
      pass: false,
      error: `${failures.length} relocation smoke failures.`,
      details: { failures },
    };
  }
  return { gate: '4', pass: true };
}

function gate5(consumerRoot, manifest) {
  const mdKeys = Object.keys(manifest.files || {}).filter((k) => k.endsWith('.md'));
  const allRefs = new Set();
  for (const k of mdKeys) {
    const abs = path.join(consumerRoot, k);
    if (!fs.existsSync(abs)) continue;
    let content;
    // Fail CLOSED (same rationale as gate3): a present-but-unreadable file
    // must not be silently skipped from the npm-ref reconciliation.
    try { content = fs.readFileSync(abs, 'utf-8'); }
    catch (err) { throw new Error(`npm-ref scan: cannot read ${abs} — failing closed (${err.message})`); }
    for (const r of enumerateNpmRunRefs(content)) allRefs.add(r);
  }

  const pkgPath = path.join(consumerRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    // No package.json — nothing for us to reconcile against; pass silently.
    return { gate: '5', pass: true, details: { skipped: 'no package.json' } };
  }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); }
  catch (err) {
    return { gate: '5', pass: false, error: `package.json parse failed: ${err.message}` };
  }
  const scripts = pkg.scripts || {};
  const stale = [];
  const unresolved = [];
  // Refs that resolve to the CONSUMER's own scripts. Collected rather than
  // discarded: a passing gate that silently ignored half its subjects would be
  // the vacuous pass this file keeps closing elsewhere.
  const consumerOwned = [];
  const ownedSourceTails = buildOwnedSourceTailsFromConsumerManifest(manifest);
  for (const ref of allRefs) {
    const body = scripts[ref];
    if (!body) continue; // script doesn't exist in consumer; informational only
    // Look for `node scripts/X` where X is NOT under .claude-skills/.
    let m;
    COMMAND_REGEX.lastIndex = 0;
    while ((m = COMMAND_REGEX.exec(body)) !== null) {
      const tail = m[1];
      if (tail.startsWith('.claude-skills/')) {
        // Pointing at the isolated layout is necessary but not sufficient: the
        // prefix says where the tool WOULD live, not that the bundle ships it.
        // Checking only the prefix here is why a consumer ran `context:check`
        // for a week against a file no CORE_ENTRY declared — the reconciliation
        // in the adoption runbook (Step 7) invites exactly this guess, so the
        // guess has to be verified, not assumed. Iterating refs can never show
        // an absent file; only stat'ing the target can.
        if (!fs.existsSync(path.join(consumerRoot, 'scripts', tail))) {
          unresolved.push({ npmScript: ref, body, target: `scripts/${tail}` });
        }
        continue;
      }
      // ── Ownership-aware, like gate 3 (2026-08-30) ────────────────────────
      //
      // "Not under .claude-skills/" is not the same as "stale". This gate
      // exists to catch a PRE-ISOLATION path — a consumer script still calling
      // `node scripts/openai-audit.mjs` after that tool moved to
      // `scripts/.claude-skills/openai-audit.mjs`. Only an UPSTREAM-OWNED tail
      // can be at the wrong path, because only upstream files moved.
      //
      // Measured in `storyline`: it flagged `ux:driver`/`ux:verb`, which run
      // `node scripts/ux/ux-driver.mjs` — files that exist and are the
      // CONSUMER's own (zero occurrences in its manifest). The refs reach this
      // gate because the consumer's `<!-- repo-electron-target -->` adapter
      // block, carried in four SKILL.md it has DECLARED as overrides,
      // deliberately redirects the browser lenses at its own Electron driver.
      // So the gate was telling a consumer that its own working scripts were
      // stale upstream paths, on the strength of a prefix.
      //
      // Gate 3 already had the right test and this one never got it — the same
      // one-directional-check family as gate 2B above. `ownedSourceTails` is
      // derived from the consumer's OWN manifest, so a consumer's own tree is
      // never judged by it.
      const tailIsOurs = ownedSourceTails.has(tail);
      if (!tailIsOurs) {
        consumerOwned.push({ npmScript: ref, body, target: `scripts/${tail}` });
        continue;
      }
      stale.push({ npmScript: ref, body, staleInvocation: m[0] });
    }
  }
  if (stale.length || unresolved.length) {
    const parts = [];
    if (stale.length) {
      parts.push(`${stale.length} stale node-scripts/ invocation(s) in consumer package.json scripts referenced by synced skills.`);
    }
    if (unresolved.length) {
      parts.push(
        `${unresolved.length} package.json script(s) invoke a scripts/.claude-skills/ file that is not present — `
        + 'the bundle does not ship it (report upstream: `cross-skill.mjs upstream report`), or this tree needs a re-sync.',
      );
    }
    return {
      gate: '5',
      pass: false,
      error: parts.join(' '),
      details: { stale, unresolved, consumerOwned },
    };
  }
  return consumerOwned.length
    ? { gate: '5', pass: true, details: { consumerOwned } }
    : { gate: '5', pass: true };
}

function gate6(manifest) {
  if (manifest.layout === 'isolated') return { gate: '6', pass: true };
  return {
    gate: '6',
    pass: false,
    error: `manifest.layout is "${manifest.layout || '<absent>'}"; expected "isolated".`,
  };
}

function gate7(consumerRoot) {
  const giPath = path.join(consumerRoot, '.gitignore');
  if (!fs.existsSync(giPath)) {
    return { gate: '7', pass: false, error: '.gitignore missing' };
  }
  const content = fs.readFileSync(giPath, 'utf-8');
  const state = parseGitignoreState(content);
  if (state.beginIndices.length === 1 && state.endIndices.length === 1 && state.orderValid) {
    return { gate: '7', pass: true };
  }
  return {
    gate: '7',
    pass: false,
    error: `managed block malformed: ${state.beginIndices.length} begin marker(s), ${state.endIndices.length} end marker(s), orderValid=${state.orderValid}`,
  };
}

/**
 * Gate 8 — no other discovered root shadows a skill this bundle deploys here.
 *
 * ## Why this gate exists on the CONSUMER side
 *
 * The source repo already refuses to claim a successful sync into a shadowed
 * target, but that only fires when someone happens to run `npm run sync`. A
 * shadow introduced afterwards — a plugin installing into `.agents/skills/`, a
 * developer copying a skill, an old bundle version — would sit undetected until
 * the next sync, which may be weeks. Since this verifier is itself synced and
 * consumers can wire it into their own `.githooks/pre-push.local`, putting the
 * check here makes it CONTINUOUS: the guarantee is enforced from the consumer's
 * side, on their cadence, using tooling we control from the source repo.
 *
 * ## Ownership: derived from the consumer's OWN manifest
 *
 * `manifest.files` lists exactly what this bundle deployed here, so the
 * `.claude/skills/<name>/` keys are the authoritative set of names WE own — no
 * hardcoded list to drift, and no need to know anything about the consumer's own
 * skills. A name in another root that we do NOT deploy is reported and never
 * fails: consumers legitimately keep their own skills in `.agents/skills/` (one
 * carries `supabase-postgres-best-practices` and `use-railway` from unrelated
 * plugins), and failing on those would be a gate about content nobody here can
 * act on — which is how a gate earns a permanent `--no-verify`.
 *
 * Precedence between discovered roots is NOT documented by Copilot, so a
 * collision means "which file gets read is undefined", not "the newer one wins".
 * That is why it blocks rather than warns.
 *
 * @param {string} consumerRoot
 * @param {{files?: Record<string, unknown>}} manifest
 */
/**
 * The `.claude/skills/<name>/` names this bundle deployed here, read off the
 * consumer's OWN manifest — the authoritative owned set gates 8 and 9 share, so
 * neither needs a hardcoded list and neither has to know the consumer's skills.
 * @param {{files?: Record<string, unknown>}|null} manifest
 * @returns {Set<string>}
 */
function ownedSkillNamesFromManifest(manifest) {
  const ours = new Set();
  for (const destRel of Object.keys(manifest?.files || {})) {
    const m = /^\.claude[\\/]skills[\\/]([^\\/]+)[\\/]/.exec(destRel.split('\\').join('/'));
    if (m) ours.add(m[1]);
  }
  return ours;
}

/**
 * Gate 9 — a known frontmatter key indented under a block scalar is inert.
 *
 * WHY (measured 2026-09-03 in a consumer): `.claude/skills/audit/SKILL.md`
 * carried `  disable-model-invocation: true` two spaces deep inside
 * `description: |`. YAML parsed it as description text, so the skill stayed
 * model-invocable while declaring it must not be — and the host's listing
 * showed the literal string as trailing prose, which is the only tell. Nothing
 * errors. The consumer has no other way to notice a declared restriction
 * silently stopped applying, which is why this runs HERE, continuously, and
 * not only in the source repo's push gate.
 *
 * Fails on ANY `.claude/skills/<name>/SKILL.md`, owned or not. Gate 8 leaves a
 * consumer's own names alone because a foreign name in another root is
 * harmless; an inert declaration never is, the file is theirs to edit, and the
 * fix is one dedent. Owned vs foreign is still split in `details` so the
 * remedy can say "re-sync" for ours and "dedent (or delete a retired skill)"
 * for theirs. A frontmatter-less or unparseable SKILL.md that is NOT ours is
 * reported as `unverifiable`, never failed — that is content nobody here can
 * act on and not the inert-declaration class.
 *
 * @param {string} consumerRoot
 * @param {{files?: Record<string, unknown>}|null} manifest
 */
function gate9(consumerRoot, manifest) {
  const LIVE = '.claude/skills';
  const ours = ownedSkillNamesFromManifest(manifest);
  const liveAbs = path.join(consumerRoot, ...LIVE.split('/'));
  if (!fs.existsSync(liveAbs)) {
    // Absent is a fact gate 2B already adjudicates (every owned file missing).
    // Say what was checked rather than passing silently.
    return { gate: '9', pass: true, details: { checked: 0, ownedSkills: ours.size, note: `${LIVE}/ absent` } };
  }
  const tree = lintSkillTree(liveAbs);
  if (tree.reason === 'unreadable') {
    return { gate: '9', pass: false, error: `cannot inspect ${LIVE}/: ${tree.error} — this gate cannot confirm no declaration is inert` };
  }
  if (tree.reason === 'no-skills') {
    return { gate: '9', pass: true, details: { checked: 0, ownedSkills: ours.size, note: `${LIVE}/ holds no <name>/SKILL.md` } };
  }

  const INERT_KINDS = new Set(['indented-known-key', 'non-boolean-flag', 'instrument-disagreement']);
  const owned = [];
  const foreign = [];
  const unverifiable = [];
  for (const f of tree.findings) {
    const entry = { skill: f.name, kind: f.kind, key: f.key, line: f.line, message: f.message };
    if (ours.has(f.name)) owned.push(entry);
    else if (INERT_KINDS.has(f.kind)) foreign.push(entry);
    else unverifiable.push(entry);
  }
  const details = { checked: tree.skills.length, ownedSkills: ours.size, owned, foreign, unverifiable };
  const failing = [...owned, ...foreign];
  if (failing.length === 0) return { gate: '9', pass: true, details };

  const describe = (e) => `${LIVE}/${e.skill}/SKILL.md${e.line ? `:${e.line}` : ''} (${e.key ? `\`${e.key}:\` ` : ''}${e.kind})`;
  return {
    gate: '9',
    pass: false,
    error: `${failing.length} inert frontmatter declaration(s): ${failing.map(describe).join(', ')} — ` +
      'a known key indented under a block scalar is parsed as description text and silently stops applying; ' +
      (owned.length ? 're-sync for the bundle-owned file(s)' : 'dedent the key to column 0') +
      (foreign.length ? (owned.length ? '; dedent the key to column 0 in the consumer-owned file(s)' : '') +
        ' — or delete the directory if the skill is no longer shipped by any bundle' : ''),
    details,
  };
}

function gate8(consumerRoot, manifest) {
  const SHADOWING = ['.github/skills', '.agents/skills'];
  const LIVE = '.claude/skills';

  const ours = ownedSkillNamesFromManifest(manifest);
  if (ours.size === 0) {
    // Nothing to protect — but say so rather than passing silently, so "gate 8
    // OK" can never mean "the manifest listed no skills and I checked nothing".
    return { gate: '8', pass: true, details: { ownedSkills: 0, note: 'manifest declares no .claude/skills entries' } };
  }

  // DELEGATES — this gate used to carry its own copy of the surface reader, the
  // symlink-tolerant filter and the alias rule, because the oracle lived in a
  // source-repo CLI this synced module cannot import. Moving the rule to
  // `lib/skill-surface-identity.mjs` removed that excuse: one implementation,
  // three call sites. The two copies happened to agree, which is not a property
  // anything was maintaining — and they had already diverged in vocabulary
  // (`foreign` here, `orphans` there) for one concept.
  const shadowed = [];
  const aliased = [];
  const foreign = [];
  for (const surface of SHADOWING) {
    const read = listSurfaceNames(consumerRoot, surface);
    if (!read.readable) {
      // Unreadable is NOT clean — fail closed rather than report a shadow-free
      // verdict we did not earn. (`listSurfaceNames` already reports a genuinely
      // absent surface as readable with zero names.)
      return { gate: '8', pass: false, error: `cannot inspect ${surface}: ${read.error.code} ${read.error.message}` };
    }
    const cmp = compareSkillSurfaces({
      staleNames: read.names,
      liveNames: [...ours],
      contentOf: () => null,          // this gate reports names, never diffs bodies
      realPathOf: (which, name) => {
        const dir = path.join(consumerRoot, ...(which === 'live' ? LIVE : surface).split('/'), name);
        try { return fs.realpathSync(dir); } catch { return null; }
      },
    });
    for (const s of cmp.shadowed) shadowed.push(`${surface}/${s.name}`);
    for (const n of cmp.aliased) aliased.push(`${surface}/${n}`);
    // `orphans` is the oracle's word for "a name we do not deploy"; this gate has
    // published it as `foreign` in its `details` since it shipped. Mapped once,
    // here, rather than renaming a field consumers may already parse.
    for (const n of cmp.orphans) foreign.push(`${surface}/${n}`);
  }

  if (shadowed.length > 0) {
    return {
      gate: '8',
      pass: false,
      error: `${shadowed.join(', ')} shadow${shadowed.length === 1 ? 's' : ''} a skill this bundle deploys in ` +
        `${LIVE}/ — precedence between discovered roots is undefined, so remove the shadowing copy`,
      details: { shadowed, aliased, foreign, ownedSkills: ours.size },
    };
  }
  return { gate: '8', pass: true, details: { ownedSkills: ours.size, aliased, foreign } };
}

function gate1(consumerRoot) {
  // Read-only — surfaces uncommitted state for the operator to decide on.
  // The actual approval is recorded out-of-band (AskUserQuestion in the
  // migration runner); this gate just reports.
  let porcelain;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: consumerRoot,
      encoding: 'utf-8',
    });
  } catch (err) {
    return { gate: '1', pass: false, error: `git status failed: ${err.message}` };
  }
  const lines = porcelain.split('\n').filter(Boolean);
  return { gate: '1', pass: true, details: { dirtyEntries: lines.length, lines: lines.slice(0, 50) } };
}

// ── Main ────────────────────────────────────────────────────────────────────

// Exported (consumer-friction-doctor plan §2.3a) — already the right adapter
// shape (owns manifest loading, returns a preflight sentinel on an
// unreadable/malformed manifest instead of throwing, per-gate try/catch), and
// was previously reachable only via the test-only `_internals` export below.
export function runGates(opts) {
  const { consumerRoot, gates } = opts;
  const manifestRes = loadConsumerManifest(consumerRoot);
  const results = [];

  const needManifest = gates.some((g) => ['2A', '2B', '2C', '3', '5', '6', '8', '9'].includes(g));
  if (needManifest && !manifestRes.ok) {
    return [{ gate: 'preflight', pass: false, error: manifestRes.error }];
  }
  const manifest = manifestRes.ok ? manifestRes.manifest : null;

  for (const g of gates) {
    try {
      if (g === '1') results.push(gate1(consumerRoot));
      else if (g === '2A') results.push(gate2A(consumerRoot, manifest));
      else if (g === '2B') results.push(gate2B(consumerRoot, manifest));
      else if (g === '2C') results.push(gate2C(consumerRoot, manifest));
      else if (g === '3') results.push(gate3(consumerRoot, manifest));
      else if (g === '4') results.push(gate4(consumerRoot));
      else if (g === '5') results.push(gate5(consumerRoot, manifest));
      else if (g === '6') results.push(gate6(manifest));
      else if (g === '7') results.push(gate7(consumerRoot));
      else if (g === '8') results.push(gate8(consumerRoot, manifest));
      else if (g === '9') results.push(gate9(consumerRoot, manifest));
      else results.push({ gate: g, pass: false, error: `unknown gate: ${g}` });
    } catch (err) {
      results.push({ gate: g, pass: false, error: `gate threw: ${err.message}` });
    }
  }
  return results;
}

function selfcheckInventoryNotAvailable() {
  process.stderr.write(
    '--selfcheck-inventory is source-side only. Run from the\n' +
    'claude-engineering-skills source repo: node scripts/check-isolation-inventory.mjs\n'
  );
  process.exit(2);
}

function formatText(results) {
  const lines = [];
  let allPass = true;
  for (const r of results) {
    if (r.pass) {
      lines.push(`  ✓ gate ${r.gate}`);
      // A PASS that excused something must say what it excused. Gate 2B skips
      // paths declared in `.sync-overrides.json`, and a bare `✓` would make a
      // standing divergence invisible in the default output — which is the
      // failure mode the override mechanism exists to end, reintroduced one
      // layer up. The JSON format already carried this; the text format is
      // what an operator actually reads.
      for (const h of r.details?.held ?? []) {
        lines.push(`     held  ${h.path} ${h.reason ? `(${String(h.reason).slice(0, 120)})` : ''}`);
      }
    } else {
      allPass = false;
      lines.push(`  ✗ gate ${r.gate}: ${r.error || '(no message)'}`);
      if (r.details) lines.push('     ' + JSON.stringify(r.details).slice(0, 400));
    }
  }
  return { text: lines.join('\n'), allPass };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.selfcheckRelocation) {
    console.log('OK');
    process.exit(0);
  }

  if (opts.selfcheckInventory) {
    selfcheckInventoryNotAvailable();
    return;
  }

  const results = runGates(opts);
  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
  } else {
    const { text, allPass } = formatText(results);
    process.stdout.write(text + '\n');
  }
  const firstFail = results.find((r) => !r.pass);
  if (firstFail) {
    const code = firstFail.gate === 'preflight' ? 2 : (Number.isFinite(+firstFail.gate) ? +firstFail.gate : 1);
    process.exit(code || 1);
  }
  process.exit(0);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((err) => {
    // A usage mistake (unknown/empty flag) is not a crash — same convention as
    // reconcile-repo-identity.mjs: print the diagnostic only, exit 2.
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
      return;
    }
    process.stderr.write(`[sync-isolation-verify] fatal: ${err?.message || err}\n`);
    process.exit(1);
  });
}

export const _internals = {
  CLI_SMOKE_SET, LIB_IMPORT_SET, CMD_SCAN_PATHS, COMMAND_REGEX,
  parseArgs, gate1, gate2A, gate2B, gate2C, gate3, gate4, gate5, gate6, gate7, gate8, gate9,
  ownedSkillNamesFromManifest, runGates,
};
