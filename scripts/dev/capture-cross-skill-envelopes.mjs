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
