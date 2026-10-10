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
 *   claim --id --intent --paths     register a NEW session (blocking gate) or update one
 *   ready | touch                   record the head as ready / renew the lease
 *   hold on|off [--reason]          "hold heavy runs"
 *   start --task … [--paths …]…     atomic all-or-nothing batch of chip worktrees
 *   repair --quarantine <file>      move one invalid record aside (human-run)
 *   release [--id] [--abandoned]    retire a claim now (done / abandoned)
 *   archive-check [<id|branch|path>] what removing a worktree would lose (read-only)
 *   prune                           branches/worktrees removable with nothing lost, and the commands (read-only)
 *   next [--id]                     what this session should do now (read-only)
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
import fs from 'node:fs';
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
import { renderCommand } from './lib/fleet/shell-quote.mjs';
import { cmdLand } from './lib/fleet/land.mjs';
import { fleetDir, RegistryError } from './lib/fleet/registry.mjs';
import { recordInvocation } from './lib/fleet/telemetry.mjs';

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
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    process.stdout.write(USAGE);
    return finishAndExit(verb ? 0 : 2);
  }
  if (!Object.hasOwn(VERBS, verb)) { // own keys only: `toString` is not a verb
    process.stderr.write(`fleet: unknown verb ${JSON.stringify(verb)}\n${USAGE}`);
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
    const ctx = { cwd, env, now: resolveNow(env), dir: fleetDir(cwd), cmd: selfCommand(cwd) };
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
      case 'prune': result = cmdPrune(ctx); break;
      case 'next': result = cmdNext(ctx, flags); break;
      case 'directive': result = cmdDirective(ctx, flags); break;
      case 'restack': result = cmdRestack(ctx, flags, positionals); break;
      case 'land': result = cmdLand(ctx, flags); break;
      default: throw new ArgvError(`fleet: unhandled verb ${verb}`);
    }
    // Checkpoint footer: a session sees its obligations (hold, merged PR, directives) at the verbs it
    // already runs, without polling. Never changes the verb's outcome.
    if (['claim', 'touch', 'ready'].includes(verb) && result.ok && result.id) {
      result.next = checkpointFooter(ctx, result.id);
      result.text = [result.text, ...result.next].join('\n');
    }
    const code = EXIT[result.code] ?? 1;
    process.exitCode = code;
    record(verb, parsed, { result }, code, startedMs);
    if (flags['--json']) {
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

// Direct-run guard. BOTH sides are canonicalised before comparing: a symlinked entry path (or
// --preserve-symlinks-main, which leaves import.meta.url unresolved) must never turn a mutating
// command into a silent no-op. (--selfcheck-relocation stays the first statement of main().)
const canon = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const here = canon(fileURLToPath(import.meta.url));
if (process.argv[1] && here === canon(path.resolve(process.argv[1]))) await main();
