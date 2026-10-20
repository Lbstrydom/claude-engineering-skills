/**
 * @fileoverview TIER 3 (a), sensitive-path egress: `--require` forces user-named paths into prompts sent to third-party
 * models, so the change and these tests land in the same commit (AGENTS.md "Testing doctrine").
 *
 * The assertions are on the EMITTED request text of every pass, never on configuration (AGENTS.md: assert the emitted
 * request, not the client config). A required non-code file (a lockfile) must be sent and counted; a required SENSITIVE
 * path — lexically sensitive, or innocently named and symlinked to one — must appear in NO request, and the audit must
 * not converge.
 *
 * The FINAL-REVIEW request path is asserted in tests/required-subjects-final-review.test.mjs (same emitted-request method, with a
 * positive control in the same request); this file is the audit passes' half of the seam.
 *
 * Runs the real orchestrator against a throwaway repo (cwd), with a stubbed model client (Tier 2: canned responses, the
 * invariants only). Windows may refuse to create symlinks; those cases skip with a named reason and the Linux CI run
 * exercises them.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultResponses } from './helpers/multi-pass-audit-fixtures.mjs';

const REPO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'req-egress-')));
const ORIGINAL_CWD = process.cwd();
const LOCK_MARK = 'LOCKFILE_MARKER_9F3A21';
const SECRET_MARK = 'SECRET_MARKER_77C1B0';
const ENV_MARK = 'DOTENV_MARKER_4D5E6F';

let symlinksOk = true;
before(() => {
  fs.mkdirSync(path.join(REPO, 'src'));
  fs.writeFileSync(path.join(REPO, 'src', 'service.mjs'), 'export const answer = 42;\n');
  fs.writeFileSync(path.join(REPO, 'package-lock.json'), JSON.stringify({ name: LOCK_MARK, lockfileVersion: 3, packages: {} }, null, 2));
  fs.writeFileSync(path.join(REPO, '.env'), `API_TOKEN=${ENV_MARK}\n`);
  fs.writeFileSync(path.join(REPO, 'notes.txt'), 'plain notes\n');
  fs.writeFileSync(path.join(REPO, 'secrets-store.json'), `{"k":"${SECRET_MARK}"}\n`);
  try { fs.symlinkSync(path.join(REPO, '.env'), path.join(REPO, 'innocent.json')); } catch { symlinksOk = false; }
  process.chdir(REPO);
});
after(() => { process.chdir(ORIGINAL_CWD); });

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
process.env.MODEL_CATALOG_REFRESH = 'skip';
process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';
process.env.AUDIT_NO_PREFLIGHT = '1';

const audit = await import('../scripts/openai-audit.mjs');
const { runMultiPassCodeAudit } = audit.__testExports;

const PLAN = '# Plan\n\nModify `src/service.mjs`.\n';
const OPTS = { passFilter: ['structure', 'wiring', 'backend', 'sustainability', 'quickfix'], noTools: true, noDebtLedger: true, noLedger: true, scopeMode: 'plan' };

/** A stub model client that RECORDS every request it is handed. */
function recordingStub() {
  const requests = [];
  return {
    requests,
    client: {
      responses: {
        parse: async (params) => {
          requests.push(JSON.stringify(params));
          const name = params?.text?.format?.name;
          const responses = defaultResponses();
          if (!(name in responses)) throw new Error(`unstubbed pass ${name}`);
          return {
            status: 'completed', output: [], output_parsed: responses[name],
            usage: { input_tokens: 100, output_tokens: 50, prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } },
          };
        },
      },
    },
  };
}
const run = async (requiredSubjects) => {
  const stub = recordingStub();
  const res = await runMultiPassCodeAudit(stub.client, PLAN, '', false, null, '', { ...OPTS, ...(requiredSubjects ? { requiredSubjects } : {}) });
  return { res, all: stub.requests.join('\n'), n: stub.requests.length };
};
const subj = (p, sensitive = false) => ({ path: p, sensitive, onDisk: true, reason: null });
const statusOf = (res, p) => res._coverage.requiredSubjects.subjects.find((s) => s.path === p)?.status;

describe('required non-code subject: sent to the reviewers and counted (Louis decision 3, 2026-10-19)', () => {
  it('P-A1: the lockfile reaches an emitted request, is FULL, and the round converges', async () => {
    const { res, all, n } = await run([subj('package-lock.json')]);
    assert.ok(n >= 3, 'the passes really ran');
    assert.ok(all.includes(LOCK_MARK), 'the required lockfile body was sent to a pass');
    assert.ok(res.code_files.includes('package-lock.json'), 'it is in the audit\'s admitted set (what the final review inherits)');
    assert.equal(statusOf(res, 'package-lock.json'), 'FULL');
    assert.deepEqual(res._convergence, { converged: true, reason: 'converged' });
    assert.match(res.overall_reasoning ?? '', /./);
  });
  it('P-A1n control: the SAME file without --require is NOT sent and the report carries no required block', async () => {
    const { res, all } = await run(null);
    assert.equal(all.includes(LOCK_MARK), false, 'a lockfile is non-code: today\'s admission is unchanged');
    assert.equal('requiredSubjects' in res._coverage, false);
  });
  it('a required file that does not exist is UNREAD "not on disk" and withholds convergence, the run is not refused', async () => {
    const { res } = await run([subj('package-lock.json'), { path: 'typo/never.txt', sensitive: false, onDisk: false, reason: null }]);
    assert.equal(statusOf(res, 'typo/never.txt'), 'UNREAD');
    assert.deepEqual(res._convergence, { converged: false, reason: 'required-subjects-not-full' });
    assert.notEqual(res.verdict, 'INCOMPLETE', 'the change was measured: this is not exit 3');
  });
});

describe('P-A3 egress: a required SENSITIVE subject is reported and never sent', () => {
  it('a lexically sensitive path (.env) is SENSITIVE, absent from EVERY emitted request, and blocks convergence', async () => {
    const { res, all } = await run([subj('package-lock.json'), subj('.env', true)]);
    assert.equal(all.includes(ENV_MARK), false, 'the .env body reached a model');
    assert.equal(statusOf(res, '.env'), 'SENSITIVE');
    assert.deepEqual(res._convergence, { converged: false, reason: 'required-subjects-not-full' });
    assert.equal(all.includes(LOCK_MARK), true, 'control: the non-sensitive required file in the same run IS sent');
  });
  it('an innocently named symlink to .env (validator-marked sensitive) is SENSITIVE and its target body never leaves', async (t) => {
    if (!symlinksOk) return t.skip('this host cannot create symlinks; the Linux CI run exercises this');
    const { res, all } = await run([subj('innocent.json', true)]);
    assert.equal(all.includes(ENV_MARK), false);
    assert.equal(statusOf(res, 'innocent.json'), 'SENSITIVE');
  });
  it('BACKSTOP: even if a sensitive path reaches the audit unflagged, the reader refuses it (defence in depth)', async () => {
    const { all } = await run([subj('.env', false)]);
    assert.equal(all.includes(ENV_MARK), false, 'the reader\'s own sensitive-file check is the second wall');
  });
  it('BACKSTOP: a symlink to a sensitive target that the validator did NOT flag is still never read', async (t) => {
    if (!symlinksOk) return t.skip('this host cannot create symlinks; the Linux CI run exercises this');
    const { all } = await run([subj('innocent.json', false)]);
    assert.equal(all.includes(ENV_MARK), false, 'safeReadFile classifies the RESOLVED path (INC-001)');
  });
  it('redaction still applies to an admitted required file: a secret-shaped string inside it is masked on the way out', async () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    fs.writeFileSync(path.join(REPO, 'notes.txt'), `build token ${token}\n`);
    const { all } = await run([subj('notes.txt')]);
    assert.equal(all.includes(token), false, 'the secret-shaped value must be redacted before egress');
    assert.ok(all.includes('build token'), 'control: the file itself was sent');
  });
});
