#!/usr/bin/env node
/**
 * @fileoverview Pinned-revision fixture for spend-bearing runs — entry point.
 *
 * Pins a repository revision for the duration of a long, evidence-collecting
 * run, so a concurrent commit or a rebase in the shared working tree cannot
 * invalidate the evidence it is paying for.
 *
 * **The measured problem.** A bake-off snapshot spawns 6 arms over 15–25
 * minutes, each recording the commit it ran at, and the campaign store refuses
 * a snapshot whose arms disagree ("one snapshot is one revision"). Two
 * snapshots and ~$13 of provider spend were lost on 2026-08-17: once to a
 * rebase mid-collection, once to a CONCURRENT agent session committing while
 * collection ran. Several sessions routinely work this repo in one shared
 * working tree, so care is not a control.
 *
 * The fixture is deliberately general — any revision-stamped, spend-bearing run
 * (arm-eval collection, solo-control sweeps, model-eval harness runs, long
 * audit replays) has the same exposure. Bake-off is the first consumer.
 *
 * Usage:
 *   node scripts/pinned-worktree.mjs create --name bakeoff-2026q3 --rev HEAD --campaign final-review-scoped-2026q3
 *   node scripts/pinned-worktree.mjs verify --name bakeoff-2026q3 --campaign final-review-scoped-2026q3
 *   node scripts/pinned-worktree.mjs remove --name bakeoff-2026q3
 *   node scripts/pinned-worktree.mjs --selfcheck-relocation
 *
 * Plan: docs/plans/pinned-revision-fixture.md ·
 * Runbook: docs/runbooks/pinned-revision-fixture.md
 *
 * @module scripts/pinned-worktree
 */
import './lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertKnownFlags, ArgvError, emit, log } from './lib/cli-io.mjs';
import { selectCampaignConfig } from './lib/campaign/config.mjs';
import { createFixture, verifyFixture, removeFixture, resolveRevision } from './lib/pinned-worktree/manage.mjs';
import { requiredCredentials, checkCredentials, formatMissing } from './lib/pinned-worktree/preflight.mjs';
import { resolveMainRoot, defaultFixtureRoot, fixturePath } from './lib/pinned-worktree/paths.mjs';

const KNOWN_FLAGS = Object.freeze([
  '--name', '--rev', '--campaign', '--root', '--install', '--force',
  '--json', '--selfcheck-relocation', '--help', '-h',
]);

const USAGE = `pinned-worktree — pin a repository revision for a spend-bearing run

  create  --name <n> --rev <sha|ref> [--campaign <id>] [--root <dir>] [--install]
  verify  --name <n> [--campaign <id>] [--root <dir>]
  remove  --name <n> [--root <dir>]

  --campaign <id>  run the credential preflight for that campaign's arms.
                   On create this is a REFUSAL gate: a missing provider key does
                   not error at runtime, it makes the arm record as SKIPPED and
                   the snapshot is rejected after the other arms have billed.
  --install        force \`npm ci\` instead of linking node_modules.
  --json           machine-readable output.
`;

/** @param {string[]} argv @param {string} flag */
function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new ArgvError(`pinned-worktree: ${flag} needs a value`);
  return v;
}

/**
 * Run the credential preflight **with `cwd` set to the fixture**.
 *
 * Load-bearing: the fixture resolves its own `.env` (a linked worktree has
 * none of its own, so `discoverLocalEnvPath` falls through to the MAIN
 * checkout's). Checking the main checkout's environment instead would verify a
 * different environment than the run uses — "verify what the consumer receives,
 * not what the producer sent".
 *
 * A child process is used rather than importing, because env resolution is a
 * process-level side effect that has already happened in THIS process against
 * the wrong cwd.
 *
 * @param {string} fixtureDir
 * @returns {object} the resolved environment as the fixture sees it
 */
function fixtureEnv(fixtureDir) {
  const script = `
    import('./scripts/lib/load-env.mjs')
      .then(() => process.stdout.write(JSON.stringify(process.env)));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fixtureDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/** Count the fixture's own bake-off log entries — see the caller's warning. */
function localLogCount(fixtureDir) {
  try {
    const p = path.join(fixtureDir, '.audit', 'bakeoff-log.jsonl');
    return fs.readFileSync(p, 'utf-8').split('\n').filter((l) => l.trim()).length;
  } catch { return 0; }
}

/**
 * `selectCampaignConfig` returns a RESULT ENVELOPE (`{ok, config, …}` or
 * `{ok:false, code, message}`), not the config — unwrapped here in one place so
 * a refusal to resolve the campaign is reported as itself rather than surfacing
 * one layer down as "declares no arms", which is a different fault entirely.
 *
 * @param {string} campaignId @param {string} cwd
 */
function loadCampaign(campaignId, cwd) {
  const r = selectCampaignConfig({ campaignId, dir: path.join(cwd, '.campaigns') });
  if (!r.ok) throw new ArgvError(`pinned-worktree: ${r.message}`);
  return r.config;
}

function runPreflight(campaignId, fixtureDir, cwd) {
  const config = loadCampaign(campaignId, cwd);
  const reqs = requiredCredentials({ campaignConfig: config });
  const result = checkCredentials(reqs, fixtureEnv(fixtureDir));
  return { campaignId: config.id, ...result };
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'pinned-worktree' });

  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith('-')) ?? null;
  const json = argv.includes('--json');

  if (!cmd || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  const name = flagValue(argv, '--name');
  if (!name) throw new ArgvError('pinned-worktree: --name is required');
  const campaign = flagValue(argv, '--campaign');
  const rootFlag = flagValue(argv, '--root');
  const cwd = process.cwd();
  const mainRoot = resolveMainRoot(cwd);
  const root = rootFlag ? path.resolve(rootFlag) : defaultFixtureRoot(mainRoot);
  const dir = fixturePath(root, name);

  if (cmd === 'create') {
    const rev = flagValue(argv, '--rev');
    if (!rev) throw new ArgvError('pinned-worktree: --rev is required for create — the pin must be an explicit revision');

    // Preflight the campaign config BEFORE creating anything, so an
    // unresolvable campaign or an unknown model family costs nothing.
    if (campaign) requiredCredentials({ campaignConfig: loadCampaign(campaign, cwd) });

    const sha = resolveRevision(rev, cwd);
    log(`pinning ${sha.slice(0, 8)} at ${dir}`);
    const created = createFixture({ name, rev: sha, root, cwd, forceInstall: argv.includes('--install') });
    log(`  worktree: detached at ${created.sha.slice(0, 8)}`);
    log(`  node_modules: ${created.modules.mode} (${created.modules.reason})`);

    let preflight = null;
    if (campaign) {
      preflight = runPreflight(campaign, created.dir, cwd);
      if (!preflight.ok) {
        // REFUSE. The fixture is removed so a failed create leaves nothing
        // half-made — and so the operator cannot accidentally collect into it.
        removeFixture({ dir: created.dir, cwd });
        const msg = `credential preflight FAILED for campaign ${preflight.campaignId} — `
          + `${preflight.missing.length} of ${preflight.checked} requirement(s) unmet:\n${formatMissing(preflight)}`;
        if (json) { emit({ ok: false, command: 'create', error: msg, preflight }); return; }
        process.stderr.write(`\n${msg}\n\nNothing was spent. The fixture was removed.\n`);
        process.exitCode = 1;
        return;
      }
      log(`  credentials: all ${preflight.checked} requirement(s) present`);
    }

    if (json) { emit({ ok: true, command: 'create', ...created, preflight }); return; }
    process.stdout.write(`\nFixture ready: ${created.dir}\n`
      + `  pinned at ${created.sha}\n`
      + `  cd ${created.dir}\n\n`
      + 'Two things that will otherwise mislead you:\n'
      + '  1. Pass transcripts by ABSOLUTE path from the main checkout — `.audit/` is\n'
      + '     gitignored, so it is absent here.\n'
      + '  2. The fixture writes its OWN .audit/bakeoff-log.jsonl. A `--progress` run\n'
      + '     here reads near-zero regardless of real campaign progress. Trust the\n'
      + '     STORE, not the local log.\n');
    return;
  }

  if (cmd === 'verify') {
    const result = verifyFixture({ dir });
    const preflight = campaign && result.ok ? runPreflight(campaign, dir, cwd) : null;
    const local = localLogCount(dir);
    const ok = result.ok && (!preflight || preflight.ok);
    if (json) { emit({ ok, command: 'verify', ...result, preflight, localBakeoffLogEntries: local }); return; }
    process.stdout.write(`\nFixture: ${dir}\n`);
    for (const c of result.checks) process.stdout.write(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(13)} ${c.detail}\n`);
    if (preflight) {
      process.stdout.write(`  ${preflight.ok ? 'ok  ' : 'FAIL'} credentials   `
        + `${preflight.present.length}/${preflight.checked} present for ${preflight.campaignId}\n`);
      if (!preflight.ok) process.stdout.write(`${formatMissing(preflight)}\n`);
    }
    // Two facts about this number, and the second one is the expensive one. It
    // was labelled as a progress-reading pitfall alone until 2026-08-18, which
    // read as "the local log is cosmetic here" — it is not. Retry scoping is
    // now store-authoritative (bakeoff-collect.mjs planRetryScope), so the
    // empty log no longer decides what gets billed; saying so here is what
    // stops the old, wrong mental model from surviving the fix.
    process.stdout.write(`\n  local .audit/bakeoff-log.jsonl entries: ${local}`
      + '  <- fixture-local only, NOT campaign progress.\n'
      + '  The store is the only trustworthy count: node scripts/campaign.mjs reconcile\n'
      + '  Retry scoping asks the STORE, not this file — bakeoff-collect prints which arms it will\n'
      + '  spawn, and what is already recorded, before spending. Read that line: if it says\n'
      + '  "store: NOT CONSULTABLE" it is about to re-bill EVERY arm.\n');
    if (!ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'remove') {
    const result = removeFixture({ dir, cwd });
    if (json) { emit({ ok: result.ok, command: 'remove', ...result }); return; }
    for (const s of result.steps) process.stdout.write(`  ${s}\n`);
    process.stdout.write(result.ok ? `removed ${dir}\n` : `FAILED to remove ${dir}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  throw new ArgvError(`pinned-worktree: unknown command ${JSON.stringify(cmd)}. Expected create, verify or remove.`);
}

try {
  main();
} catch (err) {
  if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exitCode = 2; }
  else { process.stderr.write(`pinned-worktree: ${err.message}\n`); process.exitCode = 1; }
}
