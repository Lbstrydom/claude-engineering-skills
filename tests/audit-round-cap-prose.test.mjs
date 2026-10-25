/**
 * The prose↔code seam of the round cap (docs/plans/audit-round-cap-structural-or-stop.md §9).
 *
 * The caps lived in SKILL.md prose and nothing compared them with code. This pins both directions:
 *   1. every cap number the shared reference and the two SKILL.md files quote equals `AUDIT_ROUND_CAPS`;
 *   2. the R2+ `openai-audit.mjs` command line each skill PUBLISHES, run past its cap with only the placeholders
 *      substituted, is refused with exit 4 and the card — so a skill edit cannot drift from what the tests exercise.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AUDIT_ROUND_CAPS } from '../scripts/lib/audit/round-cap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const PRELOAD = pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'no-network-preload.mjs')).href;
const AUDIT_DIR = path.join(ROOT, '.audit');

const REF = read('docs/audit/shared-references/round-cap-and-structural-card.md');
const PLAN_SKILL = read('skills/audit-plan/SKILL.md');
const CODE_SKILL = read('skills/audit-code/SKILL.md');

describe('cap numbers in prose equal the code constant', () => {
  it('the shared reference table quotes both caps for both audits', () => {
    for (const mode of ['plan', 'code']) {
      const { soft, absolute } = AUDIT_ROUND_CAPS[mode];
      assert.match(REF, new RegExp(`\\|\\s*\`${mode}\`\\s*\\|\\s*${soft}\\s*\\|\\s*${absolute}\\s*\\|`), `${mode}: ${soft}/${absolute}`);
    }
  });
  it('/audit-plan quotes "3 rounds, 5 absolute"; /audit-code quotes "Max 6 rounds … 8 absolute"', () => {
    const p = AUDIT_ROUND_CAPS.plan;
    const c = AUDIT_ROUND_CAPS.code;
    assert.ok(PLAN_SKILL.includes(`Cap: ${p.soft} rounds, ${p.absolute} absolute`));
    assert.ok(CODE_SKILL.includes(`Max ${c.soft} rounds for code audits, ${c.absolute} absolute`));
  });
  it('the reference names the override flag and the exit code the operator will see', () => {
    assert.match(REF, /--past-cap/);
    assert.match(REF, /exit 4 \(`CAPPED`\)/);
  });
  it('both skills point at the reference and carry its index row', () => {
    for (const s of [PLAN_SKILL, CODE_SKILL]) {
      assert.match(s, /references\/round-cap-and-structural-card\.md/);
      assert.match(s, /\| `references\/round-cap-and-structural-card\.md` \| Enforced GPT round cap/);
    }
  });
  it('the skills tell the agent exit 4 is a stop for a human call, never a retry', () => {
    for (const s of [PLAN_SKILL, CODE_SKILL]) assert.match(s, /exits\s+`4` \(`CAPPED`\)[\s\S]{0,200}never a\s+retry/);
  });
});

/** The first fenced bash line in `md` that starts the given openai-audit invocation with `--round 2`. */
function publishedRound2Line(md, mode) {
  const re = new RegExp(`^node scripts/openai-audit\\.mjs ${mode} "\\$PLAN_FILE"[^\\n]*--round 2[^\\n]*$`, 'm');
  const m = md.match(re);
  assert.ok(m, `no published R2 ${mode} command line found`);
  return m[0];
}

/** Split a published command line into argv, substituting placeholders; drops the shell redirect. */
function toArgv(line, { planFile, sid, round }) {
  const noRedirect = line.replace(/\s2>\S+\s*$/, '');
  const vars = { PLAN_FILE: planFile, SID: sid, CHANGED: 'a.mjs', FILES: 'a.mjs', PASSES: 'backend', SCOPE: 'diff' };
  const substituted = noRedirect
    .replace(/\$\{?([A-Z_]+)\}?/g, (_, name) => vars[name] ?? name.toLowerCase())
    .replace(/--round 2/, `--round ${round}`);
  const out = [];
  for (const m of substituted.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out.slice(1); // drop the leading `node`
}

function run(args) {
  const netLog = path.join(os.tmpdir(), `prose-net-${process.pid}-${Date.now()}.log`);
  fs.writeFileSync(netLog, '');
  return new Promise((resolve) => {
    const env = { ...process.env, AUDIT_DB_URL: '', NO_NET_LOG: netLog, MODEL_CATALOG_REFRESH: 'skip', AUDIT_TOOL_VERSION_CHECK: 'skip', CI: '1' };
    delete env.AUDIT_SESSION_ID;
    const child = spawn(process.execPath, ['--import', PRELOAD, ...args], { cwd: ROOT, env, windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      const attempts = fs.readFileSync(netLog, 'utf-8').split('\n').filter(Boolean);
      fs.rmSync(netLog, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      resolve({ code, stderr, attempts });
    });
  });
}

describe('the commands the skills publish, run past their cap, are refused', () => {
  for (const [mode, md, round] of [['plan', PLAN_SKILL, 4], ['code', CODE_SKILL, 7]]) {
    it(`${mode}: the published R2 line at round ${round} exits 4 with the card and makes no network attempt`, async () => {
      const sid = `audit-${mode}-prosetest-${process.pid}-${Date.now()}`;
      const line = publishedRound2Line(md, mode);
      const argv = toArgv(line, { planFile: 'docs/plans/audit-round-cap-structural-or-stop.md', sid, round });
      assert.ok(argv.includes('--round') && argv[argv.indexOf('--round') + 1] === String(round), `substitution kept --round ${round}: ${argv.join(' ')}`);
      try {
        const r = await run(argv);
        assert.equal(r.code, 4, r.stderr);
        assert.match(r.stderr, new RegExp(`Structural-or-stop: ${mode} audit, round ${round} requested`));
        assert.deepEqual(r.attempts, []);
      } finally {
        for (const f of fs.existsSync(AUDIT_DIR) ? fs.readdirSync(AUDIT_DIR) : []) {
          if (f.startsWith(sid)) fs.rmSync(path.join(AUDIT_DIR, f), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        }
      }
    });
  }
  it('negative control: the same published line at the soft cap is NOT refused by the gate', async () => {
    const sid = `audit-plan-prosetest-${process.pid}-${Date.now()}`;
    const argv = toArgv(publishedRound2Line(PLAN_SKILL, 'plan'), { planFile: 'docs/plans/audit-round-cap-structural-or-stop.md', sid, round: 3 });
    // The gate passes, then the audit would start; kill it as soon as the gate's own line appears.
    const r = await new Promise((resolve) => {
      const env = { ...process.env, AUDIT_DB_URL: '', NO_NET_LOG: path.join(os.tmpdir(), `prose-ctl-${process.pid}.log`), MODEL_CATALOG_REFRESH: 'skip', AUDIT_TOOL_VERSION_CHECK: 'skip', CI: '1' };
      const child = spawn(process.execPath, ['--import', PRELOAD, ...argv], { cwd: ROOT, env, windowsHide: true });
      let stderr = '';
      const timer = setTimeout(() => child.kill(), 60_000);
      child.stderr.on('data', (d) => { stderr += d; if (/\[round-cap\] within cap/.test(stderr)) child.kill(); });
      child.stdout.on('data', () => {});
      child.on('close', () => { clearTimeout(timer); resolve(stderr); });
    });
    assert.match(r, /\[round-cap\] within cap: plan round 3\/3/);
  });
});
