#!/usr/bin/env node
/**
 * @fileoverview Every gate in the `check` chain must PROVE it can fail.
 *
 * A gate that has never been observed failing is not evidence. On 2026-07-31
 * `build-manifest --check` compared only `bundleVersion`/`schemaVersion` and returned OK
 * having authenticated almost nothing — and the finding was then dismissed by reading the
 * WRITE path's byte-comparison, i.e. verifying the wrong branch. Both the gate and its
 * reviewer were green about a check that wasn't happening.
 *
 * So each contracted gate declares a **poison pill**: a deliberately broken artifact it
 * must reject, plus a **control** run it must accept.
 *
 * Two runs per gate, and both are load-bearing:
 *   - **control**  — the gate against an un-overlaid copy MUST exit 0. Without it a broken
 *     harness (unreadable fixture, bad argv, missing dependency) reads as a working pill:
 *     the pill "passes" because the gate crashed, never having examined anything. That is
 *     the poison pill contracting the disease it tests for.
 *   - **poison**   — the gate against the overlaid copy MUST exit non-zero AND its stderr
 *     must match `expectStderr`, the gate's OWN failure message. Exit code alone cannot
 *     distinguish "detected the tampering" from "crashed".
 *
 * Isolation covers OUTPUTS, not just inputs: every pill runs against a temp copy of the
 * repo, and the real working tree is asserted byte-identical afterwards.
 *
 * Plan: docs/plans/green-but-unrealized.md (Cluster B, Phase 3).
 *
 * @module scripts/check-gate-poison-pills
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCliGateContracts } from './lib/gate-honesty/loader.mjs';
import { runWithConcurrency } from './lib/concurrency.mjs';
// Shared with prepush-check.mjs since 2026-08-11 — the same worktree defect was
// found there. One walk, so there is one place to regress it.
import { findNodeModules } from './lib/node-modules-resolver.mjs';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const CONTRACTS_DIR = path.join(REPO_ROOT, 'scripts', 'gate-contracts');
const EXEMPTIONS = path.join(CONTRACTS_DIR, '_exemptions.json');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', X = '\x1b[0m';

// ── Terminal-gate extraction ────────────────────────────────────────────────

/**
 * Every terminal command the `check` chain reaches, following `npm run` TRANSITIVELY.
 *
 * Matches ANY `node …` invocation, not only `node scripts/<x>.mjs`: the `test` gate is
 * `node --test tests/**`, and a `scripts/`-prefixed matcher would fail to resolve it and
 * trip the hard error below on a legitimately exempt entry.
 *
 * A node it cannot resolve to either a terminal `node` command or a further `npm run` is a
 * HARD ERROR, never a silently dropped gate — a parse that quietly ignores a wrapper
 * under-counts the gate set, which is this whole file's failure mode turned on itself.
 */
export function extractCheckGates(scripts, entry = 'check', seen = new Set()) {
  const out = [];
  const walk = (name) => {
    if (seen.has(name)) return;                       // cycle guard
    seen.add(name);
    const body = scripts[name];
    if (body === undefined) throw new Error(`gate extraction: npm script "${name}" does not exist`);

    for (const part of body.split('&&').map((p) => p.trim()).filter(Boolean)) {
      // Only `&&` is split. Any OTHER shell operator would chain further commands this
      // parser cannot see: `npm run a ; npm run b` matched `a` with an unanchored regex and
      // dropped `b` entirely, so the dropped gate was never reconciled against a contract
      // or an exemption — a silent under-count in the function whose whole purpose is
      // refusing silent under-counts (consolidated Gemini gate, round 1). Refused rather
      // than parsed: becoming a shell is not the job.
      if (/[;|&`]|\$\(/.test(part)) {
        throw new Error(
          `gate extraction: npm script "${name}" contains a shell operator in "${part}". `
          + 'Only `&&` is understood; anything else could chain commands this parser cannot '
          + 'see, and a dropped command is a gate nobody decided about. Split the script.',
        );
      }
      // `npm run <x>` AND npm's lifecycle shorthands (`npm test` === `npm run test`,
      // likewise start/stop/restart). Matching only the long form made the extractor
      // hard-error on this repo's own `check` chain, which ends in `npm test` — the
      // under-count this function exists to refuse, in the function that refuses it.
      // Anchored: a trailing remainder is a command, not decoration.
      const run = /^npm (?:run\s+)?([\w:.-]+)\s*$/.exec(part);
      if (run) { walk(run[1]); continue; }
      // ANY other terminal command is a gate. Requiring `node …` meant a gate added as a
      // bare binary (`eslint .`, `tsc --noEmit`, `./scripts/foo.sh`) could not be
      // represented at all: it hard-errored, so the only way to add one to `check` was to
      // break this gate. "A decision per gate" has to include gates we did not author.
      out.push({ script: name, command: part });
    }
  };
  walk(entry);
  return out;
}

// ── Contracts ───────────────────────────────────────────────────────────────

/**
 * Contracts come through the SHARED loader + schema (`lib/gate-honesty/`), never a private
 * parser here. This file is the RUNNER — it executes pills; it is not a second contract
 * system with the same name. `check-gate-contracts.mjs` validates the same files with the
 * same code, so a rule added to the vocabulary cannot apply to only one half.
 *
 * Each returned entry is flattened to one pill: `{script, file, id, poisonPill, needsGit}`.
 */
export function loadContracts(dir = CONTRACTS_DIR, repoRoot = REPO_ROOT) {
  const { contracted, divergences } = loadCliGateContracts({ contractsRoot: dir, repoRoot });
  if (divergences.length) {
    throw new Error(`invalid CLI gate contract(s):\n  ${divergences.join('\n  ')}`);
  }
  return contracted.flatMap((c) => c.gates
    .filter((g) => g.oracle === 'poison-pill')
    .map((g) => ({
      script: c.gate, file: c.file, id: g.id,
      poisonPill: g.poisonPill, needsGit: g.poisonPill.needsGit === true,
    })));
}

/**
 * The date on and after which a gate must carry a PILL rather than an exemption.
 * Policy source: docs/plans/green-but-unrealized.md §2 decision 3, previously
 * stated only in `_exemptions.json`'s `_comment` — i.e. enforced by nobody.
 *
 * Compared as an ISO-8601 STRING, never through `Date`: `YYYY-MM-DD` sorts
 * correctly lexicographically, which removes timezone and DST from a gate whose
 * whole job is to be unambiguous.
 */
export const POLICY_CUTOFF = '2026-07-31';

/** `YYYY-MM-DD`, and a real calendar day — `2026-02-30` must not normalise to March 2. */
function isCalendarDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** How an entry's `gateAddedAt` was established. Closed set — unknown is a failure. */
const ADDED_AT_SOURCES = new Set(['git-log-S', 'unknown']);

/**
 * Validate + load the exemption registry.
 *
 * **Why this is not a bare `JSON.parse`.** The half of this registry that PROVES a
 * gate can fail (`loadContracts`, above) is schema-validated through the shared
 * loader and THROWS on divergence. The half that GRANTS A PASS was
 * `JSON.parse(...).exempt ?? {}` — so `""`, `true`, `null` or `{}` was accepted
 * as a reason and silently exempted a gate with no written justification. An
 * asymmetry in that direction is the fake-check class this file exists to catch,
 * in this file's own bookkeeping (adjudicated finding D3).
 *
 * Throws with EVERY divergence listed, mirroring `loadContracts` — a loader that
 * reports one problem per run turns a 17-entry migration into 17 runs.
 */
export function loadExemptions(file = EXEMPTIONS) {
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')).exempt ?? {};
  const bad = [];
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      bad.push(`${key}: expected {reason, gateAddedAt, gateAddedAtSource}, got ${Array.isArray(value) ? 'array' : JSON.stringify(value)}`);
      continue;
    }
    if (typeof value.reason !== 'string' || value.reason.trim() === '') {
      bad.push(`${key}: "reason" must be a non-empty string — an exemption without a written reason is an unexplained pass`);
    }
    if (!isCalendarDate(value.gateAddedAt)) {
      // NOT defaulted to "old": treating a missing date as grandfathered is the
      // fail-open direction, and the ratchet's only predicate is this field.
      bad.push(`${key}: "gateAddedAt" must be a real calendar date YYYY-MM-DD, got ${JSON.stringify(value.gateAddedAt)}`);
    }
    if (!ADDED_AT_SOURCES.has(value.gateAddedAtSource)) {
      bad.push(`${key}: "gateAddedAtSource" must be one of ${[...ADDED_AT_SOURCES].join('|')}, got ${JSON.stringify(value.gateAddedAtSource)}`);
    }
    if (value.policyOverride !== undefined
      && (typeof value.policyOverride !== 'string' || value.policyOverride.trim() === '')) {
      bad.push(`${key}: "policyOverride", when present, must be a non-empty reason`);
    }
    out[key] = value;
  }
  if (bad.length) {
    throw new Error(`invalid gate exemption(s) in ${file}:\n  ${bad.join('\n  ')}`);
  }
  return out;
}

/**
 * Exemptions the mandatory-pill policy forbids: the GATE was added on or after the
 * cutoff (so the policy requires a pill) and no `policyOverride` justifies the
 * exception. Returns `[{key, gateAddedAt}]`.
 *
 * **`gateAddedAt` is when the GATE entered `package.json`, not when its exemption
 * was written** — a distinction the data forced. Deriving from the exemption
 * registry's own history dated all 17 entries `2026-08-01` (the day the file was
 * created), which is after the cutoff, so every grandfathered entry would have
 * been "forbidden" and the ratchet would have failed on its own migration. The
 * policy's subject is the gate's age; the registry's age is an artifact of when
 * someone wrote it down.
 *
 * Deliberately NOT tamper-proof. `gateAddedAt` is self-reported and could be
 * backdated; this is a speed bump against *accident* — appending an entry without
 * realising the policy applies — and the real control is that the field sits in a
 * reviewed diff. A ratchet advertised as unbypassable would be one more
 * stated-but-unenforced mechanism, inside the fix for stated-but-unenforced
 * mechanisms.
 */
/**
 * Re-derive each exemption's `gateAddedAt` from git and compare it to what the
 * registry claims. Returns `{divergences, unverified}`.
 *
 * **Why this exists (audit clusterB-H2/H3).** Without it, `gateAddedAtSource:
 * "git-log-S"` is a LABEL asserting a provenance nothing checks — a
 * stated-but-unenforced claim, inside the change whose entire subject is
 * stated-but-unenforced claims. A new gate could be entered with an old date and
 * an authoritative-looking source string and sail past the ratchet.
 *
 * The derivation is the same command the migration used: the OLDEST commit that
 * changed the number of occurrences of `"<key>":` in `package.json` — i.e. when
 * the gate entered the script table.
 *
 * **A failed derivation is `unverified`, never a pass.** No git, a shallow clone
 * with no history, or a key that never appears in `package.json` all mean "we did
 * not check", which the caller must report rather than silently treat as agreement
 * — the anti-green rule this file exists to enforce, applied to its own evidence.
 *
 * @param {Record<string, object>} exemptions
 * @param {{repoRoot?: string, run?: typeof spawnSync}} [deps]
 */
export function verifyExemptionProvenance(exemptions, { repoRoot = REPO_ROOT, run = spawnSync } = {}) {
  const divergences = [];
  const unverified = [];
  for (const [key, v] of Object.entries(exemptions)) {
    if (v?.gateAddedAtSource !== 'git-log-S') { unverified.push({ key, why: `source is ${v?.gateAddedAtSource}` }); continue; }
    const r = run('git', ['log', '--format=%ad', '--date=short', '-S', `"${key}":`, '--', 'package.json'],
      { cwd: repoRoot, encoding: 'utf-8', windowsHide: true });
    if (r.error || r.status !== 0) { unverified.push({ key, why: `git failed: ${r.error?.message ?? `exit ${r.status}`}` }); continue; }
    const dates = String(r.stdout || '').trim().split('\n').map((s) => s.trim()).filter(Boolean);
    const derived = dates[dates.length - 1];
    if (!derived) { unverified.push({ key, why: 'no commit in package.json history changed this key' }); continue; }
    if (derived !== v.gateAddedAt) {
      divergences.push({ key, claimed: v.gateAddedAt, derived });
    }
  }
  return { divergences, unverified };
}

export function forbiddenNewExemptions(exemptions, cutoff = POLICY_CUTOFF) {
  return Object.entries(exemptions)
    .filter(([, v]) => typeof v?.gateAddedAt === 'string' && v.gateAddedAt >= cutoff)
    .filter(([, v]) => !(typeof v?.policyOverride === 'string' && v.policyOverride.trim() !== ''))
    .map(([key, v]) => ({ key, gateAddedAt: v.gateAddedAt }));
}

/**
 * `node scripts/x.mjs --check` → `scripts/x.mjs --check`: the comparable identity of a
 * command, whitespace-normalised and unquoted.
 *
 * Quotes are stripped per token because the two sides arrive differently: a package.json
 * script keeps them (`--msg "hello world"`) while a contract's `argv` array is already
 * split, so the strings would never match and the gate would read as undeclared.
 */
function commandArgv(command) {
  return String(command).replace(/^node\s+/, '').trim().split(/\s+/)
    .map((t) => t.replace(/^(['"])(.*)\1$/, '$2'))
    .join(' ');
}

/**
 * Every `check`-chain gate must be contracted or explicitly exempt — a DECISION per gate,
 * where **a gate is one terminal command, not one npm script**.
 *
 * The distinction is load-bearing and was found by this plan's own code audit. `skills:check`
 * runs six commands; contracting it by script name meant one pill (over `build-manifest
 * --check`) silently accounted for all six, so five real checks were counted as covered by
 * evidence that never touched them. That is a gate claiming a check it never ran — the class
 * this file exists to remove, in this file's own bookkeeping.
 *
 * A contract covers the command its pill's `argv` actually runs. An exemption may be keyed
 * by script name (covering that script's commands) or by an exact command, so an aggregate
 * script can pill one member and exempt the rest with individual reasons.
 */
export function reconcile(gates, contracts, exemptions) {
  const pilled = new Set(contracts.map((c) => commandArgv(c.poisonPill.argv.join(' '))));
  const commandCount = new Map();
  for (const g of gates) commandCount.set(g.script, (commandCount.get(g.script) ?? 0) + 1);

  const undeclared = [];
  for (const g of gates) {
    if (pilled.has(commandArgv(g.command))) continue;
    // A SCRIPT-level exemption covers a script that runs exactly one command. On an
    // aggregate it would do the very thing this function was just fixed to stop: one entry
    // accounting for six commands, so a seventh added later inherits an exemption written
    // about something else (consolidated Gemini gate, shadow M). Aggregates must decide
    // per command.
    if (Object.hasOwn(exemptions, g.script) && commandCount.get(g.script) === 1) continue;
    if (Object.hasOwn(exemptions, g.command)) continue;
    undeclared.push(g.command);
  }
  // A contract whose pill runs a command the chain never reaches proves nothing about the
  // chain — it is a pill for a gate that is not a gate.
  const reachable = new Set(gates.map((g) => commandArgv(g.command)));
  const orphaned = contracts
    .filter((c) => !reachable.has(commandArgv(c.poisonPill.argv.join(' '))))
    .map((c) => `${c.script} (${c.poisonPill.argv.join(' ')})`);
  return { undeclared: [...new Set(undeclared)], orphaned };
}

// ── Pill execution ──────────────────────────────────────────────────────────

/**
 * The files git TRACKS, contents read from the working tree.
 *
 * **Tracked, not everything** — one enumeration used for both the copy and the `needsGit`
 * index, because a superset in either place silently changes the SUBJECT of any gate that
 * enumerates its own inputs. A blanket walk copies whatever other work happens to be sitting
 * in the tree: a concurrent session's untracked plan made `plans:index:check` render 11
 * active plans against the committed 9, and its control run read as genuine staleness of an
 * artifact that was in fact fresh. Contents come from disk (not `HEAD`) so an uncommitted
 * edit to a gate IS exercised; only files that no commit contains are excluded.
 */
function listTracked(repoRoot) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf-8', windowsHide: true });
  if (r.status !== 0) return null;
  return String(r.stdout || '').split('\0').filter(Boolean);
}

function copyTracked(repoRoot, files, dest) {
  for (const rel of files) {
    const s = path.join(repoRoot, rel), d = path.join(dest, rel);
    if (!fs.existsSync(s)) continue;                    // tracked-but-deleted in the tree
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
  }
}

/**
 * Tamper with one JSON field of an artifact IN PLACE — the second poison shape.
 *
 * `overlay` (a committed snapshot) is right for artifacts that are stable: an index, a
 * requirements map, a migration, `CLAUDE.md`. It is wrong for one that regenerates on every
 * edit to its inputs. `skills.manifest.json` carries a `bundleVersion` digest, and the
 * property its pill must prove is "versions match, CONTENT differs" — so a snapshot fixture
 * stops matching the live digest the moment any skill changes, and the pill goes red for a
 * reason that has nothing to do with the gate. A gate that cries wolf gets bypassed, which
 * is a worse outcome than the rot it was guarding against.
 *
 * So `mutate` derives the poison from the artifact as it stands: read, change ONE field,
 * write back. `path` is a dot/index path (`skills.plan.files.0.sha`). The field must already
 * exist and the value must actually change — either failure means the pill is no longer
 * tampering with anything, which is a false green in the making.
 *
 * @returns {true|string} `true`, or the reason it could not be applied
 */
function applyMutation(destAbs, edit) {
  if (!fs.existsSync(destAbs)) return 'destination does not exist — nothing to tamper with';
  if (!edit || typeof edit.path !== 'string' || !('value' in edit)) return 'needs {path, value}';

  const original = fs.readFileSync(destAbs, 'utf-8');
  let doc;
  try { doc = JSON.parse(original); } catch (err) { return `not JSON (${err.message})`; }

  // Writing back means RE-SERIALIZING, so the artifact's own formatting must already be
  // what we would produce — otherwise the gate rejects the reformatting rather than the
  // tampering, and the pill passes for a reason that has nothing to do with the field it
  // changed. Checked, not assumed: this is a pill, and a pill that fails for the wrong
  // reason is the failure mode the whole file exists to refuse.
  if (serialize(doc) !== normaliseEol(original)) {
    return 'the artifact\'s on-disk formatting differs from JSON.stringify(…, null, 2) + "\\n", '
      + 'so re-serializing would itself change the file — use an `overlay` fixture instead';
  }

  const keys = edit.path.split('.');
  const leaf = keys.pop();
  let node = doc;
  for (const k of keys) {
    if (node === null || typeof node !== 'object' || !(k in node)) return `path "${edit.path}" does not exist`;
    node = node[k];
  }
  if (node === null || typeof node !== 'object' || !(leaf in node)) return `path "${edit.path}" does not exist`;
  if (node[leaf] === edit.value) {
    return `"${edit.path}" already equals the poison value — the artifact would be unchanged, `
      + 'so the gate would be handed a pristine file and "pass" having detected nothing';
  }
  node[leaf] = edit.value;
  fs.writeFileSync(destAbs, serialize(doc));
  return true;
}

const serialize = (doc) => `${JSON.stringify(doc, null, 2)}\n`;
/** CRLF→LF before any byte comparison — see the same rule in gate-honesty/schema.mjs. */
const normaliseEol = (text) => text.replace(/\r\n/g, '\n');

/** Private helpers exposed for direct test coverage (mirrors `file-io.mjs`, `shared.mjs`). */
export const _internals = { applyMutation, listTracked, copyTracked, findNodeModules };

/**
 * Run one contract's control + poison pair inside an isolated copy.
 * @returns {{ok: boolean, problems: string[]}}
 */
export function runPill(contract, { repoRoot = REPO_ROOT, tmpRoot } = {}) {
  const problems = [];
  const pill = contract.poisonPill;
  if (!pill) return { ok: true, problems: [] };       // contracted but no pill declared

  if (pill.isolation !== 'tmpdir') {
    problems.push(`${contract.script}: isolation must be "tmpdir" (got ${JSON.stringify(pill.isolation)}) — `
      + 'a gate that can write must not run against the real working tree');
    return { ok: false, problems };
  }

  // Disposable within the run (deleted in the `finally`), so os.tmpdir() — not scratchPath.
  const work = tmpRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ces-pill-'));
  try {
    const tracked = listTracked(repoRoot);
    if (!tracked) {
      problems.push(`${contract.script}: could not enumerate tracked files — the isolated copy `
        + 'would be a walk of whatever is in the tree, not of the repo');
      return { ok: false, problems };
    }
    fs.mkdirSync(work, { recursive: true });
    copyTracked(repoRoot, tracked, work);
    // `node_modules` is SKIPPED by copyTree (it is huge) — so link it, or every gate dies
    // with ERR_MODULE_NOT_FOUND before reading its artifact. The control run caught exactly
    // that on the first execution of this file: a crash that, without a control, would have
    // read as "the poison pill passed". Junction on Windows, symlink elsewhere; a copy is
    // the fallback nobody should need.
    const modulesDir = findNodeModules(repoRoot);
    if (!modulesDir) {
      problems.push(`${contract.script}: no node_modules found at or above ${repoRoot} — the isolated `
        + 'copy would have no dependencies, so every gate dies on ERR_MODULE_NOT_FOUND before it reads '
        + 'its artifact. Run `npm install` in this checkout.');
      return { ok: false, problems };
    }
    const linkPath = path.join(work, 'node_modules');
    try {
      fs.symlinkSync(modulesDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      problems.push(`${contract.script}: could not link node_modules into the isolated copy (${err.code}) — `
        + 'the gate would fail on a missing dependency rather than on its artifact');
      return { ok: false, problems };
    }
    // A junction to a MISSING target succeeds on Windows and leaves a dangling link, so the
    // catch above is not proof the link works. Verified 2026-08-08:
    // `fs.symlinkSync(missing, link, 'junction')` returns normally and `existsSync(link)` is
    // false. Without this the only symptom was the control run failing with a bare
    // `Cannot find package 'zod'` — a message that points at the gate under test rather than
    // at the harness that fed it. Assert the link RESOLVES, not merely that creating it threw
    // nothing.
    if (!fs.existsSync(linkPath)) {
      problems.push(`${contract.script}: the node_modules link at ${linkPath} does not resolve `
        + `(dangling link to ${modulesDir}) — the gate would die on a missing dependency and the `
        + 'failure would read as a defect in the gate rather than in this harness');
      return { ok: false, problems };
    }

    // Some gates enumerate their subject via `git ls-files` rather than a directory walk,
    // so they need the copy to BE a repo. Opt-in (`needsGit`) rather than always: copying
    // `.git` is expensive and most gates never shell out to git. Found — again — by the
    // control run, which is now three-for-three at catching a harness that would otherwise
    // have made a crash look like a passing pill.
    if (contract.needsGit) {
      const g = (args) => spawnSync('git', args, { cwd: work, encoding: 'utf-8', windowsHide: true });
      g(['init', '-q']);
      g(['config', 'user.email', 'pill@example.com']);
      g(['config', 'user.name', 'pill']);
      // Add exactly the files git TRACKS UPSTREAM — never `-A`, and the SAME list the copy
      // was built from, so the index and the tree cannot describe different repos.
      const files = tracked.filter((f) => fs.existsSync(path.join(work, f)));
      for (let i = 0; i < files.length; i += 200) {
        g(['add', '--', ...files.slice(i, i + 200)]);   // chunked: argv length limits
      }
      const commit = g(['commit', '-q', '-m', 'pill fixture']);
      if (commit.status !== 0) {
        problems.push(`${contract.script}: could not create the isolated git fixture — `
          + `${(commit.stderr || '').trim().slice(0, 160)}`);
        return { ok: false, problems };
      }
    }

    // A gate script that is not yet committed is absent from the tracked copy, and the
    // control would fail as a bare MODULE_NOT_FOUND. Name the real cause instead.
    const entry = pill.argv.find((a) => !a.startsWith('-'));
    if (entry && !fs.existsSync(path.join(work, entry))) {
      problems.push(`${contract.script}: "${entry}" is not tracked by git, so it is absent from the `
        + 'isolated copy. Commit the gate script before contracting it — an uncommitted gate is '
        + 'not in the chain the pre-push sandbox runs.');
      return { ok: false, problems };
    }

    // ── control: un-overlaid copy MUST pass ──
    const control = spawnSync(process.execPath, pill.argv, { cwd: work, encoding: 'utf-8', timeout: 120_000 });
    if (control.status !== 0) {
      problems.push(
        `${contract.script}: CONTROL run failed (exit ${control.status}) on an unmodified copy — `
        + 'the harness is not feeding the gate correctly, so a "passing" poison run would prove nothing. '
        + `stderr: ${(control.stderr || '').trim().slice(0, 200)}`,
      );
      return { ok: false, problems };
    }

    // ── poison: tamper, then the gate MUST reject ──
    for (const [dest, fixture] of Object.entries(pill.overlay ?? {})) {
      const destAbs = path.join(work, dest);
      if (!fs.existsSync(destAbs)) {
        problems.push(`${contract.script}: overlay destination "${dest}" does not exist — `
          + 'the fixture would be an orphan the gate never reads');
        return { ok: false, problems };
      }
      fs.copyFileSync(path.join(repoRoot, fixture), destAbs);
    }
    for (const [dest, edit] of Object.entries(pill.mutate ?? {})) {
      const applied = applyMutation(path.join(work, dest), edit);
      if (applied !== true) {
        problems.push(`${contract.script}: mutate "${dest}" — ${applied}`);
        return { ok: false, problems };
      }
    }

    const poison = spawnSync(process.execPath, pill.argv, { cwd: work, encoding: 'utf-8', timeout: 120_000 });
    if (poison.status === 0) {
      problems.push(`${contract.script}: POISON run PASSED — the gate did not detect its own broken artifact`);
    }
    const stderr = `${poison.stderr || ''}${poison.stdout || ''}`;
    if (pill.expectStderr && !stderr.includes(pill.expectStderr)) {
      problems.push(
        `${contract.script}: poison run failed, but not for the expected reason — `
        + `stderr did not contain ${JSON.stringify(pill.expectStderr)}. `
        + 'Exit code alone cannot distinguish "detected the tampering" from "crashed".',
      );
    }
  } finally {
    if (!tmpRoot) fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  return { ok: problems.length === 0, problems };
}

// ── Parallel execution ──────────────────────────────────────────────────────
//
// The pills were run in a `for` loop around a synchronous `runPill`. Measured
// 2026-08-11 on a 32-core box: 53.2s for 10 pills — 33% of the whole `check`
// chain, the second-largest line item after the test suite. Each pill copies the
// full tracked file set (1,934 files, ~1.35s) into its own tmpdir and then
// spawns the gate twice, so the loop was ten repo copies and twenty node
// processes, strictly one at a time.
//
// They are already fully isolated — own tmpdir, own `node_modules` link, own
// optional git fixture, own processes — which is precisely the property that
// makes them embarrassingly parallel. Nothing about the CONTRACT changes here:
// each pill still runs its control and then its poison, in that order, against
// its own copy.
//
// **Processes, not promises.** The dominant cost is `copyTracked`, which is
// synchronous `fs.copyFileSync` — parallelising only the spawns would leave the
// copies serialised on the one thread and buy back a third of the time at most.
// Forking also keeps `runPill` exactly as it was: synchronous, exported, and
// covered by the tests that call it directly.

/** Internal fork mode — see `runPillWorker`. Not for hand invocation. */
const WORKER_FLAG = '--pill-worker';

/**
 * How many pills run at once. `os.cpus().length - 2` leaves headroom for the
 * parent and the OS; capped at the pill count, floored at 1 so a 2-core machine
 * still makes progress.
 *
 * `GATES_POISON_CONCURRENCY=1` restores the old serial-in-parallel-clothing
 * behaviour. That is a debugging affordance, not a tuning knob: when a pill
 * misbehaves, being able to remove interleaving from the picture without editing
 * the gate is the difference between a diagnosis and a guess.
 */
export function resolveConcurrency(pillCount, env = process.env, cpuCount = os.cpus().length) {
  const override = Number.parseInt(env.GATES_POISON_CONCURRENCY ?? '', 10);
  const requested = Number.isInteger(override) && override > 0 ? override : cpuCount - 2;
  return Math.max(1, Math.min(requested, Math.max(1, pillCount)));
}

/**
 * The child half of the fork: run ONE pill and hand the result back over IPC.
 *
 * Reports a thrown `runPill` as a problem rather than letting it become a bare
 * non-zero exit. Both paths fail the gate — but a crash the parent has to infer
 * from an exit code says only "worker 4 died", while this says which contract
 * and why.
 */
function runPillWorker() {
  return new Promise((resolve) => {
    process.on('message', (msg) => {
      let result;
      try {
        result = runPill(msg.contract);
      } catch (err) {
        result = {
          ok: false,
          problems: [`${msg.contract?.script ?? '(unknown gate)'}: pill worker threw — ${err?.stack || err}`],
        };
      }
      // Close the channel only once the message is on it. `process.send` is
      // asynchronous, so exiting (or disconnecting) immediately can drop it —
      // and a dropped result is indistinguishable, from the parent, from a
      // worker that died mid-pill. Disconnecting rather than `process.exit` lets
      // the child unwind normally; with no other handles open it exits 0.
      process.send(result, () => {
        try { process.disconnect(); } catch { /* parent already tore it down */ }
        resolve(result);
      });
    });
  });
}

/**
 * Run every pill across a bounded pool of forked workers.
 *
 * Three properties this must not lose relative to the loop it replaces:
 *
 *  1. **Deterministic output.** Problems are written into a positional slot and
 *     flattened in CONTRACT order at the end, so the report is byte-identical
 *     whichever pill finishes first. A gate whose output reorders run-to-run
 *     cannot be diffed, and an operator learns to skim it.
 *  2. **A crashed worker FAILS the gate.** A worker that exits without sending a
 *     result, is killed by a signal, or cannot be spawned becomes a problem
 *     attributed to its contract — never an empty slot. Silently dropping it
 *     would be this file's own subject: a green produced by not checking.
 *  3. **Control-then-poison per pill** is `runPill`'s business and is untouched.
 *
 * @param {object[]} contracts
 * @param {{concurrency?: number, fork?: typeof fork}} [deps]
 * @returns {Promise<string[]>} problems, in contract order
 */
export async function runPillsInParallel(contracts, { concurrency, fork: forkFn = fork } = {}) {
  const slots = contracts.map(() => []);
  const limit = concurrency ?? resolveConcurrency(contracts.length);

  await runWithConcurrency(contracts, limit, (contract, index) => new Promise((resolve) => {
    const label = `${contract.script} (${contract.id})`;
    let child;
    try {
      // stdio piped, not inherited: a worker that writes to the terminal
      // directly would interleave with nine others into unreadable mush. It is
      // captured and surfaced only when it explains a failure.
      child = forkFn(SELF, [WORKER_FLAG], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    } catch (err) {
      slots[index].push(`${label}: could not spawn a pill worker — ${err.message}`);
      resolve();
      return;
    }

    let result = null;
    let stderr = '';
    let settled = false;
    const settle = () => { if (!settled) { settled = true; resolve(); } };

    child.stderr?.on('data', (d) => { stderr += d; });
    child.stdout?.on('data', (d) => { stderr += d; });
    child.on('message', (msg) => { result = msg; });
    child.on('error', (err) => {
      slots[index].push(`${label}: pill worker error — ${err.message}`);
      settle();
    });
    child.on('exit', (code, signal) => {
      if (result) {
        slots[index].push(...result.problems);
      } else if (!settled) {
        // No result AND no `error` event: the worker died mid-pill. This is the
        // case a naive pool drops on the floor, and dropping it means the pill
        // never ran while the gate reports nothing wrong with it.
        slots[index].push(
          `${label}: pill worker exited without a result (${signal ? `signal ${signal}` : `exit ${code}`}) — `
          + 'the pill did not run, so the gate is unverified. '
          + `Re-run with GATES_POISON_CONCURRENCY=1 to reproduce serially.${
            stderr.trim() ? ` stderr: ${stderr.trim().slice(-400)}` : ''}`,
        );
      }
      settle();
    });

    child.send({ contract });
  }));

  return slots.flat();
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const KNOWN_FLAGS = ['--selfcheck-relocation', WORKER_FLAG];

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  // `process.argv` whole with the default `from: 2` — it passed a PRE-SLICED
  // argv, so the offset skipped the first two real flags and an unknown flag ran
  // at exit 0 (verified 2026-08-12). This CLI carries safety flags, so a dropped
  // typo is not cosmetic: the operator asks for one thing and gets another.
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'gates:poison' });
  } catch (err) {
    // Handled rather than thrown: an unhandled ArgvError prints a stack trace
    // over the diagnostic the helper wrote precisely so the operator can read
    // it. Exit 2 is this repo's argv-error code.
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }

  // Fork mode: this process is one pill, driven over IPC by the parent below.
  // Branch before any of the parent's own work — a worker that re-ran the
  // reconciliation would pay for it ten times and report it ten times.
  if (process.argv.includes(WORKER_FLAG)) { await runPillWorker(); return; }

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
  let gates;
  try {
    gates = extractCheckGates(pkg.scripts);
  } catch (err) {
    process.stderr.write(`${R}gates:poison FAILED${X} — ${err.message}\n`);
    process.exit(1);
  }

  const contracts = loadContracts();
  const exemptions = loadExemptions();
  const { undeclared, orphaned } = reconcile(gates, contracts, exemptions);

  const problems = [];
  // The mandatory-pill ratchet (D6). Previously the policy lived only in this
  // file's `_comment` — prose enforced by nobody, so a new gate could append a
  // plausible exemption and evade it silently.
  // The ratchet's predicate is `gateAddedAt`, so the claim must be checked, not
  // trusted (audit clusterB-H2/H3): a `git-log-S` label is otherwise provenance
  // asserted by the same file that benefits from it.
  const { divergences: provDiv, unverified: provUnv } = verifyExemptionProvenance(exemptions);
  if (provDiv.length) {
    problems.push(
      `${provDiv.length} exemption(s) claim a gateAddedAt that git does not support:\n      `
      + `${provDiv.map((d) => `${d.key}: claims ${d.claimed}, package.json history says ${d.derived}`).join('\n      ')}\n    `
      + 'Correct the date (re-derive with: git log --format=%ad --date=short -S \'"<key>":\' -- package.json | tail -1), '
      + 'or set gateAddedAtSource to "unknown" if it genuinely cannot be derived.',
    );
  }
  if (provUnv.length) {
    // Reported, never silent: "we could not check" must not read as "it agrees".
    process.stderr.write(`  ${Y}note${X} provenance unverified for ${provUnv.length} exemption(s): `
      + `${provUnv.slice(0, 3).map((u) => `${u.key} (${u.why})`).join('; ')}${provUnv.length > 3 ? ' …' : ''}\n`);
  }
  const forbidden = forbiddenNewExemptions(exemptions);
  if (forbidden.length) {
    problems.push(
      `${forbidden.length} exemption(s) for gate(s) added on/after ${POLICY_CUTOFF}, `
      + `which the mandatory-pill policy forbids:\n      `
      + `${forbidden.map((f) => `${f.key} (gate added ${f.gateAddedAt})`).join('\n      ')}\n    `
      + 'Give the gate a poison pill, or — if a pill is genuinely impossible — add a '
      + '"policyOverride" reason to its exemption entry so the exception is deliberate and reviewable.',
    );
  }
  if (undeclared.length) {
    problems.push(
      `${undeclared.length} check-chain command(s) neither pilled nor exempt:\n      `
      + `${undeclared.join('\n      ')}\n    `
      + 'Add scripts/gate-contracts/<gate>.json with a poison pill whose argv runs that '
      + 'command, or record an exemption (keyed by npm script, or by the exact command for '
      + 'one member of an aggregate script) in scripts/gate-contracts/_exemptions.json.',
    );
  }
  for (const o of orphaned) {
    problems.push(`${o}: the pill runs a command the check chain never reaches — it proves `
      + 'nothing about the chain');
  }

  problems.push(...await runPillsInParallel(contracts));

  if (problems.length) {
    process.stderr.write(`\n${R}✗ gates:poison${X} — ${problems.length} problem(s):\n`);
    for (const p of problems) process.stderr.write(`  ${R}•${X} ${p}\n`);
    process.exit(1);
  }
  // Counted in COMMANDS, the unit a decision is made about — and deduped, since a script
  // reached from two chains would otherwise look like an unaccounted gate. Printing scripts
  // here made the arithmetic (pilled + exempt ≠ total) read as a coverage hole that was not
  // one, which is its own small dishonesty in a file about honest counting.
  const unique = new Set(gates.map((g) => g.command)).size;
  process.stdout.write(
    `${G}✓${X} gates:poison — ${unique} check-chain command(s) across `
    + `${new Set(gates.map((g) => g.script)).size} npm script(s); `
    + `${contracts.length} pilled (verified), ${Object.keys(exemptions).length} exempt\n`,
  );
}

const isMain = import.meta.url === `file://${process.argv[1]}`
  || import.meta.url === `file:///${(process.argv[1] || '').replace(/\\/g, '/')}`;
if (isMain) main();
