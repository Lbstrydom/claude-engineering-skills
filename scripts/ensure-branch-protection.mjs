#!/usr/bin/env node
/**
 * @fileoverview Strengthen-only main-branch protection. Ensures
 * `strict_required_status_checks_policy: true` ("Require branches to be up to
 * date before merging") on a repo's EXISTING branch ruleset — closing the
 * stale-baseline ratchet failure class: a branch cut before a main-derived
 * baseline (Snyk, schema) landed fails the ratchet on phantom findings, even
 * on PRs that touch nothing security-related.
 *
 * STRENGTHEN-ONLY: it never creates a ruleset. A repo with no PR/status-check
 * flow (a direct-push consumer) has no ratchet to strengthen and is left as-is
 * — imposing PR-protection there is a workflow change, not a safety fix.
 *
 * Auto-detects the target repo from `origin` (or pass `--repo owner/name`), so
 * a freshly-cloned consumer can self-apply: `npm run protect:main:apply`.
 * (Server-side settings can't apply on `git clone` itself — git has no
 * post-clone hook, and a clone shouldn't silently change a repo's settings —
 * so this is the one-command setup step, documented in consumer-adoption.md.)
 *
 * Requires the `gh` CLI, authenticated with admin on the target repo.
 *
 * Usage:
 *   node scripts/ensure-branch-protection.mjs            # dry-run (preview)
 *   node scripts/ensure-branch-protection.mjs --apply    # write changes
 *   node scripts/ensure-branch-protection.mjs --repo Lbstrydom/wine-cellar-app --apply
 *   node scripts/ensure-branch-protection.mjs --json
 *
 * Exit codes:
 *   0 — ran (whether or not a change was needed/applied)
 *   1 — could not determine the repo, `gh` missing/unauthed, or an API call failed
 */
import { execFileSync } from 'node:child_process';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { parseOriginRepo, strengthenRuleset, hasStatusCheckRatchet } from './lib/branch-protection.mjs';

// CLI relocation smoke contract (AGENTS.md CLI_SMOKE_SET) — proves imports
// survive relocation into a consumer's scripts/.claude-skills/.
if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

const KNOWN_FLAGS = ['--apply', '--json', '--repo', '--selfcheck-relocation'];

const APPLY = process.argv.includes('--apply');
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
    const stderr = (e.stderr || '').toString().trim();
    if (e.code === 'ENOENT') {
      throw new Error('the `gh` CLI is not installed or not on PATH — install GitHub CLI and `gh auth login`');
    }
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr || e.message}`);
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

function main() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'ensure-branch-protection' });
  const summary = { repo: null, rulesets: [], changed: [], dryRun: !APPLY };
  let slug;
  try {
    slug = resolveRepoSlug();
    summary.repo = slug;
  } catch (e) {
    err(`error: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  let list;
  try {
    list = JSON.parse(gh(['api', `repos/${slug}/rulesets`]));
  } catch (e) {
    err(`error: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const branchRulesets = (Array.isArray(list) ? list : []).filter((r) => r.target === 'branch');
  if (branchRulesets.length === 0) {
    // Strengthen-only: nothing to attach to. Not an error — a direct-push repo.
    const msg = `${slug}: no branch rulesets — no status-check ratchet to strengthen (direct-push repo; left as-is).`;
    JSON_OUT ? console.log(JSON.stringify({ ...summary, note: 'no-ratchet' })) : console.log(msg);
    return;
  }

  for (const stub of branchRulesets) {
    let full;
    try {
      full = JSON.parse(gh(['api', `repos/${slug}/rulesets/${stub.id}`]));
    } catch (e) {
      err(`error: reading ruleset ${stub.id}: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    const entry = { id: stub.id, name: full.name, hasRatchet: hasStatusCheckRatchet(full), strictNow: false };
    if (!entry.hasRatchet) {
      summary.rulesets.push(entry);
      continue;
    }
    const { changed, body } = strengthenRuleset(full);
    entry.strictNow = !changed; // if not changed, it was already strict
    summary.rulesets.push(entry);
    if (!changed) continue;

    if (!APPLY) {
      summary.changed.push({ id: stub.id, name: full.name, applied: false });
      if (!JSON_OUT) console.log(`  would strengthen  "${full.name}" (${slug}) → strict_required_status_checks_policy=true`);
      continue;
    }
    try {
      gh(['api', '--method', 'PUT', `repos/${slug}/rulesets/${stub.id}`, '--input', '-'], {
        input: JSON.stringify(body),
      });
      entry.strictNow = true;
      summary.changed.push({ id: stub.id, name: full.name, applied: true });
      if (!JSON_OUT) console.log(`  strengthened  "${full.name}" (${slug}) → require branches up to date = ON`);
    } catch (e) {
      err(`error: updating ruleset ${stub.id}: ${e.message}`);
      process.exitCode = 1;
      return;
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(summary));
  } else if (summary.changed.length === 0) {
    console.log(`${slug}: already up to date — every status-check ruleset requires branches current with base. No change.`);
  } else if (!APPLY) {
    console.log(`\n${summary.changed.length} ruleset(s) would change. Re-run with --apply to write.`);
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
