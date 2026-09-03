/**
 * @fileoverview The doctor's probe bodies (consumer-friction-doctor plan
 * §2.3/§2.3a). Every probe calls an EXISTING, already-correct implementation
 * — this module adapts, it never re-implements a check.
 *
 * @module scripts/lib/doctor/probes
 */
import fs from 'node:fs';
import path from 'node:path';

import { ALL_GATES, runGates } from '../sync-isolation-verify.mjs';
import { detectPackageManager, playwrightInstallHint, playwrightBootstrapHint } from '../package-manager.mjs';
import { resolveMainWorktree, planHydration, SYNCED_TOOLING_DIR } from '../../skills-hydrate.mjs';
import { checkMarkerRemedies, CONSUMER_HYDRATE_NPM_SCRIPT } from '../worktree-preflight.mjs';
import { readBundleStamp } from '../upstream/commands.mjs';
import { reportToProbeOutcome } from './report.mjs';
import {
  loadEnv, injectResolvedDbEnv, evaluateAuditSetup, evaluateAuditSupabase,
  evaluatePersonaTest, evaluateGitHub, checkPlaywrightAvailable,
} from '../../check-setup.mjs';

// ── sync-isolation-verify gate adapter (§2.3a) ──────────────────────────────
//
// "One call, not eight": `runGates` is invoked ONCE per doctor run (memoised
// per `ctx`) and the batched result is fanned out to one probe per gate, so a
// consumer's upstream report / the disposition ledger can cite the exact
// gate that failed. `gate1` (pre-migration git-status) is migration-only, not
// a health check, and is excluded via `ALL_GATES.filter`.
const SYNC_GATES = ALL_GATES.filter((g) => g !== '1');

const _syncGateCache = new WeakMap();

function computeSyncGateResults(ctx) {
  if (_syncGateCache.has(ctx)) return _syncGateCache.get(ctx);
  const results = runGates({ consumerRoot: ctx.subjectRoot, gates: SYNC_GATES });
  const byGate = new Map();
  // A single-element `[{gate:'preflight', ...}]` means the manifest itself
  // could not be loaded — every requested gate is `unknown`, not just the
  // first, because none of them could actually run.
  if (results.length === 1 && results[0].gate === 'preflight') {
    for (const g of SYNC_GATES) byGate.set(g, { gate: g, pass: null, error: results[0].error });
  } else {
    for (const r of results) byGate.set(r.gate, r);
  }
  _syncGateCache.set(ctx, byGate);
  return byGate;
}

function syncGateProbe({ gate, id, title, fix }) {
  return {
    id, title, class: 'repo', fix,
    run(ctx) {
      const r = computeSyncGateResults(ctx).get(gate);
      if (!r) return { status: 'error', detail: `gate ${gate} missing from runGates output` };
      // A missing/unreadable manifest means this class:'repo' check could not
      // run at all — round-3 audit H4: mapping this to 'unknown' let it slip
      // past --gate's fail/error-only predicate, so a consumer with no sync
      // manifest (never hydrated) got a CLEAN gate despite zero sync checks
      // having actually executed. An un-hydrated consumer is exactly the
      // friction this doctor exists to catch, so this is a real fail, not an
      // indeterminate n/a.
      if (r.pass === null) return { status: 'fail', detail: `manifest unreadable: ${r.error}` };
      if (r.pass) return { status: 'pass', detail: '' };
      return {
        status: 'fail',
        detail: r.error || (r.details ? JSON.stringify(r.details).slice(0, 300) : `gate ${gate} failed`),
      };
    },
  };
}

const SYNC_ISOLATION_PROBES = [
  syncGateProbe({
    gate: '2A', id: 'sync/tracked-diff-whitelist', title: 'Tracked-diff whitelist (sync gate 2A)',
    fix: 'Review the flagged tracked-file diffs against docs/runbooks/consumer-adoption.md, then re-sync.',
  }),
  syncGateProbe({
    gate: '2B', id: 'sync/manifest-hydration', title: 'Manifest -> disk hydration (sync gate 2B)',
    fix: 'Re-sync: npx github:Lbstrydom/claude-engineering-skills <this-repo>',
  }),
  syncGateProbe({
    gate: '2C', id: 'sync/orphaned-tooling', title: 'Orphaned synced tooling (sync gate 2C)',
    fix: 'Delete the orphaned files under scripts/.claude-skills/ not present in scripts/.sync-manifest.json, or re-sync.',
  }),
  syncGateProbe({
    gate: '3', id: 'sync/stale-paths', title: 'Stale-path / ownership (sync gate 3)',
    fix: 'Re-sync to reconcile ownership: npx github:Lbstrydom/claude-engineering-skills <this-repo>',
  }),
  syncGateProbe({
    gate: '4', id: 'sync/fresh-clone-contract', title: 'Fresh-clone executable contract (sync gate 4)',
    fix: 'Re-sync — a file required for a fresh clone to run is missing or broken: npx github:Lbstrydom/claude-engineering-skills <this-repo>',
  }),
  syncGateProbe({
    gate: '5', id: 'sync/npm-script-reconciliation', title: 'npm-script reconciliation (sync gate 5)',
    fix: 'Update package.json scripts to reference scripts/.claude-skills/ — see docs/runbooks/consumer-adoption.md Step 7.',
  }),
  syncGateProbe({
    gate: '6', id: 'sync/manifest-layout', title: 'Manifest layout === isolated (sync gate 6)',
    fix: 'Run the isolated-layout migration recipe in docs/runbooks/consumer-adoption.md "One-time migration recipe".',
  }),
  syncGateProbe({
    gate: '7', id: 'sync/gitignore-managed-block', title: '.gitignore managed block (sync gate 7)',
    fix: 'Re-sync to restore the managed .gitignore block: npx github:Lbstrydom/claude-engineering-skills <this-repo>',
  }),
  syncGateProbe({
    gate: '8', id: 'sync/skill-surface-shadowing', title: 'Skill-surface shadowing (sync gate 8)',
    fix: 'Remove the shadowing skill directory named in the finding detail — see docs/reference/skill-surface-ownership.md.',
  }),
  syncGateProbe({
    gate: '9', id: 'sync/skill-frontmatter-layout', title: 'Inert SKILL.md frontmatter declaration (sync gate 9)',
    fix: 'Dedent the named key to column 0 of the SKILL.md frontmatter (indented under `description: |` it is parsed as text and silently stops applying); re-sync if the file is bundle-owned; delete the directory if the skill is no longer shipped.',
  }),
];

// ── New probe: worktree hydration (§2.3a) ───────────────────────────────────

/**
 * Round-5 audit M12: distinguishes "no package.json" (a legitimate, silent
 * `name:null`) from "package.json exists but could not be read/parsed" (a
 * repo-integrity problem the probe should SURFACE, not quietly treat the
 * same as absence). `planHydration` itself only ever compares `name` by
 * string equality, so this keeps that contract unchanged — the error is
 * carried alongside, for the CALLER to decide whether it matters.
 * @returns {{name: string|null, error: string|null}}
 */
function readPackageName(cwd) {
  const file = path.join(cwd, 'package.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return { name: null, error: err.code === 'ENOENT' ? null : `could not read ${file}: ${err.message}` };
  }
  try {
    return { name: JSON.parse(raw).name ?? null, error: null };
  } catch (err) {
    return { name: null, error: `${file} is not valid JSON: ${err.message}` };
  }
}

function computeHydrationPlan(ctx) {
  const cwd = ctx.subjectRoot;
  const run = (cmd, args) => ctx.exec(cmd, args);
  const mainWorktree = resolveMainWorktree(run);
  const src = mainWorktree ? path.resolve(mainWorktree, SYNCED_TOOLING_DIR) : null;
  const { name: packageName, error: packageNameError } = readPackageName(cwd);
  const plan = planHydration({ cwd, mainWorktree, packageName, sourceExists: src ? fs.existsSync(src) : false });
  return packageNameError ? { ...plan, packageNameError } : plan;
}

const HYDRATION_PROBES = [
  {
    id: 'hydration/tooling-absent',
    title: 'Synced tooling present in this worktree',
    class: 'repo',
    // Static string (D8/registry schema — see machine/playwright-browser's
    // comment on why): names the package.json SCRIPT to run, not a package
    // manager's own binary, so "npm run" is a stand-in for "your package
    // manager's run-script form" (round-3 audit M2/M12) — pnpm/yarn/bun all
    // read the same scripts/skills:hydrate entry, just invoked differently.
    fix: 'Run your package manager\'s "skills:hydrate" script (e.g. `npm run skills:hydrate`, `pnpm run skills:hydrate`).',
    run(ctx) {
      const plan = computeHydrationPlan(ctx);
      // Round-5 audit M12: a package.json that exists but couldn't be
      // read/parsed is a repo-integrity problem, not "no package name" —
      // surfacing it as unknown (rather than silently falling through to
      // whatever plan.code a null name produced) tells the operator what's
      // actually wrong instead of a possibly-unrelated hydration verdict.
      if (plan.packageNameError) return { status: 'unknown', detail: plan.packageNameError };
      if (plan.code === 'source-repo') return { status: 'not_applicable', detail: plan.message };
      if (plan.code === 'main-checkout') return { status: 'pass', detail: plan.message };
      if (plan.code === 'no-git' || plan.code === 'no-tooling-in-main') {
        return { status: 'unknown', detail: plan.message };
      }
      // code === 'hydrated': a linked worktree whose tooling tree is absent.
      return { status: 'fail', detail: plan.message };
    },
  },
  {
    id: 'hydration/remedy-missing',
    title: 'package.json defines skills:hydrate (the worktree-preflight remedy)',
    class: 'repo',
    fix: CONSUMER_HYDRATE_NPM_SCRIPT,
    run(ctx) {
      const plan = computeHydrationPlan(ctx);
      if (plan.packageNameError) return { status: 'unknown', detail: plan.packageNameError };
      if (plan.code === 'source-repo') {
        return { status: 'not_applicable', detail: 'source repo — tooling is tracked, no remedy needed' };
      }
      const res = checkMarkerRemedies(ctx.subjectRoot);
      if (res.ok) return { status: 'pass', detail: '' };
      return {
        status: 'fail',
        detail: `package.json defines no "${res.missing.join('", "')}" script — the worktree-preflight `
          + 'marker names a remedy this repo cannot run.',
      };
    },
  },
];

// ── New probe: package-manager identity (§2.3a) ─────────────────────────────

const PACKAGE_MANAGER_PROBE = {
  id: 'env/package-manager',
  title: 'Package-manager identity',
  class: 'repo',
  fix: 'Declare "packageManager" in package.json (see https://nodejs.org/api/packages.html#packagemanager) rather than relying on lockfile guessing.',
  run(ctx) {
    const det = detectPackageManager(ctx.subjectRoot);
    if (det.invalidDeclaration) {
      return {
        status: 'fail',
        detail: `package.json's "packageManager" field does not parse (candidates on disk: ${det.candidates.join(', ') || 'none'})`,
      };
    }
    if (det.ambiguous) {
      return {
        status: 'warn',
        detail: `multiple lockfiles present with no "packageManager" field (${det.candidates.join(', ')}) — `
          + `defaulting to ${det.name} would risk corrupting one tree`,
      };
    }
    return { status: 'pass', detail: `${det.name} (source: ${det.source})` };
  },
};

// ── check-setup adapters (§2.3a) ────────────────────────────────────────────

function checkSetupProbe({ id, title, fix, evaluate, needsDb = false, cls = 'repo' }) {
  return {
    id, title, class: cls, fix,
    async run(ctx) {
      const env = loadEnv(ctx.subjectRoot);
      if (needsDb) injectResolvedDbEnv(env, ctx.subjectRoot);
      let result;
      try {
        result = await evaluate(env, ctx.subjectRoot);
      } catch (err) {
        return { status: 'error', detail: `adapter threw: ${err?.message ?? err}` };
      }
      return reportToProbeOutcome(result);
    },
  };
}

const CHECK_SETUP_PROBES = [
  checkSetupProbe({
    id: 'setup/audit-api-keys',
    title: 'Audit-loop API keys (OpenAI/Gemini/Anthropic/Azure)',
    fix: 'Add the missing key(s) to .env — see the finding detail for which.',
    evaluate: (env, repoPath) => evaluateAuditSetup(env, repoPath),
  }),
  checkSetupProbe({
    id: 'setup/audit-supabase',
    title: 'Audit-loop Postgres store (AUDIT_DB_URL + tables)',
    fix: 'Set AUDIT_DB_URL in .env and run `node scripts/setup-postgres.mjs --migrate` (see the finding detail).',
    evaluate: (env, repoPath) => evaluateAuditSupabase(env, repoPath),
    needsDb: true,
  }),
  checkSetupProbe({
    id: 'setup/persona-test-tables',
    title: 'Persona-test Postgres tables',
    fix: 'Set AUDIT_DB_URL in .env and run `node scripts/setup-postgres.mjs --migrate` (see the finding detail).',
    evaluate: (env, repoPath) => evaluatePersonaTest(env, repoPath),
    needsDb: true,
  }),
  checkSetupProbe({
    id: 'machine/github-permissions',
    title: 'GitHub token source + read-only permission probe',
    // `class: 'machine'`, deliberately: what this reads is a MACHINE/account
    // fact (which token your shell, your .env and `gh`'s keyring hold, and
    // what GitHub grants it) — not repo state. Gate level follows the kind of
    // state read: repo state may block a push, machine state may only advise.
    // A CI runner with a scoped ephemeral token would otherwise fail a gate
    // for a permission its human operator never needs.
    fix: 'See the finding detail: it names the missing permission, the endpoint that needs it, and which token source was used.',
    evaluate: (env, repoPath) => evaluateGitHub(env, repoPath),
    cls: 'machine',
  }),
];

// ── Machine-state probe: browser (never gates — D9) ─────────────────────────

const BROWSER_PROBE = {
  id: 'machine/playwright-browser',
  title: 'Playwright + Chromium (browser-driven UX lenses)',
  class: 'machine',
  // Static fallback only — a probe's `fix` is a registration-time string
  // (D8/registry schema), fixed before `ctx.subjectRoot` exists to detect a
  // package manager from. `run()` below computes the real,
  // package-manager-correct hint and puts it in `detail`, which is what the
  // human/JSON report actually surfaces (round-3 audit M2/M12: this fix
  // string previously claimed the detail carried this but the code never
  // actually called playwrightInstallHint/playwrightBootstrapHint).
  fix: 'npx playwright install chromium (see the finding detail for the package-manager-correct form)',
  async run(ctx) {
    const pw = await checkPlaywrightAvailable();
    if (!pw.available) {
      return { status: 'warn', detail: `Playwright unavailable — ${pw.reason} — run: ${playwrightBootstrapHint(ctx.subjectRoot)}` };
    }
    if (!pw.browserBinary) {
      return { status: 'warn', detail: `Chromium binary not detected — ${pw.reason} — run: ${playwrightInstallHint(ctx.subjectRoot)}` };
    }
    return { status: 'pass', detail: pw.version || '(installed)' };
  },
};

// ── Machine-state probe: git's checkout EOL filter (never gates — D9) ───────

/**
 * Values `core.autocrlf` can hold, normalised to the three behaviours that
 * matter. Git's bool parser accepts more spellings than `true`/`false`, and a
 * probe that only recognised those two would read `yes` as unrecognised and a
 * genuinely-converting machine as fine.
 */
const AUTOCRLF_ENABLED = new Set(['true', 'yes', 'on', '1']);
const AUTOCRLF_DISABLED = new Set(['false', 'no', 'off', '0']);

/**
 * Read one git config key together with the FILE it came from, without
 * throwing when the key is simply unset.
 *
 * `--show-origin` rather than a bare `--get` is the entire point of this
 * helper. On Windows `git config --get core.autocrlf` answers `true` with exit
 * 0 in every repo — because Git for Windows writes it into the SYSTEM config
 * (`C:/Program Files/Git/etc/gitconfig`) at install time. Without the origin
 * the value reads as a repo-local setting and sends whoever is debugging it
 * looking for a cause in the repo, which is not where the fix lives.
 *
 * @param {object} ctx doctor context (`exec` runs in `subjectRoot`)
 * @param {string} key config key
 * @returns {{set: true, value: string, origin: string} | {set: false} | {error: string}}
 */
function readGitConfigWithOrigin(ctx, key) {
  let out;
  try {
    out = ctx.exec('git', ['config', '--show-origin', '--get', key]);
  } catch (err) {
    // `git config --get` exits 1 for an unset key — an ordinary answer, not a
    // failure. Anything else (git absent, not a repo) genuinely could not be
    // measured and must NOT read as "unset, therefore fine".
    if (err?.status === 1) return { set: false };
    return { error: err?.message ?? String(err) };
  }
  const line = String(out).replace(/\r?\n$/, '');
  if (!line) return { set: false };
  const tab = line.indexOf('\t');
  if (tab < 0) return { set: true, value: line.trim(), origin: '(origin not reported)' };
  return { set: true, value: line.slice(tab + 1).trim(), origin: line.slice(0, tab) };
}

const AUTOCRLF_PROBE = {
  id: 'machine/git-autocrlf',
  title: 'git core.autocrlf (checkout line-ending filter)',
  // `class: 'machine'`, deliberately — and this holds even when the value comes
  // from the repo's own `.git/config`, because that file is NOT committed.
  // Gate level follows the KIND of state read: nothing here is committed-or-
  // derivable, so it may advise and must never block a push.
  class: 'machine',
  fix: 'git config --global core.autocrlf input — `input` rather than `false`, so working files that are already CRLF do not start reading as modified against an LF index.',
  run(ctx) {
    const cfg = readGitConfigWithOrigin(ctx, 'core.autocrlf');
    if (cfg.error) {
      return { status: 'unknown', detail: `could not read core.autocrlf: ${cfg.error}` };
    }
    if (!cfg.set) {
      return { status: 'pass', detail: 'unset — git\'s built-in default is false, so checkout does not rewrite line endings' };
    }
    const value = cfg.value.toLowerCase();
    if (value === 'input' || AUTOCRLF_DISABLED.has(value)) {
      return { status: 'pass', detail: `${cfg.value} (from ${cfg.origin}) — checkout does not rewrite line endings` };
    }
    if (AUTOCRLF_ENABLED.has(value)) {
      return {
        status: 'warn',
        detail: `${cfg.value} (from ${cfg.origin}) — git rewrites LF to CRLF at checkout for every path no `
          + '.gitattributes pins. This bundle\'s own surfaces are immune (the sync writes LF and pins them '
          + '`text eol=lf`), but any other tool that clones a repo and copies its working-tree bytes will '
          + 'deliver CRLF — measured 2026-09-02, that is how `npx skills add` put 41 CRLF files into a consumer.',
      };
    }
    return { status: 'unknown', detail: `unrecognised value ${JSON.stringify(cfg.value)} (from ${cfg.origin}) — cannot say what checkout will do` };
  },
};

// ── Machine-state probes that name a command rather than importing it ──────
//
// `runner:doctor` and `azure:doctor --routes` are their own CLIs, reading
// machine state (a `gh` identity's runner-provisioning rights; live Azure
// route probes), and `azure:doctor --fix` WRITES a `.env` — folding a writer
// into a diagnostic is the over-engineering cliff §2.1 rejects. Registered so
// they still SHOW UP in one report; never called, never gated (class:'machine').

const NAMED_COMMAND_PROBES = [
  {
    id: 'machine/runner-doctor',
    title: 'GitHub Actions self-hosted runner feasibility',
    class: 'machine',
    fix: 'Run your package manager\'s "runner:doctor" script (e.g. `npm run runner:doctor`).',
    run: () => ({ status: 'not_applicable', detail: 'run the "runner:doctor" script yourself — reads your own gh identity' }),
  },
  {
    id: 'machine/azure-routes',
    title: 'Azure work-profile routes + credentials',
    class: 'machine',
    fix: 'Run your package manager\'s "azure:routes" script (e.g. `npm run azure:routes`).',
    run: () => ({ status: 'not_applicable', detail: 'run the "azure:routes" script yourself — only relevant under the Azure work profile' }),
  },
];

// ── Bundle provenance (§2.6) ─────────────────────────────────────────────────

/**
 * `owner/repo` for the npx `github:` bootstrap spec, derived from the
 * BUNDLE's own `package.json.repository.url` — never hardcoded (round-5
 * audit M18: a fork with a different `repository` would otherwise get a
 * remediation command pointing at the WRONG upstream). Resolved from
 * `bundleRoot` (this running copy's own root), not `ctx.subjectRoot` — the
 * bootstrap source is a property of the CODE, not of the repo being
 * diagnosed. Falls back to this project's own known slug only if resolution
 * genuinely fails (missing/malformed package.json, non-GitHub repository) —
 * a probe must still emit SOME actionable command rather than none.
 */
export function resolveBundleGithubSpec(bundleRoot) {
  const FALLBACK = 'Lbstrydom/claude-engineering-skills';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'package.json'), 'utf-8'));
    const raw = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url;
    const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(String(raw || ''));
    return m ? `${m[1]}/${m[2]}` : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

const PROVENANCE_PROBE = {
  id: 'provenance/bundle-mismatch',
  title: 'Installed bundle matches the consumer\'s last-synced manifest SHA',
  class: 'repo',
  fix: 'Re-run the installer at the consumer\'s currently-synced SHA (see the finding detail for the exact command), or see docs/runbooks/consumer-adoption.md\'s fresh-install recipe if no synced SHA is on record.',
  run(ctx) {
    // Only meaningful when `install.mjs doctor` resolved a fresh stage-1 SHA
    // for THIS invocation — a directly-invoked doctor has nothing new to
    // compare its own manifest against.
    if (!ctx.resolvedBundleSha) {
      return { status: 'not_applicable', detail: 'not invoked via `install.mjs doctor` — no newly-resolved bundle SHA to compare' };
    }
    const stamp = readBundleStamp(ctx.subjectRoot);
    if (!stamp?.commitSha) {
      return { status: 'unknown', detail: 'scripts/.sync-manifest.json has no commitSha on record — cannot compare' };
    }
    if (stamp.commitSha === ctx.resolvedBundleSha) {
      return { status: 'pass', detail: `bundle at ${ctx.resolvedBundleSha.slice(0, 12)}` };
    }
    return {
      status: 'warn',
      detail: `resolved bundle ${ctx.resolvedBundleSha.slice(0, 12)} != consumer's synced SHA `
        + `${stamp.commitSha.slice(0, 12)} — to re-sync at the consumer's own recorded SHA: `
        + `npx github:${resolveBundleGithubSpec(ctx.bundleRoot)}#${stamp.commitSha} ${ctx.subjectRoot}`,
    };
  },
};

/** Every probe, in registration order. */
export const PROBES = [
  ...HYDRATION_PROBES,
  PACKAGE_MANAGER_PROBE,
  ...SYNC_ISOLATION_PROBES,
  ...CHECK_SETUP_PROBES,
  BROWSER_PROBE,
  AUTOCRLF_PROBE,
  ...NAMED_COMMAND_PROBES,
  PROVENANCE_PROBE,
];
