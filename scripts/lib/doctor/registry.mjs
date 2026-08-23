/**
 * @fileoverview The doctor's probe registry — one frozen array, one authority
 * for probe ids (consumer-friction-doctor plan §2.3).
 *
 * `scripts/upstream-dispositions.json`'s `probe:<id>` references resolve
 * against THIS module's `probeIds()` — renaming a probe id is therefore a
 * two-sided edit the ratchet gate (`check-upstream-probe-coverage.mjs`)
 * catches, not a silent drift.
 *
 * @module scripts/lib/doctor/registry
 */
import { PROBE_STATUSES } from './report.mjs';
import { PROBES } from './probes.mjs';

/**
 * Every probe: `{id, title, class, fix, run}`.
 *
 *   - `id`    stable, referenced by the disposition ledger — never reuse a
 *             retired id for something else.
 *   - `class` `'repo'` (committed-or-derivable state; may gate) or
 *             `'machine'` (per-developer state; never gates — D9).
 *   - `fix`   required, non-empty (D8) — a probe with no actionable fix
 *             string cannot be registered; validated below, not just typed.
 *   - `run`   `(ctx) => {status, detail}` — `status` MUST be one of
 *             `PROBE_STATUSES`; the registry does not trust this at runtime
 *             beyond what `runProbe` validates (a probe body that returns
 *             garbage is a registry bug, not a repo finding).
 */
export const REGISTRY = Object.freeze(PROBES.map((p) => Object.freeze({ ...p })));

/** Stable ids, in registration order. */
export function probeIds() {
  return REGISTRY.map((p) => p.id);
}

/**
 * Registry self-check — every probe has a non-empty `id`/`fix`, a `class` in
 * the closed set, `run` is a function, and no id repeats. Called by
 * `doctor.mjs` at startup (fail fast on a malformed registry) and by
 * `check-upstream-probe-coverage.mjs` (a `probe:` reference must resolve
 * against a REGISTRY that is itself valid, or the gate is checking against
 * garbage).
 *
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateRegistry() {
  const problems = [];
  const seen = new Set();
  for (const p of REGISTRY) {
    if (!p.id || typeof p.id !== 'string') problems.push(`a probe has a missing/non-string id: ${JSON.stringify(p)}`);
    else if (seen.has(p.id)) problems.push(`duplicate probe id: ${p.id}`);
    else seen.add(p.id);

    if (!['repo', 'machine'].includes(p.class)) {
      problems.push(`${p.id || '<unknown>'}: class must be 'repo' or 'machine', got ${JSON.stringify(p.class)}`);
    }
    if (typeof p.fix !== 'string' || !p.fix.trim()) {
      problems.push(`${p.id || '<unknown>'}: fix must be a non-empty string (D8 — every probe must be actionable)`);
    }
    if (typeof p.run !== 'function') {
      problems.push(`${p.id || '<unknown>'}: run must be a function`);
    }
    if (typeof p.title !== 'string' || !p.title.trim()) {
      problems.push(`${p.id || '<unknown>'}: title must be a non-empty string`);
    }
  }
  if (REGISTRY.length === 0) {
    problems.push('registry is empty — a doctor with zero probes cannot be trusted (sandbox-honesty: never green having checked nothing)');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Run one probe against `ctx`, normalising every outcome into
 * `{id, title, class, fix, status, detail}`. Never throws — a probe body
 * that throws is caught and reported as `status:'error'`, never crashing the
 * whole run (§2.3).
 *
 * @param {object} probe one REGISTRY entry
 * @param {object} ctx `{bundleRoot, subjectRoot, layout, git, fs, exec, cloud}`
 * @returns {{id: string, title: string, class: string, fix: string, status: string, detail: string}}
 */
export async function runProbe(probe, ctx) {
  // Round-2 audit M5: the normalisation below (property access on `result`)
  // must be INSIDE the try — a probe returning a pathological value (e.g. a
  // getter that throws) would otherwise escape as an unhandled rejection
  // from a function documented to never throw.
  try {
    const result = await probe.run(ctx);
    const status = PROBE_STATUSES.includes(result?.status) ? result.status : 'error';
    const detail = status === 'error' && !PROBE_STATUSES.includes(result?.status)
      ? `probe returned an invalid status ${JSON.stringify(result?.status)} — treating as error`
      : (result?.detail ?? '');
    return { id: probe.id, title: probe.title, class: probe.class, fix: probe.fix, status, detail };
  } catch (err) {
    // Round-5 audit M7: `err?.message` is itself a property access that can
    // throw for a pathological thrown value (e.g. `{ get message() { throw
    // new Error('x') } }`) — the catch block guaranteeing "never throw" must
    // not depend on the thrown value cooperating with that guarantee.
    let detail;
    try {
      detail = `probe threw: ${err?.message ?? err}`;
    } catch {
      detail = 'probe threw a value that could not be described';
    }
    return { id: probe.id, title: probe.title, class: probe.class, fix: probe.fix, status: 'error', detail };
  }
}
