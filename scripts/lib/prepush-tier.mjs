/**
 * @fileoverview The pre-push sandbox's tiered check run (docs/plans/gate-cost-slice-2.md sections 2.2-2.5, 13).
 * Pure orchestration over an injected `run`, so every branch is testable without a gate: which checks run, in what
 * order, what is printed, and the ONE summary line the hook reads back.
 *
 * The order is fixed: the static gates, then the oracle, then the tests. A failing static gate stops before any test
 * runs. The oracle may fail in any way (a missing script, a git error, an envelope that does not validate) and the
 * answer is always the same: the FULL suite, with the reason printed (guard 4: failure of the cheap path costs time,
 * never coverage). A head that predates the tier runs the legacy `npm run check` unchanged (D7b).
 *
 * @module scripts/lib/prepush-tier
 */
import { toShellExitCode } from './cli-io.mjs';
import { TIER_PROTOCOL_MARKER, envelopeMatchesRequest, parseTierEnvelope, shadowLine, summaryLine, tierBanner, validateEnvelopeAgainstList, parseHeavyList } from './test-tier.mjs';

/** The files a head must carry for the tiered path to exist in its own sandbox. */
export const SANDBOX_TIER_FILES = Object.freeze(['scripts/lib/test-tier.mjs', 'scripts/lib/test-tier-git.mjs', 'scripts/test-tier.mjs', '.test-tiers.json']);

/**
 * D7b: the SANDBOX's own tree decides whether the tiered path exists. `readText` returns a file's text or null.
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function sandboxTierSupport({ readText, exists }) {
  let pkg;
  try { pkg = JSON.parse(readText('package.json') ?? 'null'); } catch { pkg = null; }
  if (!pkg?.scripts?.['check:static']) return { ok: false, reason: 'package.json has no check:static' };
  for (const f of SANDBOX_TIER_FILES) if (!exists(f)) return { ok: false, reason: `${f} is missing` };
  const runner = readText('scripts/run-tests.mjs');
  if (runner === null || !runner.includes(TIER_PROTOCOL_MARKER)) return { ok: false, reason: 'scripts/run-tests.mjs does not declare TIER_PROTOCOL' };
  return { ok: true };
}

/**
 * Run the checks for one push.
 *
 * @param {object} a
 * @param {string} a.head full commit id
 * @param {string|null|undefined} a.tier the pusher's request (`--tier` / `AUDIT_PREPUSH_TIER`); empty means the default
 * @param {boolean} a.pushesDefault
 * @param {{ok: boolean, reason?: string}} a.support from {@link sandboxTierSupport}
 * @param {(kind: 'npm'|'node', args: string[], opts?: {capture?: boolean}) => {status: number|null, stdout?: string, error?: Error}} a.run
 * @param {(p: string) => string|null} a.readText reads a file in the sandbox
 * @param {string} a.envelopePath
 * @param {(line: string) => void} a.log
 * @returns {{status: number, summary: string|null}} `summary` is null when no tests ran (a failing static gate)
 */
export function runTieredChecks({ head, tier, pushesDefault, support, run, readText, envelopePath, log }) {
  const finish = (status, ran, skipped, base, reason) => ({ status, summary: status === 0 ? summaryLine({ tier: ran, head, skipped, base, reason }) : null });

  if (!support.ok) {
    log(`  tier: this head predates the test tier (${support.reason}); running the legacy full check`);
    const r = run('npm', ['run', 'check']);
    if (r.error) throw new Error(`could not run checks: ${r.error.message}`);
    return finish(toShellExitCode(r.status), 'full', 0, null, 'head-predates-tier');
  }

  const st = run('npm', ['run', 'check:static']);
  if (st.error) throw new Error(`could not run checks: ${st.error.message}`);
  if (toShellExitCode(st.status) !== 0) return { status: toShellExitCode(st.status), summary: null };

  // The oracle. ANY failure here is the full suite, said out loud.
  let envelope = null;
  let failure = null;
  try {
    const args = ['scripts/test-tier.mjs', 'plan', '--head', head, '--out', envelopePath];
    if (tier) args.push('--tier', tier);
    if (pushesDefault) args.push('--pushes-default');
    const p = run('node', args, { capture: true });
    if (p.error || toShellExitCode(p.status) !== 0) failure = `the selector exited ${p.status ?? 'abnormally'}${p.error ? ` (${p.error.message})` : ''}`;
    else {
      const parsed = parseTierEnvelope(readText(envelopePath) ?? '');
      if (!parsed.ok) failure = parsed.reason;
      else {
        const list = parseHeavyList(readText('.test-tiers.json') ?? '');
        const valid = list.ok ? validateEnvelopeAgainstList(parsed.envelope, list.list) : { ok: false, reason: list.reason };
        if (!valid.ok) failure = valid.reason;
        else if (parsed.envelope.head !== head) failure = `the envelope is for ${String(parsed.envelope.head).slice(0, 8)}, not ${head.slice(0, 8)}`;
        else {
          const agrees = envelopeMatchesRequest(parsed.envelope, { tier, pushesDefault, list: list.ok ? list.list : null });
          if (!agrees.ok) failure = agrees.reason;
          else envelope = parsed.envelope;
        }
      }
    }
  } catch (e) { failure = `the selector threw: ${e.message}`; }

  if (failure) {
    log(`  tier: selector failed, so the FULL suite runs (${failure})`);
    const t = run('npm', ['test']);
    if (t.error) throw new Error(`could not run checks: ${t.error.message}`);
    return finish(toShellExitCode(t.status), 'full', 0, null, 'selector-failed');
  }

  const base = envelope.base ?? null;
  if (envelope.tier === 'branch') {
    log(`  ${tierBanner(envelope)}`);
    const t = run('node', ['scripts/run-tests.mjs', '--tier-skip', envelopePath]);
    if (t.error) throw new Error(`could not run checks: ${t.error.message}`);
    return finish(toShellExitCode(t.status), 'branch', envelope.skipped.length, base, null);
  }

  // Stage 0 / any full: say what the branch tier would have done, then run everything.
  log(`  ${shadowLine(envelope)}`);
  const t = run('npm', ['test']);
  if (t.error) throw new Error(`could not run checks: ${t.error.message}`);
  const forced = envelope.escapes.find((e) => ['pushes-default', 'forced-full', 'unknown-tier-request'].includes(e.id));
  return finish(toShellExitCode(t.status), 'full', 0, base, forced?.id ?? (envelope.requestedRaw === null ? 'default' : null));
}
