#!/usr/bin/env node
/**
 * @fileoverview `doctor` — the ONE consumer-side command covering every known
 * adoption-friction failure class (consumer-friction-doctor plan).
 *
 * Before this, a consumer hitting friction had to already know which of five
 * scattered tools answered their question — `check-setup.mjs`,
 * `sync-isolation-verify.mjs`, `worktree:preflight:gate`, `runner:doctor`,
 * `azure:doctor` — four of which are source-repo-only npm scripts that do not
 * exist in a consumer's package.json. This aggregates every probe body (all
 * pre-existing, called never re-implemented — AGENTS.md #1/#5) into one
 * report, each finding carrying a `fix` string (D8).
 *
 * Usage:
 *   node scripts/doctor.mjs                        # human report, exit 0
 *   node scripts/doctor.mjs --json                  # machine-readable
 *   node scripts/doctor.mjs --gate                  # non-zero exit iff a
 *                                                     class:'repo' probe FAILs/ERRORs
 *   node scripts/doctor.mjs --only <id,id,...>       # narrow the printed report
 *                                                     (never narrows the --gate set — §2.3)
 *   node scripts/doctor.mjs --consumer-root <path>   # diagnose a repo other
 *                                                     than the one this code runs in
 *
 * Exit codes:
 *   0  reported (advisory default — findings are payload, not failure; D9/§4)
 *   1  --gate was passed and at least one class:'repo' probe FAILed/ERRORed
 *   2  usage error (root resolution failure, unknown flag)
 *
 * @module scripts/doctor
 */
import { assertKnownFlags, ArgvError, emit } from './lib/cli-io.mjs';
import { buildDoctorContext } from './lib/doctor/context.mjs';
import { REGISTRY, validateRegistry, runProbe, probeIds } from './lib/doctor/registry.mjs';
import { resolveCloudConfig, discoverLocalEnvPath } from './lib/shared-cloud-config.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const KNOWN_FLAGS = ['--json', '--gate', '--only', '--consumer-root', '--bundle-sha', '--selfcheck-relocation'];

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', C = '\x1b[36m', X = '\x1b[0m';

function statusIcon(status) {
  switch (status) {
    case 'pass': return `${G}PASS${X}`;
    case 'fail': return `${R}FAIL${X}`;
    case 'warn': return `${Y}WARN${X}`;
    case 'error': return `${R}ERR ${X}`;
    case 'unknown': return `${C}UNK ${X}`;
    case 'not_applicable': return `${D}N/A ${X}`;
    default: return status;
  }
}

/**
 * Shared by `--only`/`--bundle-sha` below. Stops at the POSIX `--`
 * terminator and never treats a FOLLOWING flag as this option's value
 * (round-1 audit H6/H10) — `doctor.mjs --only --gate` used to silently
 * consume `--gate` as the `--only` value, leaving `--gate` itself unparsed.
 *
 * Three outcomes, not two (round-3 audit M15 — same collapse H10 fixed for
 * `--consumer-root` had not been carried over here): `{present:false}` (flag
 * absent) and `{present:true, value:null}` (flag given with no usable value)
 * used to both read as a bare `null`, so `doctor.mjs --only` at the end of
 * argv silently behaved as "no filter" instead of erroring on a clearly
 * mistyped invocation.
 */
function flagValue(argv, name) {
  const stop = argv.indexOf('--');
  const region = stop < 0 ? argv : argv.slice(0, stop);
  for (let i = 0; i < region.length; i++) {
    const a = region[i];
    if (a.startsWith(`--${name}=`)) {
      const v = a.slice(name.length + 3);
      // Empty string is "no usable value" too (round-4 audit H1's 3rd
      // sub-claim) — an explicit `--only ''` (space-separated empty arg)
      // wasn't caught by the `next.startsWith('--')` check below, since ''
      // doesn't start with '--' either; it silently returned '' as a truthy
      // "present" value, and main()'s `onlyRaw ? ... : null` then read the
      // falsy '' as "no filter" — exactly the opposite of the caller having
      // explicitly (if uselessly) asked for one.
      return { present: true, value: v || null };
    }
    if (a === `--${name}`) {
      const next = region[i + 1];
      const value = next !== undefined && next !== '' && !next.startsWith('--') ? next : null;
      return { present: true, value };
    }
  }
  return { present: false, value: null };
}

export function onlyFlagValue(argv) {
  const f = flagValue(argv, 'only');
  if (f.present && f.value == null) {
    throw new Error('--only was given with no usable value (missing, or the next token looks like another flag)');
  }
  return f.value;
}

export function bundleShaFlagValue(argv) {
  const f = flagValue(argv, 'bundle-sha');
  if (f.present && f.value == null) {
    throw new Error('--bundle-sha was given with no usable value (missing, or the next token looks like another flag)');
  }
  return f.value;
}

/**
 * `--gate`'s predicate, total (§2.3): non-zero iff any `class:'repo'` probe
 * returned `fail` or `error` — `warn`/`unknown`/`not_applicable` never gate,
 * and `class:'machine'` never gates regardless of status.
 */
function gatingFindings(results) {
  return results.filter((r) => r.class === 'repo' && (r.status === 'fail' || r.status === 'error'));
}

function printHuman(results, gating, { gateMode, onlyIds }) {
  console.log('');
  console.log(`${B}═══════════════════════════════════════${X}`);
  console.log(`${B}  DOCTOR${X}`);
  console.log(`${B}═══════════════════════════════════════${X}`);
  console.log('');

  const shown = onlyIds ? results.filter((r) => onlyIds.includes(r.id)) : results;
  for (const r of shown) {
    console.log(`  [${statusIcon(r.status)}] ${r.id}  ${D}${r.title}${X}`);
    if (r.detail) console.log(`         ${D}${r.detail}${X}`);
    if (r.status === 'fail' || r.status === 'error' || r.status === 'warn') {
      console.log(`         ${C}Fix: ${r.fix}${X}`);
    }
  }
  console.log('');

  // Opacity fix (§2.3, closes R3-H4): gating failures are ALWAYS listed here,
  // even when --only filtered them out of the primary section above — a bare
  // "exited 1" with no visible reason contradicts D8's actionable-fix guarantee.
  if (gating.length > 0) {
    console.log(`${B}Gating findings${X} ${D}(class:'repo', status fail/error — these decide the exit code)${X}`);
    for (const r of gating) {
      console.log(`  [${statusIcon(r.status)}] ${r.id}  ${D}${r.detail}${X}`);
      console.log(`         ${C}Fix: ${r.fix}${X}`);
    }
    console.log('');
  }

  console.log(`${B}═══════════════════════════════════════${X}`);
  if (gateMode) {
    console.log(`  ${gating.length > 0 ? `${R}${gating.length} gating finding(s)${X}` : `${G}no gating findings${X}`}`);
  } else {
    const fails = results.filter((r) => r.status === 'fail').length;
    const warns = results.filter((r) => r.status === 'warn').length;
    console.log(`  ${fails > 0 ? `${R}${fails} fail(s)${X}` : ''}${fails > 0 && warns > 0 ? ', ' : ''}${warns > 0 ? `${Y}${warns} warn(s)${X}` : ''}${fails === 0 && warns === 0 ? `${G}all clear${X}` : ''}`);
    console.log(`  ${D}Re-run with --gate to get a CI-style exit code${X}`);
  }
  console.log(`${B}═══════════════════════════════════════${X}`);
  console.log('');
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'doctor' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }

  const reg = validateRegistry();
  if (!reg.ok) {
    process.stderr.write(`doctor: the probe registry itself is invalid — refusing to run.\n${reg.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(2);
  }

  let doctorCtx, resolvedBundleSha, onlyIds;
  try {
    doctorCtx = buildDoctorContext(process.argv);
    resolvedBundleSha = bundleShaFlagValue(process.argv);
    const onlyRaw = onlyFlagValue(process.argv);
    onlyIds = onlyRaw ? onlyRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
    // `--only` given but every entry was blank (e.g. `--only=,,,`) is a
    // DIFFERENT state from `--only` never being passed at all (round-5 audit
    // L2) — the operator supplied a value, so silently falling back to "no
    // filter" (or worse, filtering to nothing) is not what was asked for.
    if (onlyRaw && onlyIds.length === 0) {
      throw new Error(`--only "${onlyRaw}" contains no valid probe id(s) after trimming`);
    }
    // Round-3 audit M15's second sub-claim: a typo'd/misspelled `--only` id
    // used to silently produce an empty-looking filtered report (nothing
    // matched, no error) rather than telling the operator their id was wrong.
    if (onlyIds) {
      const known = new Set(probeIds());
      const unknown = onlyIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new Error(`--only names unknown probe id(s): ${unknown.join(', ')} — see probeIds() for the valid set`);
      }
    }
  } catch (err) {
    process.stderr.write(`doctor: ${err.message}\n`);
    process.exit(2);
    return;
  }

  // Round-4 audit M4: a bare `process.env.AUDIT_DB_URL` check reads THIS
  // process's ambient environment, not necessarily the diagnosed repo's own
  // configuration — the same divergence `install.mjs doctor <target>`
  // exists to bridge everywhere else (subjectRoot may differ from where
  // this process happens to be running). Resolve through the same
  // resolveCloudConfig() shared-config layering `setup/audit-supabase`'s
  // probe already uses (local .env under subjectRoot, then ~/.audit-loop.env,
  // then the ambient process env) — no `lib/load-env.mjs` side-effect import
  // is needed here since `resolveCloudConfig` reads files directly rather
  // than mutating `process.env`.
  const resolvedCloud = resolveCloudConfig({ localEnvPath: discoverLocalEnvPath(doctorCtx.subjectRoot) });

  const ctx = {
    ...doctorCtx,
    exec: (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', cwd: doctorCtx.subjectRoot, ...opts }),
    fs,
    cloud: !!resolvedCloud.AUDIT_DB_URL?.value,
    resolvedBundleSha,
  };

  const results = [];
  for (const probe of REGISTRY) {
    results.push(await runProbe(probe, ctx)); // eslint-disable-line no-await-in-loop -- probes run sequentially; the set is small (~19) and several share the memoised sync-gate cache, so parallelising buys nothing here.
  }

  const gateMode = process.argv.includes('--gate');
  const gating = gatingFindings(results);

  if (process.argv.includes('--json')) {
    emit({
      ok: !gateMode || gating.length === 0,
      subjectRoot: ctx.subjectRoot,
      results: onlyIds ? results.filter((r) => onlyIds.includes(r.id)) : results,
      gatingFindings: gating,
    });
  } else {
    printHuman(results, gating, { gateMode, onlyIds });
  }

  process.exit(gateMode && gating.length > 0 ? 1 : 0);
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('doctor.mjs');

if (invokedDirectly) {
  try {
    await main();
  } catch (err) {
    console.error(`doctor failed: ${err.message}`);
    process.exit(1);
  }
}
