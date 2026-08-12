#!/usr/bin/env node
/**
 * @fileoverview Golden-envelope capture for the cross-skill command registry
 * migration (docs/plans/cross-skill-command-registry.md, Phase 2).
 *
 * Runs a fixed table of HERMETIC invocations against the CURRENT
 * `scripts/cross-skill.mjs` and records {status, envelope} per case into
 * `tests/fixtures/cross-skill-envelopes.json`. The fixtures are captured from
 * the LIVE legacy CLI — never hand-written (a hand-written fixture encodes the
 * author's expectations, which is the assumption under test; the
 * `severity`-vs-`code` incident is the canonical case).
 *
 * Hermetic means: no AUDIT_DB_URL, HOME/USERPROFILE redirected to a temp dir
 * (so `~/.audit-loop.env` cannot leak cloud config in), shared-config load
 * disabled, and cwd set to a NON-git temp directory so `currentCommitSha()`
 * degrades to null deterministically. The golden test replays each case with
 * the SAME runner (imported from here), so capture and comparison cannot
 * drift apart.
 *
 * Re-run to regenerate: node scripts/dev/capture-cross-skill-envelopes.mjs
 * A regeneration on unchanged behaviour must be a no-op diff.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError } from '../lib/cli-io.mjs';

const KNOWN_FLAGS = ['--recapture', '--selfcheck-relocation', '--help'];

const CLI_PATH = fileURLToPath(new URL('../cross-skill.mjs', import.meta.url));
export const FIXTURE_PATH = fileURLToPath(
  new URL('../../tests/fixtures/cross-skill-envelopes.json', import.meta.url),
);

/**
 * The invocation table. One row per behaviour worth freezing: the happy path,
 * each BAD_INPUT refusal, and the cloud-off degrade, per migrated command.
 * `expectEnvelope: false` marks rows whose contract is "no JSON envelope at
 * all" (the unknown-flag ArgvError path writes prose to stderr only).
 *
 * Rows are appended as commands migrate — never rewritten for an already-
 * migrated command (that would re-capture from the NEW implementation and
 * defeat the point).
 */
export const CASES = [
  // ── whoami ────────────────────────────────────────────────────────────────
  { id: 'whoami-cloud-off', args: ['whoami'] },
  { id: 'whoami-unknown-flag', args: ['whoami', '--not-a-real-flag'], expectEnvelope: false },
  // ── record-ship-event ────────────────────────────────────────────────────
  { id: 'ship-event-missing-outcome', args: ['record-ship-event', '--json', '{}'] },
  { id: 'ship-event-cloud-off-happy', args: ['record-ship-event', '--json', '{"outcome":"success"}'] },
  // ── persona-outcomes ─────────────────────────────────────────────────────
  { id: 'po-no-verb', args: ['persona-outcomes'] },
  { id: 'po-bogus-verb', args: ['persona-outcomes', 'bogus-verb'] },
  { id: 'po-summary-no-repo', args: ['persona-outcomes', 'summary'] },
  { id: 'po-summary-cloud-off', args: ['persona-outcomes', 'summary', '--repo', 'owner/repo'] },
  { id: 'po-label-missing-args', args: ['persona-outcomes', 'label', '--session', 's'] },
  { id: 'po-label-bad-outcome', args: ['persona-outcomes', 'label', '--session', 's', '--hash', 'h', '--outcome', 'bogus'] },
  { id: 'po-label-cloud-off', args: ['persona-outcomes', 'label', '--session', 's', '--hash', 'h', '--outcome', 'fixed'] },
  { id: 'po-worksheet-no-repo', args: ['persona-outcomes', '--worksheet'] },
  { id: 'po-backfill-no-repo', args: ['persona-outcomes', 'backfill-hash'] },

  // ── Cluster B (Phase 3) — mutating writers ────────────────────────────────
  // Captured from the LEGACY handlers before migration. Cloud is off in the
  // hermetic env, so every "happy" row here is the documented degrade path.
  //
  // SPEND SAFETY: `arm-eval-run` has NO cloud gate — it proceeds straight to
  // runArmEvalSession, which makes paid LLM calls, and the hermetic env still
  // inherits the API keys. Only its input-refusal (which returns before any
  // provider call) is capturable; its degrade path is deliberately uncovered
  // and named as such in the plan's coverage note rather than captured by
  // spending money in a test.
  { id: 'upsert-plan-missing', args: ['upsert-plan', '--json', '{}'] },
  { id: 'upsert-plan-cloud-off', args: ['upsert-plan', '--json', '{"path":"docs/plans/x.md","skill":"plan"}'] },
  { id: 'update-plan-status-no-id', args: ['update-plan-status', '--json', '{}'] },
  { id: 'update-plan-status-no-status', args: ['update-plan-status', '--json', '{"path":"docs/plans/x.md"}'] },
  { id: 'update-plan-status-cloud-off', args: ['update-plan-status', '--json', '{"path":"docs/plans/x.md","status":"Complete"}'] },
  { id: 'rec-spec-missing', args: ['record-regression-spec', '--json', '{}'] },
  { id: 'rec-spec-no-path', args: ['record-regression-spec', '--json', '{"sourceKind":"audit-loop-fix","description":"d"}'] },
  { id: 'rec-spec-cloud-off', args: ['record-regression-spec', '--json', '{"sourceKind":"audit-loop-fix","description":"d","specPath":"tests/x.spec.ts"}'] },
  { id: 'rec-spec-run-missing', args: ['record-regression-spec-run', '--json', '{}'] },
  { id: 'rec-spec-run-cloud-off', args: ['record-regression-spec-run', '--json', '{"specId":"s1","passed":true}'] },
  { id: 'rec-correlation-missing', args: ['record-correlation', '--json', '{}'] },
  { id: 'rec-correlation-cloud-off', args: ['record-correlation', '--json', '{"personaSessionId":"s1","personaFindingHash":"h","personaSeverity":"P0","correlationType":"exact"}'] },
  { id: 'nav-run-no-sha', args: ['record-nav-audit-run', '--json', '{}'] },
  { id: 'nav-run-no-drift', args: ['record-nav-audit-run', '--json', '{"headSha":"abc"}'] },
  { id: 'nav-run-bad-scope', args: ['record-nav-audit-run', '--json', '{"headSha":"abc","driftKeys":[],"scope":"bogus"}'] },
  { id: 'nav-run-cloud-off', args: ['record-nav-audit-run', '--json', '{"headSha":"abc","driftKeys":[]}'] },
  { id: 'pv-run-no-plan', args: ['record-plan-verify-run', '--json', '{}'] },
  { id: 'pv-run-bad-counts', args: ['record-plan-verify-run', '--json', '{"planId":"p1","totalCriteria":-3}'] },
  { id: 'pv-run-cloud-off', args: ['record-plan-verify-run', '--json', '{"planId":"p1","totalCriteria":3,"passedCount":3}'] },
  { id: 'pv-items-missing', args: ['record-plan-verify-items', '--json', '{}'] },
  { id: 'pv-items-empty', args: ['record-plan-verify-items', '--json', '{"runId":"r1","planId":"p1","items":[]}'] },
  { id: 'pv-items-cloud-off', args: ['record-plan-verify-items', '--json', '{"runId":"r1","planId":"p1","items":[{"criterion":"c"}]}'] },
  { id: 'add-persona-missing', args: ['add-persona', '--json', '{}'] },
  { id: 'add-persona-cloud-off', args: ['add-persona', '--json', '{"name":"n","description":"d","appUrl":"https://e.test"}'] },
  { id: 'rec-session-missing', args: ['record-persona-session', '--json', '{}'] },
  { id: 'rec-session-cloud-off', args: ['record-persona-session', '--json', '{"persona":"p","url":"https://e.test","browserTool":"playwright","verdict":"Needs work"}'] },
  { id: 'fr-adj-cloud-off', args: ['final-review-adjudicate', '--run-id', 'r1', '--fingerprint', 'f1', '--action', 'accepted'] },
  { id: 'fr-fix-cloud-off', args: ['final-review-record-fix', '--run-id', 'r1', '--fingerprint', 'f1'] },
  { id: 'mab-adj-cloud-off', args: ['model-ab-adjudicate', '--json'] },
  { id: 'arm-run-missing', args: ['arm-eval-run'] },
  { id: 'arm-toggle-status', args: ['arm-eval-toggle', 'status'] },
  { id: 'arm-toggle-bad-verb', args: ['arm-eval-toggle', 'bogus'] },
  { id: 'arm-capture-toggle-off', args: ['arm-eval-maybe-capture', '--experiment', 'brainstorm', '--task', 't'] },
  { id: 'arm-adj-cloud-off', args: ['arm-eval-adjudicate', '--session-id', 's1'] },
  { id: 'arm-export-cloud-off', args: ['arm-eval-export', '--session-id', 's1'] },
  { id: 'learning-record-missing', args: ['learning-record', '--json', '{}'] },
  { id: 'learning-record-no-binding', args: ['learning-record', '--json', '{"decisionType":"pass_selection","context":{"a":1},"choice":{"b":2}}'] },
  { id: 'learning-record-cloud-off', args: ['learning-record', '--json', '{"decisionType":"pass_selection","context":{"a":1},"choice":{"b":2},"externalId":"e1"}'] },
  { id: 'open-refresh-missing', args: ['open-refresh-run', '--json', '{}'] },
  { id: 'publish-refresh-missing', args: ['publish-refresh-run', '--json', '{}'] },
  { id: 'abort-refresh-missing', args: ['abort-refresh-run', '--json', '{}'] },
  { id: 'rec-symdefs-missing', args: ['record-symbol-definitions', '--json', '{}'] },
  { id: 'rec-symindex-missing', args: ['record-symbol-index', '--json', '{}'] },
  { id: 'rec-symembed-missing', args: ['record-symbol-embedding', '--json', '{}'] },
  { id: 'rec-layering-missing', args: ['record-layering-violations', '--json', '{}'] },
  { id: 'set-embed-model-missing', args: ['set-active-embedding-model', '--json', '{}'] },
  { id: 'lock-with-test-missing', args: ['lock-with-test'] },

  // ── Cluster C (Phase 4) — readers ────────────────────────────────────────
  // Captured from the LEGACY handlers before migration. Readers degrade rather
  // than refuse, so most rows here are the cloud-off shape — which is exactly
  // the contract that must not drift (a reader's empty result and its
  // "unmeasured" result are different facts, and several of these commands
  // exist to keep them apart).
  { id: 'plan-satisfaction-no-id', args: ['plan-satisfaction'] },
  { id: 'audit-effectiveness-no-repo', args: ['audit-effectiveness'] },
  { id: 'list-unlocked-cloud-off', args: ['list-unlocked-fixes'] },
  { id: 'list-unremediated-cloud-off', args: ['list-unremediated-acceptances'] },
  { id: 'preview-gate-json', args: ['preview-gate'] },
  { id: 'detect-stack-json', args: ['detect-stack'] },
  { id: 'list-personas-no-url', args: ['list-personas'] },
  { id: 'list-personas-cloud-off', args: ['list-personas', '--url', 'https://e.test'] },
  { id: 'sessions-by-repo-no-repo', args: ['get-persona-sessions-by-repo'] },
  { id: 'sessions-by-repo-cloud-off', args: ['get-persona-sessions-by-repo', '--repo', 'owner/repo'] },
  { id: 'sessions-by-url-no-url', args: ['get-persona-sessions-by-url'] },
  { id: 'sessions-by-url-cloud-off', args: ['get-persona-sessions-by-url', '--url', 'https://e.test'] },
  { id: 'reachability-no-repo', args: ['get-reachability-evidence'] },
  { id: 'reachability-cloud-off', args: ['get-reachability-evidence', '--repo', 'owner/repo'] },
  { id: 'recent-findings-cloud-off', args: ['get-recent-findings', '--repo', 'owner/repo'] },
  { id: 'nav-first-seen-no-keys', args: ['get-nav-first-seen', '--json', '{}'] },
  { id: 'nav-first-seen-cloud-off', args: ['get-nav-first-seen', '--json', '{"driftKeys":["k1"]}'] },
  { id: 'fr-stats-no-repo', args: ['final-review-stats'] },
  { id: 'fr-pending-no-repo', args: ['final-review-pending'] },
  { id: 'fr-pending-cloud-off', args: ['final-review-pending', '--repo', 'owner/repo'] },
  { id: 'shadow-overlap-cloud-off', args: ['shadow-overlap', '--json', '{"runIds":["r1"]}'] },
  // `volatile` names fields whose value is derived from the ENVIRONMENT rather
  // than from the command's contract. Here the repo name comes from the cwd,
  // and every run gets a fresh randomised temp dir — so the field differs on
  // every invocation by construction. Pinning it would make the fixture fail
  // spuriously forever, and a golden that cries wolf gets deleted, taking its
  // real coverage with it. Normalised on BOTH sides instead, so the rest of the
  // envelope (ok, repoUuid shape, persisted) stays pinned.
  // Both fields derive from the randomised temp cwd: `name` is its basename and
  // `repoUuid` is a v5 uuid hashed FROM the path (the envelope says so —
  // `source: 'path-fallback'`). What stays pinned is everything that IS the
  // contract: ok, persisted, remoteUrl, source, and the presence + type of the
  // two volatile fields.
  { id: 'resolve-identity-json', args: ['resolve-repo-identity'], volatile: ['name', 'repoUuid'] },
  { id: 'active-refresh-no-uuid', args: ['get-active-refresh-id'] },
  { id: 'active-refresh-cloud-off', args: ['get-active-refresh-id', '--repo-uuid', 'u1'] },
  { id: 'target-domains-no-paths', args: ['compute-target-domains', '--json', '{}'] },
  { id: 'target-domains-ok', args: ['compute-target-domains', '--json', '{"targetPaths":["scripts/cross-skill.mjs"]}'] },
  { id: 'callers-no-path', args: ['get-callers-for-file', '--json', '{}'] },
  { id: 'callers-cloud-off', args: ['get-callers-for-file', '--json', '{"path":"scripts/cross-skill.mjs"}'] },
  { id: 'list-symbols-no-refresh', args: ['list-symbols-for-snapshot', '--json', '{}'] },
  { id: 'list-symbols-cloud-off', args: ['list-symbols-for-snapshot', '--json', '{"refreshId":"r1"}'] },
  { id: 'list-layering-no-refresh', args: ['list-layering-violations-for-snapshot'] },
  { id: 'list-layering-cloud-off', args: ['list-layering-violations-for-snapshot', '--refresh-id', 'r1'] },
  { id: 'drift-score-missing', args: ['compute-drift-score', '--json', '{}'] },
  { id: 'drift-score-cloud-off', args: ['compute-drift-score', '--json', '{"repoId":"p","refreshId":"r"}'] },
  { id: 'neighbourhood-cloud-off', args: ['get-neighbourhood', '--json', '{"targetPaths":["scripts/cross-skill.mjs"],"intentDescription":"x"}'] },
  { id: 'incident-neighbourhood-cloud-off', args: ['get-incident-neighbourhood', '--json', '{"targetPaths":["scripts/cross-skill.mjs"],"intentDescription":"x"}'] },

  // ── Cluster D (Phase 5) — remaining readers, model-eval, learning,
  //    forwarders, legacy retirement ─────────────────────────────────────────
  // Same rule as every cohort: captured from LEGACY before migration.
  // `arm-eval-run` stays refusal-only (no cloud gate → paid LLM calls).
  { id: 'fr-stats-cloud-off', args: ['final-review-stats', '--repo', 'owner/repo'] },
  { id: 'shadow-overlap-no-runids', args: ['shadow-overlap', '--json', '{}'] },
  { id: 'recommend-skills-json', args: ['recommend-skills'] },
  { id: 'mab-stats-cloud-off', args: ['model-ab-stats'] },
  { id: 'mab-decision-cloud-off', args: ['model-ab-decision'] },
  { id: 'mab-adj-bad-action', args: ['model-ab-adjudicate', '--action', 'bogus'] },
  { id: 'arm-decision-no-exp', args: ['arm-eval-decision'] },
  { id: 'arm-stats-cloud-off', args: ['arm-eval-stats'] },
  { id: 'arm-adj-no-session', args: ['arm-eval-adjudicate'] },
  { id: 'arm-export-no-args', args: ['arm-eval-export'] },
  { id: 'arm-capture-no-exp', args: ['arm-eval-maybe-capture'] },
  { id: 'learning-stats-cloud-off', args: ['learning-stats'] },
  { id: 'learning-qf-stats', args: ['learning-quickfix-stats', '--action', 'stats'] },
  { id: 'learning-qf-bad-action', args: ['learning-quickfix-stats', '--action', 'bogus'] },
  { id: 'quality-no-verb', args: ['quality'] },
  { id: 'quality-bad-verb', args: ['quality', 'bogus-verb'] },
  { id: 'upstream-no-verb', args: ['upstream'] },
  { id: 'upstream-bad-verb', args: ['upstream', 'bogus-verb'] },
  { id: 'friction-neighbourhood-empty', args: ['get-friction-neighbourhood', '--json', '{"prompt":"x"}'] },
  { id: 'finalize-outcomes-missing', args: ['finalize-outcomes'] },
  // The ENOENT message embeds the ABSOLUTE path of the randomised temp cwd, so
  // the message is environment-derived even though the error code is not.
  // Volatile paths are dotted for exactly this: the contract being pinned is
  // `{ok:false, error.code:'BAD_INPUT'}` at exit 2, not the OS's phrasing.
  { id: 'finalize-outcomes-bad-round', args: ['finalize-outcomes', '--run-id', 'r', '--ledger', 'nope.json', '--result', 'nope.json', '--round', '0'], volatile: ['error.message'] },
  // The last five uncovered commands, captured before their migration. The
  // wrappers (friction-log, learning-*, write-spill) hand off to a
  // self-contained sub-CLI, so what is pinned here is the ENVELOPE THIS CLI
  // returns for the handoff — which is the only part the registry owns.
  { id: 'friction-log-no-msg', args: ['friction-log'] },
  { id: 'write-spill-no-verb', args: ['write-spill'] },
  { id: 'write-spill-bad-verb', args: ['write-spill', 'bogus'] },
  { id: 'write-spill-status', args: ['write-spill', 'status'] },
  { id: 'learning-weekly-dry', args: ['learning-weekly-review', '--dry-run'] },
  { id: 'learning-backfill-dry', args: ['learning-backfill-outcomes', '--dry-run', '--skip-drain', '--skip-resolve'] },
  { id: 'learning-replay-no-type', args: ['learning-replay'] },
];

/** Run one case hermetically. Shared by capture (here) and replay (the test). */
export function runCase(c, { tmpRoot }) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${c.id.slice(0, 20)}-`));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, AUDIT_LOOP_DISABLE_SHARED: '1' };
  delete env.DOTENV_CONFIG_PATH;
  delete env.AUDIT_DB_URL;
  delete env.PERSONA_TEST_REPO_NAME;
  delete env.LEARNING_REPO_NAME;
  const r = spawnSync(process.execPath, [CLI_PATH, ...c.args], {
    encoding: 'utf8', env, cwd: dir, timeout: 60_000,
  });
  const line = (r.stdout || '').split('\n').filter((l) => l.trim().startsWith('{')).pop();
  return {
    status: r.status,
    envelope: line ? JSON.parse(line) : null,
    stderrSample: (r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] ?? null,
  };
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'capture-cross-skill-envelopes.mjs' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  // EXISTING cases are preserved, never silently re-captured (audit CA-r1):
  // after a command migrates, this tool runs the MIGRATED implementation, so
  // re-capturing an existing case would overwrite the legacy-captured oracle
  // with the thing it exists to check — the golden test would then compare
  // the new implementation against itself. Only NEW case ids are appended.
  // `--recapture <id>` re-captures one named case deliberately (for a
  // documented, reviewed contract change), and says so on stderr.
  const recaptureIdx = process.argv.indexOf('--recapture');
  const recaptureId = recaptureIdx >= 0 ? process.argv[recaptureIdx + 1] : null;
  const existing = fs.existsSync(FIXTURE_PATH)
    ? JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).cases
    : {};
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xskill-capture-'));
  const out = { _comment: 'Captured from the live legacy CLI by scripts/dev/capture-cross-skill-envelopes.mjs — never hand-edit an entry; existing entries are preserved on re-run (see --recapture).', cases: {} };
  let captured = 0;
  try {
    for (const c of CASES) {
      if (existing[c.id] && c.id !== recaptureId) {
        out.cases[c.id] = existing[c.id];
        continue;
      }
      const res = runCase(c, { tmpRoot });
      if (c.expectEnvelope !== false && !res.envelope) {
        process.stderr.write(`  [capture] ${c.id}: NO envelope (status ${res.status}) — refusing to record a case that produced nothing\n`);
        process.exitCode = 1;
        return;
      }
      out.cases[c.id] = { args: c.args, status: res.status, envelope: res.envelope };
      captured += 1;
      process.stderr.write(`  [capture] ${c.id}: status ${res.status}${c.id === recaptureId ? ' (RE-captured deliberately)' : ''}\n`);
    }
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(out, null, 2)}\n`);
    process.stderr.write(`  [capture] ${captured} new / ${CASES.length - captured} preserved → ${FIXTURE_PATH}\n`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
