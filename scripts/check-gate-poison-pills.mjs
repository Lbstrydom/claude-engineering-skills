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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCliGateContracts } from './lib/gate-honesty/loader.mjs';
import { assertKnownFlags } from './lib/cli-io.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

export function loadExemptions(file = EXEMPTIONS) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf-8')).exempt ?? {};
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
export const _internals = { applyMutation, listTracked, copyTracked };

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
    try {
      fs.symlinkSync(
        path.join(repoRoot, 'node_modules'), path.join(work, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (err) {
      problems.push(`${contract.script}: could not link node_modules into the isolated copy (${err.code}) — `
        + 'the gate would fail on a missing dependency rather than on its artifact');
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

// ── CLI ─────────────────────────────────────────────────────────────────────

const KNOWN_FLAGS = ['--selfcheck-relocation'];

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(process.argv.slice(2), KNOWN_FLAGS, { cli: 'gates:poison' });

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

  for (const c of contracts) {
    const r = runPill(c);
    problems.push(...r.problems);
  }

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
