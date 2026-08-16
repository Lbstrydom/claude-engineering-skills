#!/usr/bin/env node
/**
 * @fileoverview Close-out coverage checker for a phased/clustered plan.
 *
 * Validates a changed-file diff against a plan's `### <N>b. Implementation
 * Phases` section — the single, exhaustive source for "which file belongs to
 * which phase" (each phase bullet's own `Files:` sentence). No parallel
 * `Phase` column on the plan's flat file table: that would be a second copy
 * of the same fact, the exact "two copies of one contract" shape this repo's
 * own plans correct wherever they find it.
 *
 * SCOPED coverage, not whole-plan coverage (`--phases`): a plan may declare
 * clusters that ship independently (its own §9/§11 Execution Clustering
 * truncation order), so requiring every phase's files to be present in every
 * partial release would refuse the plan's own recommended partial releases.
 * `--phases` names which phases this run actually completed; the checker
 * validates the diff against exactly that scope — nothing more, nothing less.
 *
 * A bracketed `[branch: key=value]` qualifier immediately after a backtick
 * file path inside a phase's `Files:` sentence marks that path as applying
 * under only one decision branch (e.g. Phase 7's UNIFY vs KEEP SEPARATE
 * outcome) — matched against `--branch key=value`. An unqualified path inside
 * an in-scope phase is unconditionally required.
 *
 * @module scripts/plan-file-coverage-check
 */

import fs from 'node:fs';
import path from 'node:path';
import { argOption, assertKnownFlags, emit } from './lib/cli-io.mjs';

const KNOWN_FLAGS = ['--plan', '--diff', '--phases', '--branch', '--selfcheck-relocation'];

/**
 * Every phase declared in the plan's Implementation Phases section, with the
 * files its own `Files:` sentence names.
 *
 * Phase heading shape: `- **Phase <id> — <title>.** ... Files: <list>.`
 * `<id>` may be a bare integer or a primed variant (`1′`) — both are valid
 * phase identifiers per this repo's own plans (role-agnostic-comparison-core
 * and this plan's own predecessor both use primed phases for "runs alongside
 * the previous phase, same commit range" insertions).
 *
 * A file path is any backtick-quoted token inside the phase's own bullet body
 * (from the `Files:` marker to the end of the bullet, i.e. up to the next
 * top-level `- **Phase` bullet or the section's end) that looks like a
 * relative repo path (contains at least one `/` or a recognisable extension).
 * Prose ("the 6 created test files") is deliberately NOT parsed as a count —
 * every phase's `Files:` sentence must name its files explicitly, or this
 * checker cannot see them. That is enforced by the phases below always
 * naming files literally, not a leniency this script provides.
 *
 * @param {string} planText
 * @returns {Map<string, Set<string>>} phaseId -> set of repo-relative paths
 */
export function parsePhaseFiles(planText) {
  const sectionMatch = planText.match(/^#{2,4} \d+[a-z]?\. Implementation Phases\s*$/m);
  if (!sectionMatch) {
    throw new Error('plan-file-coverage-check: no "Implementation Phases" heading found (expected e.g. "### 6b. Implementation Phases")');
  }
  const body = planText.slice(sectionMatch.index + sectionMatch[0].length);
  // Stop at the next top-level (##) heading, or end of file.
  const nextTopHeading = body.search(/^## /m);
  const section = nextTopHeading === -1 ? body : body.slice(0, nextTopHeading);

  // A phase bullet's END boundary is the next TOP-LEVEL `- **...` bullet of
  // ANY kind — not only the next "Phase" bullet. The last phase is otherwise
  // followed by non-phase bullets (e.g. "- **Close-out —") that legitimately
  // contain their own "Files:" mentions, and bled into the last phase's
  // bulletText when only "Phase" bullets were treated as boundaries — found
  // empirically: Phase 7's real Files: sentence was shadowed by a LATER
  // "Files:" mention inside the Close-out bullet.
  // Any top-level bold list item — `- **`, at column 0 — is a bullet
  // boundary. Only bullets literally starting "Phase <id>" carry a phase id;
  // every other top-level bullet (Close-out, etc.) still ends the PRECEDING
  // phase's text, it just contributes no phase of its own.
  const anyBulletStart = /^- \*\*(Phase (\S+))? ?/gm;
  const allStarts = [];
  let m;
  while ((m = anyBulletStart.exec(section)) !== null) {
    allStarts.push({ phaseId: m[2] ?? null, index: m.index });
  }
  const starts = allStarts.filter((s) => s.phaseId !== null);
  if (starts.length === 0) {
    throw new Error('plan-file-coverage-check: no "- **Phase <id> —" bullets found under Implementation Phases');
  }

  const phaseFiles = new Map();
  for (const { phaseId, index } of starts) {
    // The nearest bullet-start (of ANY kind) strictly after this phase's own
    // start is its end boundary.
    const next = allStarts.find((s) => s.index > index);
    const end = next ? next.index : section.length;
    const bulletText = section.slice(index, end);
    // LAST occurrence, not first: a phase's own explanatory prose may mention
    // the word `Files:` (in backticks, as a concept) before the real files
    // sentence — this bullet's own text does exactly that ("this section's
    // own `Files:` lists"), and `indexOf` found the decoy. The actual files
    // sentence is, by this plan's own convention, always the LAST "Files:"
    // mention in a phase bullet.
    const filesIdx = bulletText.lastIndexOf('Files:');
    if (filesIdx === -1) {
      throw new Error(`plan-file-coverage-check: Phase ${phaseId} bullet has no "Files:" sentence`);
    }
    // Files: sentence runs to the next blank-line-preceded paragraph break
    // ("\n\n") or the end of the bullet — whichever comes first, so a
    // trailing blockquote (">") explaining the phase does not get scanned
    // for paths.
    const afterFiles = bulletText.slice(filesIdx);
    const paraBreak = afterFiles.indexOf('\n\n');
    const filesSentence = paraBreak === -1 ? afterFiles : afterFiles.slice(0, paraBreak);

    const entries = [];
    // `lastAcceptedEnd` tracks the end position of the last ACCEPTED path
    // only — deliberately separate from "the last backtick token seen"
    // (round-4 finding M11). A `[branch: …]` tag must attach only to a path
    // it is ACTUALLY adjacent to; using the last-seen-token position let a
    // REJECTED decoy token (prose like `resolved.arms`) sitting between a
    // real path and a branch tag "absorb" the gap, so the tag was silently
    // attached to a real path it was nowhere near — misclassifying an
    // unconditional file as conditional.
    let lastAcceptedEnd = -1;
    for (const match of filesSentence.matchAll(/`([^`]+)`/g)) {
      const p = match[1];
      // A `[branch: key=value]` qualifier is itself backtick-quoted (matching
      // this repo's own convention of backtick-wrapping structured tokens)
      // and immediately follows the path it qualifies, separated only by
      // whitespace — attach it to the PRECEDING entry rather than treating it
      // as a path of its own.
      const branchTag = p.match(/^\[branch:\s*([^=]+)=([^\]]+)\]$/);
      if (branchTag) {
        const gap = filesSentence.slice(lastAcceptedEnd, match.index);
        if (entries.length > 0 && /^\s*$/.test(gap)) {
          entries[entries.length - 1].branch = { key: branchTag[1].trim(), value: branchTag[2].trim() };
        }
        continue; // a branch tag never becomes lastAcceptedEnd — it isn't a path
      }
      // A path candidate needs a `/` (a real directory) OR a recognised file
      // extension — NOT merely "contains a dot". Found empirically (M9/self-
      // dogfooding, twice, authoring this very plan's Phase 2/3 bullets): a
      // backtick-quoted property-access expression inside a Files: sentence's
      // own explanatory prose (`resolved.arms`, `loadCampaign().arms`) has a
      // dot but is not a path, and the OLD `/[/.]/`. test let it through,
      // reported as a phantom "missing" file. Tightened without narrowing the
      // legitimate case: every real Files: entry in this plan already has a
      // `/` (nothing lives at repo root) or ends `.mjs`/`.md`/`.json`/`.js`.
      const looksLikePath = p.includes('/') || /\.(mjs|m?js|json|md)$/i.test(p);
      if (!(looksLikePath && !p.includes(' ') && !p.startsWith('--'))) continue;
      entries.push({ path: p, branch: null });
      lastAcceptedEnd = match.index + match[0].length;
    }
    const list = phaseFiles.get(phaseId) ?? [];
    // De-duplicate by (path, branch) — a phase whose Files: sentence repeats
    // a path (never observed, but not asserted against) must not double-count.
    for (const e of entries) {
      if (!list.some((x) => x.path === e.path && x.branch?.key === e.branch?.key && x.branch?.value === e.branch?.value)) {
        list.push(e);
      }
    }
    phaseFiles.set(phaseId, list);
  }
  return phaseFiles;
}

/**
 * @param {Map<string, Array<{path: string, branch: {key:string,value:string}|null}>>} phaseFiles
 * @param {string[]} requestedPhases
 * @param {{key: string, value: string}|null} activeBranch
 * @returns {{requiredFiles: Set<string>, unknownPhases: string[]}}
 */
export function resolveScope(phaseFiles, requestedPhases, activeBranch = null) {
  const requiredFiles = new Set();
  const unknownPhases = [];
  for (const p of requestedPhases) {
    const entries = phaseFiles.get(p);
    if (!entries) { unknownPhases.push(p); continue; }
    for (const { path: filePath, branch } of entries) {
      if (branch === null) { requiredFiles.add(filePath); continue; }
      // A branch-qualified row is required ONLY when the caller's --branch
      // names the matching key=value — the branch NOT taken never appears in
      // the diff, correctly, so it must never be required either.
      if (activeBranch && activeBranch.key === branch.key && activeBranch.value === branch.value) {
        requiredFiles.add(filePath);
      }
    }
  }
  return { requiredFiles, unknownPhases };
}

/**
 * Compare a diff's file set against the resolved required set.
 *
 * @param {{diffFiles: string[], requiredFiles: Set<string>}} args
 * @returns {{missing: string[], unexpected: string[], ok: boolean}}
 */
export function checkCoverage({ diffFiles, requiredFiles }) {
  const diffSet = new Set(diffFiles);
  const missing = [...requiredFiles].filter((f) => !diffSet.has(f)).sort();
  const unexpected = [...diffSet].filter((f) => !requiredFiles.has(f)).sort();
  return { missing, unexpected, ok: missing.length === 0 && unexpected.length === 0 };
}

function parseCsvList(raw) {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function main() {
  // Literal string, not routed through argOption — see model-eval-auditor.mjs's
  // own comment for why this must not be routed through a flag-name helper.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'plan-file-coverage-check' });

  const planPath = argOption('plan');
  const diffRaw = argOption('diff');
  const phasesRaw = argOption('phases');
  const branchRaw = argOption('branch'); // "key=value", optional

  if (!planPath || !fs.existsSync(planPath)) {
    emit({ ok: false, error: `--plan "${planPath}" does not exist or was not given` });
    return;
  }
  if (!phasesRaw) {
    emit({ ok: false, error: '--phases is required — e.g. --phases 0,1,1′ for an A+A′-only release' });
    return;
  }

  const planText = fs.readFileSync(path.resolve(planPath), 'utf-8');
  let phaseFiles;
  try {
    phaseFiles = parsePhaseFiles(planText);
  } catch (err) {
    emit({ ok: false, error: err.message });
    return;
  }

  let activeBranch = null;
  if (branchRaw) {
    const eq = branchRaw.indexOf('=');
    if (eq === -1) {
      emit({ ok: false, error: `--branch "${branchRaw}" is not "key=value"` });
      return;
    }
    activeBranch = { key: branchRaw.slice(0, eq).trim(), value: branchRaw.slice(eq + 1).trim() };
  }

  const requestedPhases = parseCsvList(phasesRaw);
  const { requiredFiles, unknownPhases } = resolveScope(phaseFiles, requestedPhases, activeBranch);
  if (unknownPhases.length > 0) {
    emit({
      ok: false,
      error: `--phases named ${JSON.stringify(unknownPhases)}, which do not exist in the plan's Implementation Phases section`,
      knownPhases: [...phaseFiles.keys()],
    });
    return;
  }

  // diffRaw accepts newline- or comma-separated paths (git diff --name-only
  // output uses newlines; callers composing a list by hand may prefer commas).
  const diffFiles = (diffRaw ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

  const { missing, unexpected, ok } = checkCoverage({ diffFiles, requiredFiles });

  emit({
    ok,
    phases: requestedPhases,
    branch: branchRaw ?? null,
    requiredCount: requiredFiles.size,
    diffCount: diffFiles.length,
    missing,
    unexpected,
  });
}

// Guarded so a test file can `import { parsePhaseFiles, ... }` for unit
// testing without also triggering main() against the TEST RUNNER's own argv
// (`node --test ...`) — assertKnownFlags would reject `--test` and abort the
// import. Same pattern as check-plan-status.mjs.
const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();
if (isMain) main();
