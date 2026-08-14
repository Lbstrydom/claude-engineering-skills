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
 * Usage:
 *   node scripts/actions-runner-doctor.mjs
 *   node scripts/actions-runner-doctor.mjs --repo wartsila-software/some-repo
 *   node scripts/actions-runner-doctor.mjs --json
 *
 * Exit codes:
 *   0 — ran and produced a verdict (viable, no-admin-rights, actions-disabled, or unknown)
 *   1 — could not determine the repo, or `gh` is missing/unauthed
 *
 * @module scripts/actions-runner-doctor
 */
import { execFileSync } from 'node:child_process';
import { assertKnownFlags, ArgvError, emit } from './lib/cli-io.mjs';
import { parseOriginRepo } from './lib/branch-protection.mjs';
import { assessRunnerFallback, runnerAssetTokens } from './lib/runner-fallback.mjs';

// CLI relocation smoke contract (AGENTS.md CLI_SMOKE_SET) — proves imports
// survive relocation into a consumer's scripts/.claude-skills/.
if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

const KNOWN_FLAGS = ['--repo', '--json', '--selfcheck-relocation'];

const JSON_OUT = process.argv.includes('--json');
const repoArg = (() => {
  const i = process.argv.indexOf('--repo');
  return i === -1 ? null : process.argv[i + 1];
})();

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

function resolveRepoSlug() {
  if (repoArg) return repoArg;
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('no --repo given and could not read `git remote get-url origin`');
  }
  const parsed = parseOriginRepo(url);
  if (!parsed) throw new Error(`origin remote is not a recognisable GitHub URL: ${url}`);
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

try {
  main();
} catch (e) {
  if (e instanceof ArgvError || e?.code === 'ARGV_ERROR') {
    err(`error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
