import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  assessCadence,
  assessWatchList,
  discoverScheduledWorkflows,
  fetchWorkflowRuns,
  isWarning,
  loadWatchList,
  render,
  rollupStatus,
  unconfiguredVerdict,
  watchLabel,
  DEFAULT_MAX_AGE_DAYS,
  WATCH_CONFIG_BASENAME,
} from '../scripts/workflow-cadence-doctor.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'workflow-cadence-doctor.mjs');

const NOW = new Date('2026-09-06T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// ── assessCadence: the verdict logic, ported from the source instrument ──────

test('a recent successful run is OK and renders without a warning', () => {
  const v = assessCadence({ runs: [{ conclusion: 'success', updated_at: daysAgo(2) }], now: NOW, maxAgeDays: 10 });
  assert.equal(v.status, 'ok');
  assert.ok(v.ageDays > 1.9 && v.ageDays < 2.1);
  assert.equal(v.vacuous, false);
  assert.ok(!isWarning(v.status));
});

test('a run older than the budget is stale and warns', () => {
  const v = assessCadence({ runs: [{ conclusion: 'success', updated_at: daysAgo(15) }], now: NOW, maxAgeDays: 10 });
  assert.equal(v.status, 'stale');
  assert.ok(isWarning(v.status));
  assert.match(v.message, /15\.0 days ago/);
});

test('cancelled and failed runs do not count as the workflow having run', () => {
  // A run queued for an absent self-hosted runner is cancelled after 24h --
  // precisely the failure mode this instrument exists to catch.
  const v = assessCadence({
    runs: [
      { conclusion: 'cancelled', updated_at: daysAgo(1) },
      { conclusion: 'failure', updated_at: daysAgo(2) },
    ],
    now: NOW,
    maxAgeDays: 10,
  });
  assert.equal(v.status, 'never-ran');
});

test('the most recent success wins even when the API returns runs out of order', () => {
  const v = assessCadence({
    runs: [
      { conclusion: 'success', updated_at: daysAgo(20) },
      { conclusion: 'success', updated_at: daysAgo(3) },
      { conclusion: 'failure', updated_at: daysAgo(1) },
    ],
    now: NOW,
    maxAgeDays: 10,
  });
  assert.equal(v.status, 'ok');
  assert.ok(v.ageDays < 3.1);
});

test('an API failure is UNDETERMINED and warns -- it never reads as a pass', () => {
  // A checker that goes quiet when its own instrument breaks reproduces, one
  // level up, the defect it exists to detect.
  const v = assessCadence({ runs: null, now: NOW, maxAgeDays: 10, error: 'GitHub API returned 403' });
  assert.equal(v.status, 'undetermined');
  assert.ok(isWarning(v.status));
  assert.match(v.message, /NOT a pass/);
});

test('a malformed timestamp does not silently become a fresh run', () => {
  const v = assessCadence({ runs: [{ conclusion: 'success', updated_at: 'not-a-date' }], now: NOW, maxAgeDays: 10 });
  assert.notEqual(v.status, 'ok');
});

test('the default budget is more than one weekly cycle, so one slipped run does not cry wolf', () => {
  assert.ok(DEFAULT_MAX_AGE_DAYS > 7);
});

// ── The vacuity guard ───────────────────────────────────────────────────────
//
// `never-ran` has causes that read identically to a human: the workflow really
// never succeeded, and the query matched nothing at all. A watcher that merges
// them cannot be trusted, because "I checked and it is broken" and "I checked
// nothing" would print the same sentence.

test('never-ran from ZERO examined runs is flagged vacuous', () => {
  const v = assessCadence({ runs: [], now: NOW, maxAgeDays: 10, label: 'ci.yml@schedule' });
  assert.equal(v.status, 'never-ran');
  assert.equal(v.runsExamined, 0);
  assert.equal(v.vacuous, true);
  assert.match(v.message, /NO completed runs at all/);
  assert.match(v.message, /before treating this as a finding/);
});

test('never-ran backed by examined runs is NOT vacuous, and says how many it looked at', () => {
  const v = assessCadence({
    runs: [
      { conclusion: 'failure', updated_at: daysAgo(1) },
      { conclusion: 'failure', updated_at: daysAgo(2) },
      { conclusion: 'failure', updated_at: daysAgo(3) },
      { conclusion: 'failure', updated_at: daysAgo(4) },
    ],
    now: NOW,
    maxAgeDays: 2,
    label: 'phase-gates.yml@schedule',
  });
  assert.equal(v.status, 'never-ran');
  assert.equal(v.runsExamined, 4);
  assert.equal(v.vacuous, false);
  assert.match(v.message, /4 completed run\(s\) were examined/);
});

test('the two never-ran causes are mechanically distinguishable, not merely differently worded', () => {
  const vacuous = assessCadence({ runs: [], now: NOW, maxAgeDays: 10 });
  const real = assessCadence({ runs: [{ conclusion: 'failure', updated_at: daysAgo(1) }], now: NOW, maxAgeDays: 10 });
  assert.equal(vacuous.status, real.status); // same status -- which is the trap
  assert.notEqual(vacuous.vacuous, real.vacuous); // and this is the escape from it
  assert.notEqual(vacuous.message, real.message);
});

test('a 404 is a named cause, not a vacuous zero -- the operator is not sent to check a correct name', () => {
  const v = assessCadence({ runs: [], now: NOW, maxAgeDays: 10, notFound: true, label: 'gone.yml@schedule' });
  assert.equal(v.status, 'never-ran');
  assert.equal(v.vacuous, false);
  assert.match(v.message, /404/);
  assert.match(v.message, /not registered on the default branch/);
});

// ── Generic prose: the second axis of the promotion ─────────────────────────

test('verdict prose names the watched workflow and carries no drift-specific wording', () => {
  const drifty = /duplication policy|sweep|drift/i;
  const verdicts = [
    assessCadence({ runs: [], now: NOW, label: 'live-smoke.yml@schedule' }),
    assessCadence({ runs: [{ conclusion: 'failure', updated_at: daysAgo(1) }], now: NOW, label: 'live-smoke.yml@schedule' }),
    assessCadence({ runs: [{ conclusion: 'success', updated_at: daysAgo(30) }], now: NOW, maxAgeDays: 2, label: 'live-smoke.yml@schedule' }),
    assessCadence({ runs: [{ conclusion: 'success', updated_at: daysAgo(1) }], now: NOW, label: 'live-smoke.yml@schedule' }),
  ];
  for (const v of verdicts) {
    assert.match(v.message, /live-smoke\.yml@schedule/, `verdict "${v.status}" does not name the workflow`);
    assert.doesNotMatch(v.message, drifty, `verdict "${v.status}" leaks the source repo's subject matter`);
  }
});

test('watchLabel distinguishes an event-filtered watch from an unfiltered one', () => {
  assert.equal(watchLabel({ workflow: 'a.yml', event: 'schedule' }), 'a.yml@schedule');
  assert.equal(watchLabel({ workflow: 'a.yml', event: null }), 'a.yml (any event)');
  assert.equal(watchLabel({ workflow: 'a.yml', label: 'nightly smoke' }), 'nightly smoke');
});

// ── fetchWorkflowRuns: the event filter, and the failure shapes ─────────────

test('the event filter reaches the GitHub URL, and is absent when not asked for', async () => {
  const seen = [];
  const stub = async (url) => { seen.push(url); return { status: 200, ok: true, json: async () => ({ workflow_runs: [] }) }; };
  await fetchWorkflowRuns({ repo: 'o/r', workflow: 'w.yml', event: 'schedule', token: 't', fetchImpl: stub });
  await fetchWorkflowRuns({ repo: 'o/r', workflow: 'w.yml', token: 't', fetchImpl: stub });
  assert.match(seen[0], /[?&]event=schedule\b/);
  assert.doesNotMatch(seen[1], /[?&]event=/);
  assert.match(seen[0], /\/actions\/workflows\/w\.yml\/runs\?/);
});

test('a 404 reports notFound rather than an error or a bare empty list', async () => {
  const { runs, error, notFound } = await fetchWorkflowRuns({
    repo: 'o/r', workflow: 'w.yml', token: 't', fetchImpl: async () => ({ status: 404, ok: false }),
  });
  assert.deepEqual(runs, []);
  assert.equal(error, null);
  assert.equal(notFound, true);
});

test('a non-OK response becomes an undetermined verdict rather than throwing', async () => {
  const { runs, error } = await fetchWorkflowRuns({
    repo: 'o/r', workflow: 'w.yml', token: 't', fetchImpl: async () => ({ status: 403, ok: false }),
  });
  assert.equal(runs, null);
  assert.match(error, /403/);
  assert.equal(assessCadence({ runs, now: NOW, error }).status, 'undetermined');
});

test('a thrown network error becomes an undetermined verdict rather than escaping', async () => {
  const { runs, error } = await fetchWorkflowRuns({
    repo: 'o/r', workflow: 'w.yml', token: 't',
    fetchImpl: async () => { throw new Error('ENOTFOUND api.github.com'); },
  });
  assert.equal(runs, null);
  assert.match(error, /ENOTFOUND/);
});

// ── The regression: the measured defect that justified the promotion ────────
//
// Fixture derived from the real run history of the consumer repo whose nightly
// had been red for four consecutive days (measured 2026-09-06):
//   ALL events     | runs:20 successes:11 | OK
//   event=schedule | runs:4  successes:0  | NEVER-RAN
// Eleven green push runs drowned four red scheduled ones and the watcher
// reported healthy throughout. This asserts BOTH halves: without the filter the
// old instrument still reads OK (so the fixture really does reproduce the
// blindness), and with it the outage is visible.

const MEASURED_HISTORY = {
  schedule: [
    { conclusion: 'failure', updated_at: '2026-09-06T09:01:02Z' },
    { conclusion: 'failure', updated_at: '2026-09-05T08:42:11Z' },
    { conclusion: 'failure', updated_at: '2026-09-04T09:10:12Z' },
    { conclusion: 'failure', updated_at: '2026-09-03T09:33:17Z' },
  ],
  push: Array.from({ length: 11 }, (_, i) => ({
    conclusion: 'success',
    updated_at: new Date(NOW.getTime() - i * 3_600_000).toISOString(),
  })),
};

function measuredFetch(url) {
  const isSchedule = /[?&]event=schedule\b/.test(url);
  const runs = isSchedule
    ? MEASURED_HISTORY.schedule
    : [...MEASURED_HISTORY.push, ...MEASURED_HISTORY.schedule];
  return { status: 200, ok: true, json: async () => ({ workflow_runs: runs }) };
}

test('WITHOUT an event filter, four red nightlies are invisible behind eleven green pushes', async () => {
  const report = await assessWatchList({
    watches: [{ workflow: 'phase-gates.yml', event: null, maxAgeDays: 2 }],
    repo: 'o/r', token: 't', now: NOW, fetchImpl: async (u) => measuredFetch(u),
  });
  assert.equal(report.status, 'ok', 'the fixture must reproduce the blindness, or the next assertion proves nothing');
});

test('WITH event=schedule, the same history is a non-vacuous never-ran finding', async () => {
  const report = await assessWatchList({
    watches: [{ workflow: 'phase-gates.yml', event: 'schedule', maxAgeDays: 2 }],
    repo: 'o/r', token: 't', now: NOW, fetchImpl: async (u) => measuredFetch(u),
  });
  assert.equal(report.status, 'never-ran');
  assert.equal(report.watches[0].verdict.vacuous, false, 'this must be evidence-backed, not a query that matched nothing');
  assert.equal(report.watches[0].verdict.runsExamined, 4);
  assert.ok(isWarning(report.status));
});

// ── The watch list ─────────────────────────────────────────────────────────

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test('a valid watch list parses, applying defaults per entry', () => {
  withTempDir((dir) => {
    const p = path.join(dir, WATCH_CONFIG_BASENAME);
    fs.writeFileSync(p, JSON.stringify({
      watch: [
        { workflow: 'a.yml', event: 'schedule', maxAgeDays: 2 },
        { workflow: 'b.yml' },
      ],
    }));
    const { watches, present } = loadWatchList(p);
    assert.equal(present, true);
    assert.equal(watches.length, 2);
    assert.deepEqual(watches[0], { workflow: 'a.yml', event: 'schedule', maxAgeDays: 2, label: null });
    assert.equal(watches[1].event, null);
    assert.equal(watches[1].maxAgeDays, DEFAULT_MAX_AGE_DAYS);
  });
});

test('an absent watch list is reported absent, not as an empty one', () => {
  withTempDir((dir) => {
    const { watches, present } = loadWatchList(path.join(dir, WATCH_CONFIG_BASENAME));
    assert.equal(present, false);
    assert.equal(watches, null);
  });
});

test('a malformed watch list ABORTS -- it never fails open into "nothing to watch"', () => {
  // A config the tool silently drops is a config whose author believes it is in
  // force: silence, from the one file that exists to prevent silence.
  withTempDir((dir) => {
    const p = path.join(dir, WATCH_CONFIG_BASENAME);
    for (const body of [
      '{ not json',
      '{"watch": "phase-gates.yml"}',
      '{"nowatchkey": []}',
      '{"watch": [{"event": "schedule"}]}',
      '{"watch": [{"workflow": "a.yml", "maxAgeDays": 0}]}',
      '{"watch": [{"workflow": "a.yml", "maxAgeDays": -3}]}',
      '{"watch": [{"workflow": "a.yml", "event": ""}]}',
      '{"watch": ["a.yml"]}',
    ]) {
      fs.writeFileSync(p, body);
      assert.throws(() => loadWatchList(p), /workflow-cadence|watch|JSON/i, `accepted malformed config: ${body}`);
    }
  });
});

// ── "Would silence be honest here?" ────────────────────────────────────────

test('discoverScheduledWorkflows finds cron-triggered workflows and ignores the rest', () => {
  withTempDir((dir) => {
    const wf = path.join(dir, '.github', 'workflows');
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(wf, 'nightly.yml'), 'on:\n  schedule:\n    - cron: "0 9 * * *"\n');
    fs.writeFileSync(path.join(wf, 'weekly.yaml'), 'on:\n  schedule:\n    - cron: "0 9 * * 1"\n');
    fs.writeFileSync(path.join(wf, 'push-only.yml'), 'on:\n  push:\n    branches: [main]\n');
    fs.writeFileSync(path.join(wf, 'notes.md'), 'schedule:\ncron:\n');
    assert.deepEqual(discoverScheduledWorkflows(dir), ['nightly.yml', 'weekly.yaml']);
  });
});

test('a repo with no .github/workflows discovers nothing rather than throwing', () => {
  withTempDir((dir) => assert.deepEqual(discoverScheduledWorkflows(dir), []));
});

test('this repo\'s own scheduled workflows are discoverable -- a positive control on the scanner', () => {
  // Without this, the discovery test above passes against synthetic files while
  // the scanner could be blind to every real workflow in the repo it ships in.
  const found = discoverScheduledWorkflows(REPO_ROOT);
  assert.ok(found.length >= 5, `expected this repo's cron workflows, got ${JSON.stringify(found)}`);
  assert.ok(found.includes('memory-health.yml'));
});

test('unconfigured warns and carries the pasteable remedy', () => {
  const v = unconfiguredVerdict(['a.yml', 'b.yml']);
  assert.equal(v.status, 'unconfigured');
  assert.ok(isWarning(v.status));
  assert.match(v.message, /NOTHING was checked/);
  const json = v.message.slice(v.message.indexOf('{'));
  assert.deepEqual(JSON.parse(json).watch.map((w) => w.workflow), ['a.yml', 'b.yml']);
});

// ── Rollup + render ────────────────────────────────────────────────────────

test('the rollup takes the worst watch, and not-knowing outranks a known finding', () => {
  assert.equal(rollupStatus(['ok', 'ok']), 'ok');
  assert.equal(rollupStatus(['ok', 'stale']), 'stale');
  assert.equal(rollupStatus(['stale', 'never-ran']), 'never-ran');
  assert.equal(rollupStatus(['never-ran', 'undetermined']), 'undetermined');
  assert.equal(rollupStatus([]), 'nothing-to-watch');
});

test('EVERY non-ok status warns -- including the tool\'s own instrument failing', () => {
  for (const status of ['stale', 'never-ran', 'undetermined', 'unconfigured']) {
    assert.equal(isWarning(status), true, `${status} must warn`);
    const out = render({ status, watches: [{ label: 'w', verdict: { status, message: 'm' } }] });
    assert.match(out, /^WARNING /, `${status} rendered without a warning`);
  }
  for (const status of ['ok', 'nothing-to-watch']) {
    assert.equal(isWarning(status), false);
  }
});

test('the Actions annotation form is used only under GITHUB_ACTIONS', () => {
  const report = { status: 'stale', watches: [{ label: 'a.yml@schedule', verdict: { status: 'stale', message: 'm' } }] };
  assert.match(render(report, { actions: true }), /^::warning title=Workflow cadence \(a\.yml@schedule\)::m/);
  assert.match(render(report, { actions: false }), /^WARNING \[a\.yml@schedule\] m/);
});

test('nothing-to-watch renders a quiet, non-warning line', () => {
  const out = render({ status: 'nothing-to-watch', watches: [] });
  assert.doesNotMatch(out, /WARNING|::warning/);
  assert.match(out, /nothing to watch/);
});

// ── The CLI contract ───────────────────────────────────────────────────────

function runCli(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // A real token on the developer's machine would make these tests hit the
  // network and pass or fail by whose laptop they run on.
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_REPOSITORY;
  delete env.GITHUB_ACTIONS;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', cwd: REPO_ROOT, env });
}

test('--selfcheck-relocation prints OK and exits 0', () => {
  const r = runCli(['--selfcheck-relocation']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^OK/);
});

test('an unknown flag is refused with exit 2, never silently ignored', () => {
  const r = runCli(['--workflow', 'a.yml', '--no-such-flag']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag/);
});

test('no token is UNDETERMINED and still exits 0 -- advisory is the default', () => {
  const r = runCli(['--repo', 'o/r', '--workflow', 'a.yml']);
  assert.equal(r.status, 0, 'the default must never block a push');
  assert.match(r.stdout, /WARNING/);
  assert.match(r.stdout, /NOT a pass/);
});

test('--strict is the opt-in that gives maintenance-checks a real exit code to key on', () => {
  // runCheck() in maintenance-checks.mjs derives a check's status from the
  // spawned process's exit code, so an always-exit-0 doctor would report `ok`
  // forever there -- false calm inside the registry.
  const r = runCli(['--repo', 'o/r', '--workflow', 'a.yml', '--strict']);
  assert.equal(r.status, 1);
});

test('an absent watch list in a repo WITH crons is unconfigured, not a silent pass', () => {
  const r = runCli(['--config', path.join(os.tmpdir(), 'definitely-absent-cadence-config.json')]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /WARNING/);
  assert.match(r.stdout, /NOTHING was checked/);
});

test('it RUNS under a consumer scripts/.claude-skills/ layout, not only this repo layout', () => {
  // Caught for real during promotion. The source instrument gated its own
  // `main()` on `process.argv[1].endsWith('scripts/<name>.mjs')` -- true here,
  // FALSE at the consumer path `scripts/.claude-skills/<name>.mjs`. The promoted
  // copy therefore ran nothing, printed nothing and exited 0 in every consumer:
  // a watcher shipped as a silent no-op, which is precisely the defect it exists
  // to detect.
  //
  // `--selfcheck-relocation` cannot see this -- its handler sits above the
  // direct-run guard and returns before it -- so the assertion has to be that
  // real OUTPUT appears from the relocated path. An empty stdout is the bug.
  withTempDir((dir) => {
    const skills = path.join(dir, 'scripts', '.claude-skills', 'lib');
    fs.mkdirSync(skills, { recursive: true });
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'nightly.yml'),
      ['on:', '  schedule:', '    - cron: "0 3 * * *"', ''].join('\n'));
    const relocated = path.join(dir, 'scripts', '.claude-skills', 'workflow-cadence-doctor.mjs');
    fs.copyFileSync(CLI, relocated);
    for (const lib of ['cli-io.mjs', 'branch-protection.mjs', 'assert-repo-root.mjs']) {
      fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'lib', lib), path.join(skills, lib));
    }

    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    delete env.GITHUB_REPOSITORY;
    delete env.GITHUB_ACTIONS;
    const r = spawnSync(process.execPath, [relocated], { encoding: 'utf-8', cwd: dir, env });

    assert.equal(r.status, 0);
    assert.notEqual(r.stdout.trim(), '', 'the relocated CLI produced NO output -- its main() never ran');
    assert.match(r.stdout, /NOTHING was checked/);
    assert.match(r.stdout, /nightly\.yml/);
  });
});

test('--json emits one parseable envelope whose ok reflects the RUN, not the repo health', () => {
  const r = runCli(['--repo', 'o/r', '--workflow', 'a.yml', '--json']);
  assert.equal(r.status, 0);
  const env = JSON.parse(r.stdout);
  assert.equal(env.ok, true, 'ok:false would couple an advisory warning to a non-zero exit');
  assert.equal(env.status, 'undetermined');
  assert.equal(env.watches.length, 1);
});
