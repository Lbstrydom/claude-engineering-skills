/**
 * @fileoverview doctor's OPERATING-FIT probes: four recommend-only checks of the settings the fleet skill and the gate
 * ship as constants (docs/plans/adoption-fit-check.md section 2.5). Each reads MEASURED inputs
 * (`operating-inputs.mjs`), names the number behind its recommendation and the rule it would change, and never
 * gates (`class:'machine'`) and never writes config.
 *
 * Two honesty rules hold in every decision:
 *  - An unmeasured input reads `unmeasured (<why>)` and the shipped default "stands unverified": it is never adopted
 *    as if it had been measured.
 *  - The local suite wall is the TEST STEP, a LOWER BOUND on what a push puts in the heavy slot. A check that the
 *    lower bound FAILS is sound (`warn`); a check that it passes proves nothing about the real job, so a `pass` says
 *    "not contradicted", never "fits". No correction multiplier.
 *
 * The recommenders are pure over `(inputs, now)`; the only I/O is the one-line wrapper in each probe.
 *
 * @module scripts/lib/doctor/operating-fit
 */
import { operatingInputs } from './operating-inputs.mjs';

// ── Constants, each with its source ─────────────────────────────────────────

/** Rule 12 as shipped (skills/fleet/references/coordination.md): 4 worker sessions machine-wide, 2 per repo. */
export const RULE12_DEFAULT = Object.freeze({ machine: 4, perRepo: 2 });
/**
 * Heavy jobs one worker puts in the slot per hour. The shipped 4 is about 4 full gates an hour fitted machine-wide
 * (coordination-rationale.md, Rule 12), i.e. one heavy job per worker-hour at a ~15-minute gate.
 */
export const HEAVY_JOBS_PER_WORKER_HOUR = 1;

/**
 * How many workers one heavy slot can feed: the slot runs `60 / g` jobs an hour, and each worker brings `h` of them.
 * So workers = floor(60 / (g * h)). Exported so a non-unit rate can be tested against the unit-rate shipped default.
 *
 * @param {number} gMin minutes one heavy job holds the slot (g)
 * @param {number} jobsPerWorkerHour heavy jobs one worker produces per hour (h)
 */
export function slotBoundWorkers(gMin, jobsPerWorkerHour = HEAVY_JOBS_PER_WORKER_HOUR) {
  return Math.max(1, Math.floor(60 / (gMin * jobsPerWorkerHour)));
}
/** The ~60-minute turn a repo takes when several repos wait for the heavy slot (coordinator policy, 2026-10-14). */
export const TURN_DEFAULT_MIN = 60;
/** The branch tier saves 32-40% of a gate (docs/plans/gate-cost-slice-2.md, section 1). */
export const TIER_SAVING = Object.freeze([0.32, 0.40]);
/** Below this a work-in-progress push saves under ~4 min at TIER_SAVING, which does not pay a policy change. */
export const TIER_PAYOFF_MIN = 10;
const UNVERIFIED = 'stands unverified';

const fmtMin = (ms) => `${(ms / 60_000).toFixed(ms >= 600_000 ? 0 : 1)} min`;
const unm = (m) => `unmeasured (${m.why})`;
const ageOf = (v) => {
  const d = v.ageMs / 86_400_000;
  return d < 1 ? `${Math.max(0, Math.round(v.ageMs / 3_600_000))} h old` : `${Math.floor(d)} d old`;
};
const describeWall = (m) => `${fmtMin(m.value.ms)} (${m.value.workloadKind}, test step, ${m.value.files ?? '?'} files, ${m.value.cores} cores, ${ageOf(m.value)})`;

// ── operating/ci-location ───────────────────────────────────────────────────

const BILLING = 'GitHub bills only larger runners and private repositories; standard hosted runners are free for public repositories (docs.github.com, "GitHub Actions billing")';

function censusLine(census) {
  const j = census.jobs; const t = census.testJobs;
  const failed = census.files.failed.length;
  return `${census.files.inspected} workflow file(s) read${failed ? `, ${failed} unreadable (${census.files.failed.map((f) => f.file).join(', ')})` : ''}; jobs: ${j.standardHosted} standard-hosted, ${j.largerHosted} larger, ${j.selfHosted} self-hosted, ${j.unresolved} unresolved${census.opaqueJobs ? ` (${census.opaqueJobs} reusable-workflow call(s) whose steps were not read)` : ''}; test jobs: ${t.standardHosted} standard-hosted, ${t.largerHosted} larger, ${t.selfHosted} self-hosted, ${t.unresolved} unresolved`;
}

function wallsLine(inputs) {
  const w = inputs.ciTestWalls;
  if (!w.measured) return `CI wall: ${unm(w)}`;
  return `CI wall (workflow incl. setup, median of recent successes): ${w.value.map((x) => `${x.workflow} ${fmtMin(x.ms)} [${x.origin}]`).join('; ')}`;
}

/**
 * Where the full suite should run (rule 14: what occupies this machine's heavy slot). First matching row of the plan's
 * decision table (section 2.5) wins.
 */
export function recommendCiLocation(inputs) {
  const vis = inputs.visibility;
  if (!vis.measured) {
    const jobs = inputs.ciJobs;
    return { status: 'unknown', detail: `repo visibility ${unm(vis)}; where the suite runs now ${UNVERIFIED}. ${jobs.measured ? censusLine(jobs.value) : `CI census: ${unm(jobs)}`}` };
  }
  const jobs = inputs.ciJobs;
  if (vis.value !== 'PUBLIC') {
    return {
      status: 'pass',
      detail: `${vis.value} repository: hosted minutes are billed, so a self-hosted or local full suite is not contradicted. ${BILLING}. ${jobs.measured ? censusLine(jobs.value) : `CI census: ${unm(jobs)}`}`,
    };
  }
  const move = 'move the full suite to standard GitHub-hosted runners (rule 14: that takes it out of this machine\'s heavy slot)';
  if (!jobs.measured) {
    return jobs.code === 'absent'
      ? { status: 'warn', detail: `PUBLIC repository with no CI workflows, so the suite can only run on this machine; ${move}. ${BILLING}.` }
      : { status: 'unknown', detail: `PUBLIC repository, CI census ${unm(jobs)}; where the suite runs now ${UNVERIFIED}.` };
  }
  const c = jobs.value;
  if (c.testJobs.selfHosted > 0) {
    return { status: 'warn', detail: `PUBLIC repository with ${c.testJobs.selfHosted} self-hosted test job(s); ${move}. ${BILLING}. ${censusLine(c)}. ${wallsLine(inputs)}` };
  }
  if (!c.complete) {
    return { status: 'unknown', detail: `PUBLIC repository, but the CI census is incomplete (${c.files.failed.length} unreadable file(s), ${c.testJobs.unresolved} test job(s) with an unresolved runner, ${c.opaqueJobs} reusable-workflow call(s) not read), so neither "all hosted" nor "no test job" can be concluded; where the suite runs now ${UNVERIFIED}. ${censusLine(c)}` };
  }
  if (c.testTotal === 0) {
    return { status: 'warn', detail: `PUBLIC repository where no workflow step matches a known test command (npm/pnpm/yarn/bun test, node --test, vitest, jest, playwright test), so the suite runs on this machine if anywhere; ${move}. ${BILLING}. ${censusLine(c)}` };
  }
  if (c.testJobs.largerHosted > 0) {
    return { status: 'warn', detail: `${c.testJobs.largerHosted} test job(s) use larger runners, which are billed even on public repositories; standard hosted runners are free. ${censusLine(c)}` };
  }
  return { status: 'pass', detail: `PUBLIC repository, every test job runs on a standard hosted runner (free). ${censusLine(c)}. ${wallsLine(inputs)}` };
}

// ── operating/test-tier ─────────────────────────────────────────────────────

/** Whether the light pre-push tier pays off (docs/plans/gate-cost-slice-2.md stage 1: `AUDIT_PREPUSH_TIER=branch`). */
export function recommendTestTier(inputs) {
  const cap = inputs.tierCapability;
  if (!cap.measured) return { status: 'unknown', detail: `test tier capability ${unm(cap)}; the default full tier ${UNVERIFIED}.` };
  if (cap.value.state === 'absent') return { status: 'not_applicable', detail: 'no test tier here (no .test-tiers.json): it is source-repo tooling and is not synced to consumers.' };
  const wall = inputs.localSuiteWall;
  if (!wall.measured) return { status: 'unknown', detail: `full local suite wall ${unm(wall)}; the default full tier ${UNVERIFIED} (stage 1 of docs/plans/gate-cost-slice-2.md).` };
  const min = wall.value.ms / 60_000;
  if (min >= TIER_PAYOFF_MIN) {
    const [lo, hi] = TIER_SAVING.map((s) => (min * s).toFixed(1));
    return {
      status: 'warn',
      detail: `full local suite is ${describeWall(wall)}, at or over the ${TIER_PAYOFF_MIN}-min mark where the branch tier pays; opt work-in-progress pushes into AUDIT_PREPUSH_TIER=branch (docs/plans/gate-cost-slice-2.md stage 1): at the measured 32-40% saving that is about ${lo}-${hi} min per push (derived). A merge candidate still needs a full-tier push.`,
    };
  }
  return { status: 'pass', detail: `full local suite is ${describeWall(wall)}, under the ${TIER_PAYOFF_MIN}-min mark: the default full tier is not contradicted (test-step lower bound).` };
}

// ── operating/wip-limit ─────────────────────────────────────────────────────

/** Rule 12: at most 4 worker sessions machine-wide and 2 per repo. Re-derived from the measured heavy job. */
export function recommendWipLimit(inputs) {
  const heavy = inputs.localHeavyWall;
  if (!heavy.measured) return { status: 'unknown', detail: `heavy-job wall ${unm(heavy)}; rule 12 (${RULE12_DEFAULT.machine} machine-wide, ${RULE12_DEFAULT.perRepo} per repo) ${UNVERIFIED}.` };
  const g = heavy.value.ms / 60_000;
  if (!(g > 0)) return { status: 'unknown', detail: `heavy-job wall is 0 (${heavy.source}); rule 12 ${UNVERIFIED}.` };
  const n = slotBoundWorkers(g);
  const extra = [];
  const peak = inputs.peakSessions;
  const perRepo = Math.min(RULE12_DEFAULT.perRepo, n);
  if (peak.measured && peak.value.peak > perRepo) extra.push(`observed peak ${peak.value.peak} sessions in this repo (approximate, ${peak.value.windowDays} d)`);
  const cores = inputs.cores;
  if (cores.measured && heavy.value.cores !== cores.value) extra.push(`the wall was measured on a different machine (${heavy.value.cores} vs ${cores.value} cores)`);
  const tail = extra.length ? ` Also: ${extra.join('; ')}.` : '';
  const basis = `heavy job ${describeWall(heavy)} gives a slot-bound ceiling of floor(60 / ${g.toFixed(1)}) = ${n} (one heavy slot, rule 14; about ${HEAVY_JOBS_PER_WORKER_HOUR} heavy job per worker-hour, which reproduces rule 12's ${RULE12_DEFAULT.machine} at a ~15-min gate)`;
  if (n < RULE12_DEFAULT.machine) {
    return { status: 'warn', detail: `${basis}: recommend at most ${n} worker session(s) machine-wide and ${perRepo} per repo (rule 12 ships ${RULE12_DEFAULT.machine} and ${RULE12_DEFAULT.perRepo}); more workers only queue on the slot.${tail}` };
  }
  return { status: 'pass', detail: `${basis}: rule 12's ${RULE12_DEFAULT.machine} is not contradicted (the test-step lower bound allows up to ${n}); raising it needs the full-gate time and attention/message budget, both unmeasured.${tail}` };
}

// ── operating/turn-length ───────────────────────────────────────────────────

/** The ~60-minute turn when several repos wait for the heavy slot. */
export function recommendTurnLength(inputs) {
  const heavy = inputs.localHeavyWall;
  const notes = [];
  const lease = inputs.leaseSharing;
  notes.push(lease.measured
    ? (lease.value.otherRepos.length > 0
      ? `other repos on the lease in the last 24 h: ${lease.value.otherRepos.join(', ')}`
      : 'sharing unobserved (the lease cannot show exclusivity: refusals are not recorded and windows prune after 1 h)')
    : `lease sharing ${unm(lease)}`);
  const sh = inputs.ciJobs;
  if (sh.measured && sh.value.testJobs.selfHosted > 0) {
    const walls = inputs.ciTestWalls;
    if (walls.measured) {
      for (const w of walls.value.filter((x) => x.origin === 'ci-self-hosted-unattributed')) {
        notes.push(`if the self-hosted runner behind ${w.workflow} is on this machine, its CI window is ${fmtMin(w.ms)} of heavy time inside its repo's turn (not used in the decision)`);
      }
    }
  }
  notes.push(`gate-slot wait: ${unm(inputs.slotWait)}`);
  const tail = ` ${notes.join('. ')}.`;
  if (!heavy.measured) return { status: 'unknown', detail: `heavy-job wall ${unm(heavy)}; the ${TURN_DEFAULT_MIN}-min turn ${UNVERIFIED}.${tail}` };
  const g = heavy.value.ms / 60_000;
  if (2 * g > TURN_DEFAULT_MIN) {
    const rec = Math.ceil((2 * g) / 15) * 15;
    return { status: 'warn', detail: `heavy job ${describeWall(heavy)}: a ${TURN_DEFAULT_MIN}-min turn holds under two of them; recommend turns of at least ${rec} min (ceil(2 x ${g.toFixed(1)} / 15) x 15) so one turn holds two of this repo's jobs.${tail}` };
  }
  return { status: 'pass', detail: `heavy job ${describeWall(heavy)}: a ${TURN_DEFAULT_MIN}-min turn is not contradicted (it holds ${Math.floor(TURN_DEFAULT_MIN / g)} at the test-step lower bound).${tail}` };
}

// ── Probe definitions ───────────────────────────────────────────────────────

const FIX = 'Recommend-only: the detail names the measured number and the rule it would change. The setting is yours to change; doctor never writes it.';
const probe = (id, title, recommend) => ({
  id, title, class: 'machine', fix: FIX,
  run: (ctx) => recommend(operatingInputs(ctx)),
});

export const OPERATING_PROBES = Object.freeze([
  probe('operating/ci-location', 'Operating fit: where the full suite should run (hosted vs local CI)', recommendCiLocation),
  probe('operating/test-tier', 'Operating fit: whether the light pre-push test tier pays off', recommendTestTier),
  probe('operating/wip-limit', 'Operating fit: worker work-in-progress limit (fleet rule 12)', recommendWipLimit),
  probe('operating/turn-length', 'Operating fit: heavy-slot turn length (fleet rule 14)', recommendTurnLength),
]);
