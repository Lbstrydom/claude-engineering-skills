import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  recommendCiLocation, recommendTestTier, recommendWipLimit, recommendTurnLength, OPERATING_PROBES, RULE12_DEFAULT, slotBoundWorkers,
} from '../scripts/lib/doctor/operating-fit.mjs';
import { REGISTRY, validateRegistry, probeIds } from '../scripts/lib/doctor/registry.mjs';

// ── Fixture builders: the shapes operating-inputs.mjs produces ─────────────
const un = (why, code) => (code ? { measured: false, why, code } : { measured: false, why });
const ok = (value, source = 'fixture') => ({ measured: true, value, source });
const zero = () => ({ standardHosted: 0, largerHosted: 0, selfHosted: 0, unresolved: 0 });
const census = ({ tests = {}, jobs = {}, failed = [], testWorkflows = [], opaque = 0 } = {}) => {
  const testJobs = { ...zero(), ...tests };
  const testTotal = testJobs.standardHosted + testJobs.largerHosted + testJobs.selfHosted + testJobs.unresolved;
  return ok({
    files: { inspected: 3, failed }, jobs: { ...zero(), ...jobs, ...tests }, testJobs, testTotal, testWorkflows, opaqueJobs: opaque,
    complete: failed.length === 0 && testJobs.unresolved === 0 && opaque === 0,
  });
};
const wall = (min, over = {}) => ok({
  ms: min * 60_000, workloadKind: 'full-suite', timingBasis: 'test-step', origin: 'this-repo-local', finishedAt: '2026-10-14T10:00:00.000Z',
  ageMs: 3_600_000, cores: 32, platform: 'win32', head: null, files: 949, ...over,
});
const base = (over = {}) => ({
  cores: ok(32), visibility: ok('PUBLIC'), ciJobs: census(), ciTestWalls: un('no workflow runs the test command'),
  localSuiteWall: wall(16), localHeavyWall: wall(16), peakSessions: un('no fleet sessions recorded for this repo'),
  leaseSharing: ok({ otherRepos: [] }), slotWait: un('the lease records no request or acquire events'),
  tierCapability: ok({ state: 'present', heavyFiles: 48 }), ...over,
});

describe('operating/ci-location: every row of the decision table', () => {
  it('row 1: visibility unmeasured -> unknown, says so, names the default as unverified', () => {
    const r = recommendCiLocation(base({ visibility: un('gh is not installed') }));
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /unmeasured \(gh is not installed\)/);
    assert.match(r.detail, /stands unverified/);
  });
  it('row 2: PUBLIC and no workflows directory (measured absent) -> warn', () => {
    const r = recommendCiLocation(base({ ciJobs: un('no .github/workflows directory', 'absent') }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /no CI workflows/);
    assert.match(r.detail, /standard hosted runners are free for public repositories/);
  });
  it('row 2b: PUBLIC and the workflows directory unreadable -> unknown, never a conclusion', () => {
    assert.equal(recommendCiLocation(base({ ciJobs: un('.github/workflows unreadable (EACCES)', 'unreadable') })).status, 'unknown');
  });
  it('row 3: PUBLIC with a self-hosted test job -> warn, even when the census is incomplete (positive evidence)', () => {
    const r = recommendCiLocation(base({ ciJobs: census({ tests: { selfHosted: 2, unresolved: 1 }, failed: [{ file: 'x.yml', why: 'bad' }] }) }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /2 self-hosted test job/);
  });
  it('row 4: PUBLIC, incomplete census, no positive evidence -> unknown (neither "all hosted" nor "no test job")', () => {
    const r = recommendCiLocation(base({ ciJobs: census({ tests: { standardHosted: 1 }, failed: [{ file: 'broken.yml', why: 'bad' }] }) }));
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /census is incomplete/);
    assert.match(r.detail, /broken\.yml/);
  });
  it('row 4b: an unresolved test-job runner also makes the census incomplete', () => {
    assert.equal(recommendCiLocation(base({ ciJobs: census({ tests: { standardHosted: 1, unresolved: 1 } }) })).status, 'unknown');
  });
  it('row 5: PUBLIC, complete census, no test job anywhere -> warn (the suite runs locally if anywhere)', () => {
    const r = recommendCiLocation(base({ ciJobs: census({ jobs: { standardHosted: 2 } }) }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /no workflow step matches a known test command/);
  });
  it('row 4c: a reusable-workflow call whose steps were never read blocks BOTH "no test job" and "all hosted"', () => {
    const none = recommendCiLocation(base({ ciJobs: census({ jobs: { unresolved: 1 }, opaque: 1 }) }));
    assert.equal(none.status, 'unknown');
    assert.match(none.detail, /1 reusable-workflow call\(s\) not read/);
    const some = recommendCiLocation(base({ ciJobs: census({ tests: { standardHosted: 1 }, opaque: 1 }) }));
    assert.equal(some.status, 'unknown');
  });
  it('row 6: PUBLIC, complete, a larger-runner test job -> warn (billed even on public repos)', () => {
    const r = recommendCiLocation(base({ ciJobs: census({ tests: { largerHosted: 1, standardHosted: 1 } }) }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /billed even on public repositories/);
  });
  it('row 7: PUBLIC, complete, every test job standard-hosted -> pass', () => {
    const r = recommendCiLocation(base({ ciJobs: census({ tests: { standardHosted: 3 } }) }));
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /standard hosted runner \(free\)/);
  });
  it('row 8: PRIVATE -> pass with the census, never a move-to-hosted nudge', () => {
    const r = recommendCiLocation(base({ visibility: ok('PRIVATE'), ciJobs: census({ tests: { selfHosted: 2 } }) }));
    assert.equal(r.status, 'pass');
    assert.doesNotMatch(r.detail, /recommend|move the full suite/i);
    assert.match(r.detail, /2 self-hosted/);
  });
  it('row 8: INTERNAL is treated like PRIVATE', () => {
    assert.equal(recommendCiLocation(base({ visibility: ok('INTERNAL') })).status, 'pass');
  });
  it('PRIVATE with an unmeasured census still passes and says the census is unmeasured', () => {
    const r = recommendCiLocation(base({ visibility: ok('PRIVATE'), ciJobs: un('no .github/workflows directory', 'absent') }));
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /unmeasured \(no \.github\/workflows directory\)/);
  });
});

describe('operating/test-tier', () => {
  it('no tier machinery -> not_applicable', () => {
    assert.equal(recommendTestTier(base({ tierCapability: ok({ state: 'absent' }) })).status, 'not_applicable');
  });
  it('present-but-unverifiable -> unknown', () => {
    const r = recommendTestTier(base({ tierCapability: un('.test-tiers.json present but scripts/run-tests.mjs lacks the tier protocol') }));
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /unmeasured \(/);
  });
  it('wall unmeasured -> unknown and the default is named as unverified', () => {
    const r = recommendTestTier(base({ localSuiteWall: un('no suite-run full record') }));
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /stands unverified/);
  });
  it('boundary: 9.9 min passes ("not contradicted"), 10 min warns with the derived saving', () => {
    const pass = recommendTestTier(base({ localSuiteWall: wall(9.9) }));
    assert.equal(pass.status, 'pass');
    assert.match(pass.detail, /not contradicted \(test-step lower bound\)/);
    const warn = recommendTestTier(base({ localSuiteWall: wall(10) }));
    assert.equal(warn.status, 'warn');
    assert.match(warn.detail, /AUDIT_PREPUSH_TIER=branch/);
    assert.match(warn.detail, /3\.2-4\.0 min per push \(derived\)/);
  });
  it('names its rule source', () => assert.match(recommendTestTier(base({ localSuiteWall: wall(20) })).detail, /gate-cost-slice-2/));
});

describe('operating/wip-limit', () => {
  it('heavy wall unmeasured -> unknown, rule 12 named as unverified', () => {
    const r = recommendWipLimit(base({ localHeavyWall: un('no suite-run record') }));
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /rule 12 \(4 machine-wide, 2 per repo\) stands unverified/);
  });
  it('boundary: 15 min -> ceiling 4 -> pass, worded "not contradicted"', () => {
    const r = recommendWipLimit(base({ localHeavyWall: wall(15) }));
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /rule 12's 4 is not contradicted/);
  });
  it('boundary: 16 min -> ceiling 3 -> warn recommending at most 3 / 2', () => {
    const r = recommendWipLimit(base({ localHeavyWall: wall(16) }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /at most 3 worker session\(s\) machine-wide and 2 per repo/);
    assert.match(r.detail, /rule 12/);
  });
  it('a very slow suite floors at 1 and caps the per-repo figure at 1', () => {
    const r = recommendWipLimit(base({ localHeavyWall: wall(90) }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /at most 1 worker session\(s\) machine-wide and 1 per repo/);
  });
  it('appends the observed per-repo peak when it exceeds the recommendation', () => {
    const r = recommendWipLimit(base({ localHeavyWall: wall(40), peakSessions: ok({ peak: 3, windowDays: 7, approximate: true }) }));
    assert.match(r.detail, /observed peak 3 sessions in this repo \(approximate, 7 d\)/);
  });
  it('flags a record measured on a different machine', () => {
    const r = recommendWipLimit(base({ localHeavyWall: wall(10, { cores: 8 }) }));
    assert.match(r.detail, /different machine \(8 vs 32 cores\)/);
  });
  it('a zero-length wall is unknown, not an infinite ceiling', () => {
    assert.equal(recommendWipLimit(base({ localHeavyWall: wall(0) })).status, 'unknown');
  });
});

describe('slotBoundWorkers: the units mean something', () => {
  it('at the shipped unit rate it is floor(60 / g)', () => {
    assert.equal(slotBoundWorkers(15), 4);
    assert.equal(slotBoundWorkers(16), 3);
    assert.equal(slotBoundWorkers(1000), 1);
  });
  it('a NON-unit rate divides: workers who each bring more heavy jobs per hour need a smaller fleet', () => {
    assert.equal(slotBoundWorkers(15, 2), 2);
    assert.equal(slotBoundWorkers(15, 0.5), 8);
    assert.equal(slotBoundWorkers(10, 3), 2);
    assert.notEqual(slotBoundWorkers(15, 2), Math.floor((60 * 2) / 15), 'must not multiply by the rate');
  });
});

describe('operating/turn-length', () => {
  it('heavy wall unmeasured -> unknown, and the CI walls never stand in for it', () => {
    const r = recommendTurnLength(base({
      localHeavyWall: un('no suite-run record'),
      ciJobs: census({ tests: { selfHosted: 1 } }),
      ciTestWalls: ok([{ workflow: 'ci.yml', ms: 40 * 60_000, runs: 5, workloadKind: 'ci-workflow', timingBasis: 'workflow-wall', origin: 'ci-self-hosted-unattributed' }]),
    }));
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /the 60-min turn stands unverified/);
  });
  it('boundary: 30 min -> two fit in 60 -> pass; 31 min -> warn recommending 75', () => {
    assert.equal(recommendTurnLength(base({ localHeavyWall: wall(30) })).status, 'pass');
    const r = recommendTurnLength(base({ localHeavyWall: wall(31) }));
    assert.equal(r.status, 'warn');
    assert.match(r.detail, /at least 75 min/);
  });
  it('a self-hosted CI wall is reported conditionally and does not move the decision', () => {
    const walls = ok([{ workflow: 'ci.yml', ms: 80 * 60_000, runs: 5, workloadKind: 'ci-workflow', timingBasis: 'workflow-wall', origin: 'ci-self-hosted-unattributed' }]);
    const withWall = recommendTurnLength(base({ localHeavyWall: wall(20), ciJobs: census({ tests: { selfHosted: 1 } }), ciTestWalls: walls }));
    const without = recommendTurnLength(base({ localHeavyWall: wall(20) }));
    assert.equal(withWall.status, without.status);
    assert.match(withWall.detail, /if the self-hosted runner behind ci\.yml is on this machine/);
  });
  it('empty sharing reads "sharing unobserved", never exclusive and never not_applicable', () => {
    const r = recommendTurnLength(base({ leaseSharing: ok({ otherRepos: [] }) }));
    assert.notEqual(r.status, 'not_applicable');
    assert.match(r.detail, /sharing unobserved/);
    assert.match(r.detail, /cannot show exclusivity/);
  });
  it('observed sharing names the other repos; an unmeasured lease says so', () => {
    assert.match(recommendTurnLength(base({ leaseSharing: ok({ otherRepos: ['a/b'] }) })).detail, /other repos on the lease in the last 24 h: a\/b/);
    assert.match(recommendTurnLength(base({ leaseSharing: un('no lease file in /x') })).detail, /lease sharing unmeasured \(no lease file in \/x\)/);
  });
  it('ALWAYS reports gate-slot wait as unmeasured', () => {
    assert.match(recommendTurnLength(base()).detail, /gate-slot wait: unmeasured \(/);
    assert.match(recommendTurnLength(base({ localHeavyWall: un('x') })).detail, /gate-slot wait: unmeasured \(/);
  });
});

describe('the probes themselves', () => {
  it('four probes, ids stable, all class machine (so none can gate), all with a non-empty fix', () => {
    assert.deepEqual(OPERATING_PROBES.map((p) => p.id), ['operating/ci-location', 'operating/test-tier', 'operating/wip-limit', 'operating/turn-length']);
    for (const p of OPERATING_PROBES) {
      assert.equal(p.class, 'machine');
      assert.ok(p.fix.trim().length > 0);
      assert.match(p.fix, /Recommend-only/);
    }
  });
  it('they are in the live registry and the registry still validates', () => {
    for (const p of OPERATING_PROBES) assert.ok(probeIds().includes(p.id), p.id);
    assert.equal(validateRegistry().ok, true);
    assert.equal(REGISTRY.filter((p) => p.id.startsWith('operating/')).length, 4);
  });
  it('every status the recommenders can return is one the registry accepts, and every detail names a rule or a source', () => {
    const results = [
      recommendCiLocation(base()), recommendTestTier(base()), recommendWipLimit(base()), recommendTurnLength(base()),
      recommendCiLocation(base({ visibility: un('x') })), recommendTestTier(base({ tierCapability: ok({ state: 'absent' }) })),
    ];
    for (const r of results) {
      assert.ok(['pass', 'warn', 'unknown', 'not_applicable'].includes(r.status), r.status);
      assert.ok(typeof r.detail === 'string' && r.detail.length > 20);
    }
    assert.match(recommendWipLimit(base({ localHeavyWall: wall(20) })).detail, /rule 12/);
    assert.match(recommendTurnLength(base({ localHeavyWall: wall(20) })).detail, /60-min turn/);
  });
  it('NEGATIVE CONTROL: no operating probe returns pass or warn when its measured inputs are all unmeasured', () => {
    const dark = {
      cores: ok(4), visibility: un('v'), ciJobs: un('c'), ciTestWalls: un('w'), localSuiteWall: un('s'), localHeavyWall: un('h'),
      peakSessions: un('p'), leaseSharing: un('l'), slotWait: un('sw'), tierCapability: un('t'),
    };
    for (const fn of [recommendCiLocation, recommendTestTier, recommendWipLimit, recommendTurnLength]) {
      assert.equal(fn(dark).status, 'unknown', fn.name);
      assert.match(fn(dark).detail, /unmeasured \(/, fn.name);
    }
  });
  it('rule 12 constant matches the shipped rule text', async () => {
    const fs = await import('node:fs');
    const text = fs.readFileSync(new URL('../skills/fleet/references/coordination.md', import.meta.url), 'utf8');
    assert.ok(text.includes(`At most **${RULE12_DEFAULT.machine} worker sessions machine-wide and ${RULE12_DEFAULT.perRepo} per repo**`));
  });
});
