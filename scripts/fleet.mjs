#!/usr/bin/env node
/**
 * @fileoverview /fleet — coordinate several concurrent AI coding sessions.
 *
 * A thin dispatcher: argv → one verb in `lib/fleet/` → text (or the `--json`
 * envelope) → exit code. fleet is COOPERATIVE, not enforcing: every rule (stop on
 * `blocked`, hold heavy runs) is honoured by the participants, not by this CLI.
 *
 *   status                          read-only join of git, gh, registry, trains
 *   add <branch|#PR|--all>          adopt work that already exists (advisory)
 *   claim --id --intent --paths [--worktree <path>]  register a NEW session (blocking gate) or update one
 *   ready | touch                   record the head as ready / renew the lease
 *   hold on|off [--reason]          "hold heavy runs"
 *   start --task … [--paths …]…     atomic all-or-nothing batch of chip worktrees
 *   repair --quarantine <file>      move one invalid record aside (human-run)
 *   release [--id] [--abandoned]    retire a claim now (done / abandoned)
 *   archive-check [<id|branch|path>] what removing a worktree would lose (read-only)
 *   prune [--apply [--remote] [--include-fresh]]  branches/worktrees removable with nothing lost: the commands (read-only), or run them
 *   archive <worktree|branch|id> [--apply] [--discard-ignored] [--include-fresh]  snapshot to a local archive/* tag, verify, remove
 *   handover winddown [--repo …] [--scheduler-snapshot <file>]  the stage BEFORE prepare: the directive, measured readiness, the safe-to-archive list
 *   handover prepare [--repo …] [--scheduler-checked] [--winddown-waived "<reason>"]  record account-bound + live state before an account switch
 *   handover receive --from <json> [--dry-run] [--allow-older]  verify/copy it in the new account (exit 0 + followUps = done)
 *   next [--id]                     what this session should do now (read-only)
 *   propose --what --where --why [--evidence --theme --blocked-by <#PR|branch>]  record a finding durably (outlives the worktree)
 *   proposal <id> --folded <session>|--queued <reason>|--declined <reason>|--done <PR>  set an outcome (never deletes)
 *   proposals [--all]               the findings queue grouped by theme; blockedBy rechecked against facts (read-only)
 *   lease acquire|attach|release|status|announce|peak  the machine-wide heavy slot, announced windows and peak hours (shared by every repo's fleet)
 *   directive --to|--list|--ack     coordinator requests in the shared registry
 *   restack [<branch>] [--replace]  replay a branch's own commits onto the base (patch-id checked)
 *   land [--select a,b] [--dry-run] build + test one combined train
 *   land --approve|--confirm|--reconcile|--resume|--abandon <trainId>
 *
 * Exit codes: 0 ok · 1 error (incl. lock not acquired) · 2 argv · 3 blocked/refused.
 * Every known-verb invocation also spools one telemetry event (lib/fleet/telemetry.mjs;
 * `FLEET_TELEMETRY=off` disables it) — counts only, never on stdout.
 * `FLEET_NOW` (ISO or epoch ms) pins the clock for tests; `FLEET_LEASE_HOURS`
 * (default 4) sets the lease; `FLEET_WORKTREE_ROOT` moves the integration
 * worktrees.
 *
 * Plan: docs/plans/fleet-multi-session-coordination.md §2, §7.
 *
 * @module scripts/fleet
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgvError, assertKnownFlags, emit, finishAndExit } from './lib/cli-io.mjs';
import { VERBS, knownFlagsFor, parseVerbArgs } from './lib/fleet/argv.mjs';
import { ConfigError, resolveConfig } from './lib/fleet/config.mjs';
import {
  GitUnavailableError, cmdAdd, cmdClaim, cmdHold, cmdReady, cmdRepair, cmdStart, cmdStatus, cmdTouch,
} from './lib/fleet/commands.mjs';
import { leaseMsFrom, resolveNow } from './lib/fleet/facts.mjs';
import { cmdArchiveCheck, cmdRelease } from './lib/fleet/lifecycle.mjs';
import { checkpointFooter, cmdDirective, cmdNext } from './lib/fleet/coordination.mjs';
import { cmdRestack } from './lib/fleet/restack.mjs';
import { cmdPrune } from './lib/fleet/prune.mjs';
import { cmdArchive } from './lib/fleet/archive.mjs';
import { HYDRATE_HINT, staleBundleWarning } from './lib/fleet/bundle-stamp.mjs';
import { cmdHandover } from './lib/fleet/handover.mjs';
import { renderCommand } from './lib/fleet/shell-quote.mjs';
import { cmdLand } from './lib/fleet/land.mjs';
import { cmdPropose, cmdProposal, cmdProposals } from './lib/fleet/proposals-cmd.mjs';
import { cmdLease } from './lib/fleet/lease-cmd.mjs';
import { fleetDir, RegistryError } from './lib/fleet/registry.mjs';
import { recordInvocation } from './lib/fleet/telemetry.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';

const EXIT = { ok: 0, error: 1, argv: 2, refused: 3, pending: 3 };
const USAGE = `usage: fleet <verb> [flags]\nverbs: ${Object.keys(VERBS).join(', ')}\n`;

/** How this CLI is invoked, for the commands it prints (relative when inside the repo). */
function selfCommand(cwd) {
  const self = path.resolve(process.argv[1]);
  const rel = path.relative(cwd, self);
  return renderCommand(['node', rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : self]);
}

/** Spool this invocation's telemetry event. Never throws; never touches stdout. */
function record(verb, parsed, outcome, exitCode, startedMs) {
  let dir = null;
  try { dir = fleetDir(process.cwd()); } catch { return; } // not a repo: nothing to attach the event to
  recordInvocation({
    fleetDirPath: dir, cwd: process.cwd(), env: process.env,
    scriptsDir: path.dirname(fileURLToPath(import.meta.url)),
    verb, flags: parsed?.flags ?? {}, positionals: parsed?.positionals ?? [],
    result: outcome.result ?? null, error: outcome.error ?? null,
    exitCode, startedMs, endedMs: Date.now(),
  });
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  const startedMs = Date.now();
  const verb = process.argv[2];
  // A hydrated copy in a linked worktree may trail the main checkout's: say so once, on stderr, never failing.
  let staleHint = null;
  try { staleHint = staleBundleWarning({ scriptDir: path.dirname(fileURLToPath(import.meta.url)) }); } catch { staleHint = null; }
  if (staleHint) process.stderr.write(`${staleHint}\n`);
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    process.stdout.write(USAGE);
    return finishAndExit(verb ? 0 : 2);
  }
  if (!Object.hasOwn(VERBS, verb)) { // own keys only: `toString` is not a verb
    // An unknown verb is the classic symptom of stale tooling (`release` was missing in one): name the remedy.
    process.stderr.write(`fleet: unknown verb ${JSON.stringify(verb)}${staleHint ? ` — this worktree's tooling may be stale; run ${HYDRATE_HINT}` : ''}\n${USAGE}`);
    return finishAndExit(2);
  }

  let result;
  let parsed = null;
  try {
    assertKnownFlags(process.argv, knownFlagsFor(verb), { cli: `fleet ${verb}` });
    parsed = parseVerbArgs(verb, process.argv.slice(3));
    const { flags, positionals, tasks } = parsed;
    const cwd = process.cwd();
    const env = process.env;
    leaseMsFrom(env); // an invalid FLEET_LEASE_HOURS is a config error up front, never a silent default
    const ctx = { cwd, env, argv: process.argv, now: resolveNow(env), dir: fleetDir(cwd), cmd: selfCommand(cwd) };
    // Config is LOADED LAZILY: manifest-driven recovery (--reconcile/--confirm/--abandon) must work with a malformed .fleet.json.
    let cached;
    Object.defineProperty(ctx, 'config', { enumerable: true, get() { cached ??= resolveConfig(cwd, { env }); return cached; } });
    switch (verb) {
      case 'status': result = cmdStatus(ctx, flags); break;
      case 'add': result = cmdAdd(ctx, flags, positionals); break;
      case 'claim': result = cmdClaim(ctx, flags); break;
      case 'ready': result = cmdReady(ctx, flags); break;
      case 'touch': result = cmdTouch(ctx, flags); break;
      case 'hold': result = cmdHold(ctx, flags, positionals); break;
      case 'start': result = cmdStart(ctx, tasks); break;
      case 'repair': result = cmdRepair(ctx, flags); break;
      case 'release': result = cmdRelease(ctx, flags); break;
      case 'archive-check': result = cmdArchiveCheck(ctx, flags, positionals); break;
      case 'prune': result = cmdPrune(ctx, flags); break;
      case 'archive': result = cmdArchive(ctx, flags, positionals); break;
      case 'handover': result = await cmdHandover(ctx, flags, positionals); break;
      case 'next': result = cmdNext(ctx, flags); break;
      case 'directive': result = cmdDirective(ctx, flags); break;
      case 'restack': result = cmdRestack(ctx, flags, positionals); break;
      case 'land': result = cmdLand(ctx, flags); break;
      case 'propose': result = cmdPropose(ctx, flags); break;
      case 'proposal': result = cmdProposal(ctx, flags, positionals); break;
      case 'proposals': result = cmdProposals(ctx, flags); break;
      case 'lease': result = await cmdLease(ctx, flags, positionals); break;
      default: throw new ArgvError(`fleet: unhandled verb ${verb}`);
    }
    // Checkpoint footer: a session sees its obligations (hold, merged PR, directives) at the verbs it
    // already runs, without polling. Never changes the verb's outcome.
    if (['claim', 'touch', 'ready'].includes(verb) && result.ok && result.id) {
      result.next = checkpointFooter(ctx, result.id);
      result.text = [result.text, ...result.next].join('\n');
    }
    // `lease run` carries the CHILD'S exit code (or its own 75/70/124/127) and writes its own stderr: the child owns stdout.
    const code = result.exitCode ?? EXIT[result.code] ?? 1;
    process.exitCode = code;
    record(verb, parsed, { result }, code, startedMs);
    if (result.quiet) {
      // nothing to print: the verb already spoke on stderr
    } else if (flags['--json']) {
      emit({ verb, ...result, ok: result.ok });
    } else {
      process.stdout.write(`${result.text}\n`);
    }
    return finishAndExit(code);
  } catch (err) {
    record(verb, parsed, { error: err }, err instanceof ArgvError ? 2 : 1, startedMs);
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); return finishAndExit(2); }
    if (err instanceof GitUnavailableError) { process.stderr.write(`fleet: ${err.message}\n`); return finishAndExit(1); }
    if (err instanceof ConfigError) { process.stderr.write(`fleet: ${err.message}\n`); return finishAndExit(1); }
    if (err instanceof RegistryError) {
      const hint = err.repairFile ? `; run \`${selfCommand(process.cwd())} ${renderCommand(['repair', '--quarantine', err.repairFile])}\`` : '';
      process.stderr.write(`fleet: ${err.message}${hint}\n`);
      return finishAndExit(1);
    }
    process.stderr.write(`fleet: unexpected error: ${err?.stack ?? err}\n`);
    return finishAndExit(1);
  }
}

// Direct-run guard. BOTH sides are canonicalised before comparing (lib/cli-entry.mjs): a
// symlinked entry path (or --preserve-symlinks-main, which leaves import.meta.url unresolved)
// must never turn a mutating command into a silent no-op. (--selfcheck-relocation stays the
// first statement of main().)
if (isInvokedAsScript(import.meta.url)) await main();
