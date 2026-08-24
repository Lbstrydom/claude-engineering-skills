#!/usr/bin/env node
/**
 * @fileoverview `runner:doctor` — for a repo hitting "GitHub Actions hosted
 * runners are disabled for this repository", test whether a self-hosted
 * runner is actually viable for the CURRENT gh identity, and print the
 * choice: a ready-to-run repo-scoped setup recipe if so, or this repo's own
 * local pre-push-hook fallback (docs/runbooks/local-maintenance-checks.md)
 * if not.
 *
 * Does NOT try to detect the hosted-runner block itself — that's an
 * Enterprise-level policy with no exposed API field, and only shows up as a
 * workflow-run annotation. This tool starts from "you already hit that" and
 * answers the next question. See scripts/lib/runner-fallback.mjs for the
 * pure verdict logic and its scope note.
 *
 * Side effect, by design: on a repo where this identity has admin, this run
 * REQUESTS a real (short-lived, ~1hr, single-use, unrevoked-if-unused)
 * runner registration token — that request IS the capability test, mirroring
 * `gh api -X POST repos/OWNER/REPO/actions/runners/registration-token` run
 * by hand. Nothing else is created or modified.
 *
 * Requires the `gh` CLI, authenticated.
 *
 * Two further sub-commands (Cluster B,
 * docs/plans/self-hosted-runner-management.md Phases 3-4) answer "is a
 * runner actually installed and healthy on THIS machine" — a different
 * question from the one above, which is about a REPO's capability:
 *   `local`  — inventory + health + identity findings for every discovered
 *              install on this machine (never a filesystem walk — exact
 *              declared directories only).
 *   `remove` — a two-step, re-invokable removal helper (`remove <selector>`
 *              to prepare, `remove --verify ...` to confirm).
 * See docs/runbooks/actions-runner-doctor.md for the full sub-command
 * reference.
 *
 * Usage:
 *   node scripts/actions-runner-doctor.mjs
 *   node scripts/actions-runner-doctor.mjs --repo your-org/your-repo
 *   node scripts/actions-runner-doctor.mjs --json
 *   node scripts/actions-runner-doctor.mjs local --json --strict
 *   node scripts/actions-runner-doctor.mjs remove my-runner-name
 *   node scripts/actions-runner-doctor.mjs remove --verify --host github.com --owner-kind repo --owner your-org/your-repo --agent-id 42
 *
 * Exit codes (no sub-command):
 *   0 — ran and produced a verdict (viable, no-admin-rights, actions-disabled, or unknown)
 *   1 — could not determine the repo, or `gh` is missing/unauthed
 * Exit codes (`local`): 0 normally; under `--strict`, 1 when rollup is
 *   unhealthy/unknown/partial-error (never for advisory-only — see §3 of the plan).
 * Exit codes (`remove --verify`): 0 removed; 1 still-registered; 3-6 inconclusive
 *   (distinct per RemoteResult status — see runRemoveVerify below).
 *
 * @module scripts/actions-runner-doctor
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { assertKnownFlags, ArgvError, emit, argOption, hasFlag } from './lib/cli-io.mjs';
import { parseOriginRepo } from './lib/branch-protection.mjs';
import {
  assessRunnerFallback, runnerAssetTokens, isValidRepoSlug, readRepoArg, resolveRepoSlugFromArg,
} from './lib/runner-fallback.mjs';
import {
  summariseInventory,
  parseOwnerFromGitHubUrl,
  quoteForShell,
} from './lib/runner-inventory.mjs';
import {
  discoverInstalls,
  fetchRemoteRunner,
  readCurrentRepoOwners,
  loadLocalRunnerConfig,
} from './lib/runner-probe.mjs';

// CLI relocation smoke contract (AGENTS.md CLI_SMOKE_SET) — proves imports
// survive relocation into a consumer's scripts/.claude-skills/.
if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

const KNOWN_FLAGS = [
  '--repo', '--json', '--selfcheck-relocation',
  // `local` / `remove` (Cluster B)
  '--include-wsl', '--strict', '--quiet-when-clean', '--config',
  '--verify', '--host', '--owner-kind', '--owner', '--agent-id',
];

// `local` / `remove` are bare positional sub-commands, dispatched ahead of
// the existing no-sub-command path below — which stays byte-identical for
// every existing scenario (viable / no-admin-rights / actions-disabled /
// unknown), per the plan's D1 (§2) and R1 M3 (§9). `assertKnownFlags`
// already skips non-`--` tokens, so 'local'/'remove' being positional here
// needs no special-casing in the flag validator.
//
// Fixed 2026-08-24 (final-review-scoped-2026q3): the subcommand used to be
// read as a bare `process.argv[2] === 'local'`, a POSITIONAL read — so
// `--json local` (flag first) missed it entirely and silently ran the
// LEGACY top-level command instead, while still reporting `ok: true`. The
// fix scans for the first token that isn't itself a flag (or a flag's
// value), wherever it falls in argv, so `local --json` and `--json local`
// resolve to the same subcommand.
const VALUE_FLAGS = new Set(['--repo', '--config', '--host', '--owner-kind', '--owner', '--agent-id']);

function firstPositionalToken(argv) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break; // POSIX terminator — nothing after is a flag
    if (a.startsWith('--')) {
      // `--flag=value` is one token; `--flag value` (space form) is two —
      // a value-taking flag's next token is consumed here so it's never
      // mistaken for the subcommand (e.g. `--repo my-org/my-repo local`).
      if (!a.includes('=') && VALUE_FLAGS.has(a)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) i++;
      }
      continue;
    }
    return a;
  }
  return null;
}

const _firstPositional = firstPositionalToken(process.argv);
const SUBCOMMAND = (_firstPositional === 'local' || _firstPositional === 'remove') ? _firstPositional : null;

// Single oracle for "--json was passed" (Fixed 2026-08-24, same finding):
// this used to be a bare `process.argv.includes('--json')` here, while
// `runLocal` separately called `hasFlag('json')` — two answers to the same
// question that could (and did) disagree, since the bare form doesn't
// understand `--json=false`/`--json=value` or the `--` terminator. Every
// caller now reads `JSON_OUT`.
const JSON_OUT = hasFlag('json');
const repoArg = readRepoArg(process.argv);

const err = (m) => process.stderr.write(m + '\n');

/** Run `gh` and return stdout, or throw with a legible message. */
function gh(args, { input } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf-8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('the `gh` CLI is not installed or not on PATH — install GitHub CLI and `gh auth login`');
    }
    const stderr = (e.stderr || '').toString().trim();
    throw new Error(stderr || e.message);
  }
}

/**
 * Single choke point for the repo slug: every value that reaches `gh api`
 * calls or the printed copy-paste recipe (printRecipe) passes through here
 * and through `isValidRepoSlug`, whichever source it came from.
 */
function resolveRepoSlug() {
  if (repoArg.present) return resolveRepoSlugFromArg(repoArg);
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('no --repo given and could not read `git remote get-url origin`');
  }
  const parsed = parseOriginRepo(url);
  if (!parsed) throw new Error(`origin remote is not a recognisable GitHub URL: ${url}`);
  if (!isValidRepoSlug(parsed.slug)) {
    throw new Error(`origin remote resolved to an unexpected slug shape: ${parsed.slug}`);
  }
  return parsed.slug;
}

/** Best-effort: find the actions/runner latest-release asset for this
 * machine's platform/arch. Returns null on any failure — the caller falls
 * back to pointing at the repo's own Settings page rather than guessing. */
function resolveRunnerAsset() {
  const tokens = runnerAssetTokens(process.platform, process.arch);
  if (!tokens) return null;
  try {
    const release = JSON.parse(gh(['api', 'repos/actions/runner/releases/latest']));
    const asset = (release.assets || []).find(
      (a) => a.name.includes(`-${tokens.os}-${tokens.arch}-`),
    );
    if (!asset) return null;
    return { version: release.tag_name, name: asset.name, downloadUrl: asset.browser_download_url };
  } catch {
    return null;
  }
}

function printRecipe(slug, token, asset) {
  console.log('\nNext steps:');
  if (asset) {
    console.log(`  1. Download + extract the runner (${asset.version}, ${asset.name}):`);
    console.log(`     ${asset.downloadUrl}`);
  } else {
    console.log('  1. Download the runner for your platform from:');
    console.log(`     https://github.com/${slug}/settings/actions/runners/new`);
  }
  console.log('  2. Configure it:');
  console.log(`     config --url https://github.com/${slug} --token ${token} --unattended`);
  console.log('  3. Install it as a persistent service (survives logout/reboot):');
  console.log('     svc install');
  console.log('     svc start');
  console.log('  4. Point the blocked workflow job at it: runs-on: self-hosted');
}

function main() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'actions-runner-doctor' });

  let slug;
  try {
    slug = resolveRepoSlug();
  } catch (e) {
    err(`error: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  let actionsEnabled = null;
  let allowedActions = null;
  try {
    const permissions = JSON.parse(gh(['api', `repos/${slug}/actions/permissions`]));
    actionsEnabled = permissions.enabled ?? null;
    allowedActions = permissions.allowed_actions ?? null;
  } catch (e) {
    err(`warning: could not read actions/permissions: ${e.message}`);
  }

  let canRegisterSelfHosted = false;
  let registrationError = null;
  let registration = null;
  try {
    const token = JSON.parse(gh(['api', '-X', 'POST', `repos/${slug}/actions/runners/registration-token`]));
    canRegisterSelfHosted = true;
    registration = { token: token.token, expiresAt: token.expires_at };
  } catch (e) {
    registrationError = e.message;
  }

  const { verdict, headline, guidance } = assessRunnerFallback({
    actionsEnabled, canRegisterSelfHosted, registrationError,
  });

  const asset = canRegisterSelfHosted ? resolveRunnerAsset() : null;

  if (JSON_OUT) {
    emit({
      ok: true,
      repo: slug,
      actionsEnabled,
      allowedActions,
      canRegisterSelfHosted,
      verdict,
      headline,
      guidance,
      registration,
      runnerAsset: asset,
    });
    return;
  }

  console.log(`Repo: ${slug}`);
  console.log(`Actions enabled: ${actionsEnabled === null ? 'unknown' : actionsEnabled}${allowedActions ? ` (allowed_actions: ${allowedActions})` : ''}`);
  console.log(`Self-hosted registration: ${canRegisterSelfHosted ? 'viable' : 'not viable'}`);
  console.log(`\n>> ${headline}`);
  for (const line of guidance) console.log(`   ${line}`);
  if (canRegisterSelfHosted && registration) {
    console.log(`\nRegistration token (expires ${registration.expiresAt}):`);
    console.log(`  ${registration.token}`);
    printRecipe(slug, registration.token, asset);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// `local` — inventory + health + identity findings for this machine
// (docs/plans/self-hosted-runner-management.md §3 "Command-result contract").
// ═══════════════════════════════════════════════════════════════════════

/** `loadLocalRunnerConfig` returns `{ok:true, value:null}` for the ONE
 * legitimate empty-config case (file absent). Every other non-ok outcome —
 * malformed JSON, an unknown key (`.strict()`), an unreadable explicit
 * `--config` path — is an operational error, never silently treated as
 * empty (§3 "Local config schema"). */
function loadConfigOrError() {
  const configPath = argOption('config');
  return loadLocalRunnerConfig(configPath ? { configPath } : {});
}

function buildIdentityContext(config) {
  return {
    hostname: os.hostname(),
    config: config || {},
    currentRepoOwners: readCurrentRepoOwners(),
  };
}

/** Bridges the adapter's `{ok,value|error}` procedural contract onto the
 * domain-level `RemoteResult` shape `assessRunnerHealth`/rollup expect — a
 * procedural failure (gh binary missing, spawn error) reads as `unavailable`,
 * which D4 already maps to `unknown` health and is never rendered healthy. */
function resolveRemoteStatus(install, config) {
  const res = fetchRemoteRunner(install.owner, install.agentId, { config });
  if (res.ok) return res.value;
  return { status: 'unavailable', reason: res.error?.message || 'gh could not be invoked' };
}

function printLocalHuman(envelope) {
  console.log(`Self-hosted runner inventory — rollup: ${envelope.rollup}`);
  console.log(
    `  installs: ${envelope.summary.totalInstalls} `
    + `(healthy ${envelope.summary.healthy}, unhealthy ${envelope.summary.unhealthy}, unknown ${envelope.summary.unknownHealth}), `
    + `advisory findings: ${envelope.summary.advisoryFindings}, install errors: ${envelope.summary.installErrors}`,
  );
  if (envelope.notProbed.wsl) console.log(`  WSL: not probed — ${envelope.notProbed.reason}`);
  for (const inst of envelope.installs) {
    console.log(`\n- ${inst.root} (${inst.owner.display}, agent "${inst.agentName}" #${inst.agentId})`);
    console.log(`    health: ${inst.healthVerdict}`);
    for (const f of inst.identityFindings) {
      console.log(`    [${f.severity}] ${f.id}: ${f.detail}`);
    }
  }
  for (const c of envelope.candidates) {
    if (c.state !== 'error') continue;
    console.log(`\n! ${c.root}: ${c.error.code} — ${c.error.detail}`);
  }
}

function runLocal() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'actions-runner-doctor local' });

  // JSON_OUT is the module-level single oracle for "--json was passed" —
  // do not recompute it here (that was the drift: this used to call
  // hasFlag('json') independently of the module-level JSON_OUT).
  const jsonOut = JSON_OUT;
  const quietWhenClean = hasFlag('quiet-when-clean');
  // R2 H2 — machine mode always emits exactly one envelope; quiet mode is
  // human-output-only. Refuse rather than silently pick a winner.
  if (jsonOut && quietWhenClean) {
    throw new ArgvError(
      'actions-runner-doctor local: --json and --quiet-when-clean are mutually exclusive. '
      + '--json always emits exactly one machine-readable line (including a clean result); '
      + '--quiet-when-clean only suppresses HUMAN-mode printing on a clean rollup. Pick one.',
    );
  }
  const includeWsl = hasFlag('include-wsl');
  const strict = hasFlag('strict');

  const configRes = loadConfigOrError();
  if (!configRes.ok) {
    // R2 H4 — top-level ok:false is reserved for "no summary could be
    // produced at all", e.g. an unreadable/malformed config.
    if (jsonOut) { emit({ ok: false, schemaVersion: 1, error: configRes.error }); return; }
    err(`error: could not load runner-hosts config: ${configRes.error.message}`);
    process.exitCode = 1;
    return;
  }
  const config = configRes.value || {};

  const { installs: rawInstalls, candidates, notProbed } = discoverInstalls({
    config, platform: process.platform, includeWsl,
  });
  const installs = rawInstalls.map((inst) => ({ ...inst, remoteStatus: resolveRemoteStatus(inst, config) }));

  const envelope = summariseInventory({
    installs, candidates, notProbed, identityContext: buildIdentityContext(config),
  });

  // `--strict` exit mapping (§3): advisory NEVER gates, even under --strict.
  if (strict && ['unhealthy', 'unknown', 'partial-error'].includes(envelope.rollup)) {
    process.exitCode = 1;
  }

  if (jsonOut) { emit(envelope); return; }
  if (quietWhenClean && envelope.rollup === 'clean') return;
  printLocalHuman(envelope);
}

// ═══════════════════════════════════════════════════════════════════════
// `remove` — two-step, stateless removal helper (D7).
// ═══════════════════════════════════════════════════════════════════════

function selectorMatchesInstall(install, selector) {
  if (install.agentName === selector) return true;
  const asNum = Number(selector);
  return Number.isInteger(asNum) && install.agentId === asNum;
}

/** `local` → the CLI process's own host-OS dialect; `wsl` → POSIX always (a
 * WSL-hosted runner is a Linux install, never both dialects at once — Gemini
 * G3/§10). */
function dialectFor(install) {
  if (install.kind === 'wsl') return 'posix';
  return process.platform === 'win32' ? 'windows' : 'posix';
}

/** Wraps a command line in `wsl.exe -d <distro> --` when printed for a
 * wsl-kind install (Gemini G4) — a bare POSIX line pasted into
 * PowerShell/CMD fails outright, breaking the "ready-to-run" promise. */
function wrapForHost(install, line) {
  return install.kind === 'wsl' ? `wsl.exe -d ${install.distro} -- ${line}` : line;
}

function configRemoveLine(install, token) {
  const dialect = dialectFor(install);
  const quotedToken = quoteForShell(token, dialect);
  const line = dialect === 'windows'
    ? `config.cmd remove --token ${quotedToken}`
    : `./config.sh remove --token ${quotedToken}`;
  return wrapForHost(install, line);
}

function serviceStopLines(install) {
  const dialect = dialectFor(install);
  const lines = dialect === 'windows'
    ? ['svc.cmd stop', 'svc.cmd uninstall']
    : ['sudo ./svc.sh stop', 'sudo ./svc.sh uninstall'];
  return lines.map((l) => wrapForHost(install, l));
}

const REMOVE_TOKEN_ENDPOINT = (owner) => (owner.ownerKind === 'org'
  ? `orgs/${owner.display}/actions/runners/remove-token`
  : `repos/${owner.display}/actions/runners/remove-token`);

function runRemovePrepare(selector) {
  const includeWsl = hasFlag('include-wsl');

  const configRes = loadConfigOrError();
  if (!configRes.ok) {
    err(`error: could not load runner-hosts config: ${configRes.error.message}`);
    process.exitCode = 1;
    return;
  }
  const config = configRes.value || {};

  const { installs } = discoverInstalls({ config, platform: process.platform, includeWsl });
  const matches = installs.filter((inst) => selectorMatchesInstall(inst, selector));

  // D7/INC-002 — resolve uniquely against the LOCAL side before requesting
  // anything. Zero or >1 matches: refuse, naming the ambiguity, nothing requested.
  if (matches.length === 0) {
    err(`error: no local install matches selector "${selector}" — nothing requested.`);
    process.exitCode = 1;
    return;
  }
  if (matches.length > 1) {
    err(
      `error: selector "${selector}" matches ${matches.length} local installs `
      + `(${matches.map((m) => m.root).join(', ')}) — refusing to guess which one. `
      + 'Use a more specific selector (the numeric agentId).',
    );
    process.exitCode = 1;
    return;
  }
  const install = matches[0];

  // Remote status is CHECKED, not matched (revised Gemini G2 — direct by-ID
  // lookup means the remote side can only ever be available/not-registered
  // by construction once the local side is unique).
  const remoteRes = fetchRemoteRunner(install.owner, install.agentId, { config });
  const remoteStatus = remoteRes.ok ? remoteRes.value : { status: 'unavailable', reason: remoteRes.error?.message };

  if (remoteStatus.status !== 'available' && remoteStatus.status !== 'not-registered') {
    err(
      `error: cannot confirm this runner's remote status (${remoteStatus.status}) — refusing to request a removal token. `
      + `Re-run once gh/network access to ${install.owner.host} is restored.`,
    );
    process.exitCode = 1;
    return;
  }
  if (remoteStatus.status === 'not-registered') {
    err('warning: this runner is already deregistered on GitHub — this will only clean up the LOCAL configuration.');
  }

  let token;
  try {
    const parsed = JSON.parse(gh(['api', '-X', 'POST', REMOVE_TOKEN_ENDPOINT(install.owner), '--hostname', install.owner.host]));
    token = parsed.token;
  } catch (e) {
    err(`error: could not request a removal token: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // Gemini G2 — service-aware recipe: stop-then-uninstall BEFORE config
  // remove whenever a service declaration exists and its true state is
  // either confirmed registered or unconfirmed (the conservative direction).
  const serviceStopRequired = install.supervision.serviceState === 'registered'
    || install.supervision.serviceState === 'unknown';

  // R3 M1 — structured fields, never one opaque copy-paste string.
  console.log(`Install directory: ${install.root}`);
  console.log(`Removal token: ${token}`);
  if (serviceStopRequired) {
    console.log('\nThis install has a registered (or unconfirmed) service — stop it BEFORE removing config:');
    for (const line of serviceStopLines(install)) console.log(`  ${line}`);
  }
  console.log('\nRun this INSIDE the install directory to deregister locally:');
  console.log(`  ${configRemoveLine(install, token)}`);
  console.log('\nThen verify it actually took effect:');
  console.log(
    `  node scripts/actions-runner-doctor.mjs remove --verify --host ${install.owner.host} `
    + `--owner-kind ${install.owner.ownerKind} --owner ${install.owner.display} --agent-id ${install.agentId}`,
  );
}

/** Distinct, non-overlapping exit codes for verify's outcomes (Gemini G1):
 * 0 removed, 1 still-registered, 3-6 inconclusive (one per non-available/
 * non-not-registered RemoteResult status) — never 0, never 1 (which would
 * read as a confirmed removal or a confirmed failure-to-remove). */
const VERIFY_INCONCLUSIVE_EXIT = {
  unavailable: 3,
  forbidden: 4,
  'malformed-response': 5,
  'untrusted-host': 6,
};

function runRemoveVerify() {
  const host = argOption('host');
  const ownerKind = argOption('owner-kind');
  const owner = argOption('owner');
  const agentIdRaw = argOption('agent-id');
  if (!host || !ownerKind || !owner || !agentIdRaw) {
    throw new ArgvError(
      'actions-runner-doctor remove --verify requires --host, --owner-kind, --owner and --agent-id — '
      + 'the full descriptor `remove <selector>` printed, not a bare selector.',
    );
  }
  if (ownerKind !== 'repo' && ownerKind !== 'org') {
    throw new ArgvError(`actions-runner-doctor remove --verify: --owner-kind must be "repo" or "org", got "${ownerKind}".`);
  }
  const agentId = Number(agentIdRaw);
  if (!Number.isInteger(agentId)) {
    throw new ArgvError(`actions-runner-doctor remove --verify: --agent-id must be an integer, got "${agentIdRaw}".`);
  }

  const configRes = loadConfigOrError();
  if (!configRes.ok) {
    err(`error: could not load runner-hosts config: ${configRes.error.message}`);
    process.exitCode = 1;
    return;
  }
  const config = configRes.value || {};

  // Re-validated through the SAME OwnerIdentity codec discovery uses (D12) —
  // rejects a malformed/internally-inconsistent descriptor (e.g. --owner-kind
  // org with a two-segment --owner) BEFORE any network call.
  const built = parseOwnerFromGitHubUrl(`https://${host}/${owner}`);
  if (!built || built.ownerKind !== ownerKind) {
    throw new ArgvError(
      `actions-runner-doctor remove --verify: the descriptor is malformed or internally inconsistent `
      + `(--owner-kind ${ownerKind} does not match --owner "${owner}" on host "${host}") — refusing before any network call.`,
    );
  }

  // `fetchRemoteRunner` re-checks trustedHosts (D13) internally — a host
  // outside it never reaches gh, and comes back as the 'untrusted-host'
  // RemoteResult status, folded into the inconclusive bucket below.
  const remoteRes = fetchRemoteRunner(built, agentId, { config });
  const remoteStatus = remoteRes.ok ? remoteRes.value : { status: 'unavailable', reason: remoteRes.error?.message };

  if (remoteStatus.status === 'not-registered') {
    console.log(`removed — ${built.display} agent #${agentId} is no longer registered on GitHub.`);
    process.exitCode = 0;
    return;
  }
  if (remoteStatus.status === 'available') {
    err(`still-registered — ${built.display} agent #${agentId} is STILL registered on GitHub. config remove did not take effect (or hasn't run yet).`);
    process.exitCode = 1;
    return;
  }
  err(
    `inconclusive (${remoteStatus.status}) — could not confirm removal. This is NOT a confirmed success or failure; `
    + `re-run once the underlying issue (${remoteStatus.status}) is resolved.`,
  );
  process.exitCode = VERIFY_INCONCLUSIVE_EXIT[remoteStatus.status] || 2;
}

function runRemove() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'actions-runner-doctor remove' });

  if (hasFlag('verify')) {
    runRemoveVerify();
    return;
  }

  const removeIdx = process.argv.indexOf('remove');
  const selector = process.argv[removeIdx + 1];
  if (!selector || selector.startsWith('--')) {
    throw new ArgvError(
      'actions-runner-doctor remove: a selector (agentName or agentId) is required — '
      + 'e.g. `remove my-runner-name`, or use `remove --verify --host ... --owner-kind ... --owner ... --agent-id ...`.',
    );
  }
  runRemovePrepare(selector);
}

// ═══════════════════════════════════════════════════════════════════════
// Dispatch — the no-sub-command branch (`runGuarded(main)`) is exactly the
// original top-level try/catch, unchanged in behaviour.
// ═══════════════════════════════════════════════════════════════════════

function runGuarded(fn) {
  try {
    fn();
  } catch (e) {
    if (e instanceof ArgvError || e?.code === 'ARGV_ERROR') {
      err(`error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

if (SUBCOMMAND === 'local') runGuarded(runLocal);
else if (SUBCOMMAND === 'remove') runGuarded(runRemove);
else runGuarded(main);
