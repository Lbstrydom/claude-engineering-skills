/**
 * Work-consumer feedback 2026-11-15, items 1 + 3: a fresh worktree has no audit
 * route, and degraded audits were offered against the user's ruling; CRLF in
 * fresh worktrees broke byte-identity tests.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkAuditReadiness, resolveAuditRoute, degradedAuditsForbidden, FORBID_DEGRADED_VAR, SHARED_ENV_HINT,
} from '../scripts/lib/install/audit-readiness.mjs';
import { assessEolHazard, gitattributesPinsEol, probeEolHazard } from '../scripts/lib/eol-hazard.mjs';
import { hydrationNotes } from '../scripts/skills-hydrate.mjs';
import { MARKER_BLOCK } from '../scripts/lib/worktree-preflight.mjs';
import { Report } from '../scripts/lib/doctor/report.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const items = (r) => r.sections.flatMap((s) => s.items);
const noEol = () => ({ measured: true, hazard: false, reason: null });

describe('audit route — the ROUTE oracle, never one env var', () => {
  test('no key and no Azure profile → route MISSING, a FAIL naming ~/.audit-loop.env', () => {
    const r = new Report();
    const route = checkAuditReadiness({}, r, REPO, { probeEol: noEol });
    assert.equal(route.available, false);
    const item = items(r).find((i) => i.label === 'audit route: MISSING');
    assert.ok(item, 'audit route: MISSING line present');
    assert.equal(item.status, 'FAIL');
    assert.match(item.fix, /~\/\.audit-loop\.env/);
    assert.match(item.fix, /Do not copy a \.env/, 'never tells the agent to copy a .env — says the opposite');
    assert.equal(r.failures, 1);
  });

  test('Azure profile with no OPENAI_API_KEY → route azure (not MISSING)', () => {
    const env = { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt' };
    assert.deepEqual(resolveAuditRoute(env).route, 'azure');
    const r = new Report();
    checkAuditReadiness(env, r, REPO, { probeEol: noEol });
    assert.ok(items(r).some((i) => i.label === 'audit route: azure' && i.status === 'PASS'));
  });

  test('public key → route public', () => {
    assert.equal(resolveAuditRoute({ OPENAI_API_KEY: 'sk-x' }).route, 'public');
  });

  test('half-configured Azure → MISSING with a reason, never a throw', () => {
    const res = resolveAuditRoute({ AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com' });
    assert.equal(res.available, false);
    assert.match(res.reason, /half-configured/);
  });
});

describe('AUDIT_FORBID_DEGRADED repo policy', () => {
  test('1 → forbidden; anything else → allowed', () => {
    assert.equal(degradedAuditsForbidden({ [FORBID_DEGRADED_VAR]: '1' }), true);
    assert.equal(degradedAuditsForbidden({ [FORBID_DEGRADED_VAR]: '0' }), false);
    assert.equal(degradedAuditsForbidden({}), false);
    const r = new Report();
    checkAuditReadiness({ [FORBID_DEGRADED_VAR]: '1' }, r, REPO, { probeEol: noEol });
    assert.ok(items(r).some((i) => i.label === 'degraded audits: forbidden'));
  });

  test('the prerequisite ladder stops at AUDIT_NOT_RUN under the policy and names ~/.audit-loop.env', () => {
    const ladder = read('docs/audit/shared-references/prerequisite-ladder.md');
    assert.match(ladder, /degraded audits: forbidden/);
    assert.match(ladder, /AUDIT_FORBID_DEGRADED=1/);
    assert.match(ladder, /AUDIT_NOT_RUN — no auditor route \(degraded audits forbidden by repo policy\)/);
    assert.match(ladder, /Do not offer the substitute/);
    assert.ok(ladder.includes(SHARED_ENV_HINT));
    assert.match(ladder, /Do not read, copy or print a `\.env`/);
    assert.doesNotMatch(ladder, /npm run\s+check-setup/, 'no such npm script exists — name the tooling by path');
  });
});

describe('~/.audit-loop.env is named where a worktree flow starts', () => {
  test('the worktree preflight marker names it', () => {
    assert.ok(MARKER_BLOCK.includes('`~/.audit-loop.env`'));
    assert.doesNotMatch(MARKER_BLOCK, /route comes from/, 'the file is one place keys can live, not THE source of the route');
  });
  test('/cycle Step 0 names it and the check-setup route line', () => {
    const step0 = read('skills/cycle/SKILL.md').split('## Step 0 — Parse Input')[1].split('| Input shape')[0];
    assert.ok(step0.includes('~/.audit-loop.env'));
    assert.match(step0, /audit route:/);
    assert.match(step0, /degraded audits: forbidden/);
  });
  test('check-setup runs the readiness section first', () => {
    const src = read('scripts/check-setup.mjs');
    const main = src.slice(src.indexOf('async function main()'));
    assert.ok(main.indexOf('checkAuditReadiness(') > -1);
    assert.ok(main.indexOf('checkAuditReadiness(') < main.indexOf('checkAuditLoop('));
  });
});

describe('CRLF hazard — autocrlf=true AND no repo-wide eol=lf rule', () => {
  test('the pair is a hazard; either half alone is not', () => {
    assert.equal(assessEolHazard({ autocrlf: 'true', gitattributes: null }).hazard, true);
    assert.equal(assessEolHazard({ autocrlf: 'true', gitattributes: '*.sh text eol=lf\n' }).hazard, true, 'per-extension rule is not full');
    assert.equal(assessEolHazard({ autocrlf: 'true', gitattributes: '* text=auto eol=lf\n' }).hazard, false);
    assert.equal(assessEolHazard({ autocrlf: 'input', gitattributes: null }).hazard, false);
    assert.equal(assessEolHazard({ autocrlf: 'yes', gitattributes: null }).hazard, true, 'git bool spellings, not just "true"');
    assert.equal(assessEolHazard({ autocrlf: null, gitattributes: null }).hazard, false);
  });
  test('comments and -text count correctly', () => {
    assert.equal(gitattributesPinsEol('# * text=auto eol=lf\n'), false);
    assert.equal(gitattributesPinsEol('* -text\n'), true);
  });
  test('rules apply in order: a later eol UNSET re-opens the pin; an explicit eol=crlf subset does not', () => {
    assert.equal(gitattributesPinsEol('* text=auto eol=lf\n*.md !eol\n'), false);
    assert.equal(gitattributesPinsEol('* text=auto eol=lf\n*.cmd text eol=crlf\n'), true, 'a deliberate CRLF subset is pinned, not autocrlf');
    assert.equal(gitattributesPinsEol('*.md -eol\n* text=auto eol=lf\n'), true, 'a later repo-wide pin wins');
    assert.equal(gitattributesPinsEol('* text=auto eol=lf\n*.md text\n'), true, 'a later rule naming no eol leaves it set');
  });
  test('probe reads git\'s effective value and the repo-root file; a git failure is "not measured"', () => {
    const run = (args) => {
      if (args[0] === 'rev-parse') return `${REPO}\n`;
      if (args[0] === 'config') return 'true\n';
      throw new Error('unexpected');
    };
    // This repo pins eol=lf, so even autocrlf=true is no hazard here.
    assert.equal(probeEolHazard(REPO, { run }).hazard, false);
    const r = probeEolHazard(REPO, { run: () => { throw new Error('not a repo'); } });
    assert.deepEqual([r.measured, r.hazard], [false, false]);
    const fail = (status) => (args) => {
      if (args[0] === 'rev-parse') return `${REPO}\n`;
      throw Object.assign(new Error('git config failed'), { status });
    };
    assert.equal(probeEolHazard(REPO, { run: fail(1) }).measured, true, 'exit 1 is "unset": measured');
    const broken = probeEolHazard(REPO, { run: fail(128) });
    assert.equal(broken.measured, false, 'any other failure is not measured, never "unset"');
    assert.match(broken.reason, /could not read core\.autocrlf/);
  });
  test('check-setup warns with the fix; hydrate prints the warning and the keys note', () => {
    const r = new Report();
    checkAuditReadiness({ OPENAI_API_KEY: 'x' }, r, REPO, { probeEol: () => ({ measured: true, hazard: true, reason: 'core.autocrlf=true and no .gitattributes' }) });
    const w = items(r).find((i) => i.label === 'line endings: CRLF hazard');
    assert.equal(w?.status, 'WARN');
    assert.match(w.fix, /eol=lf/);
    const notes = hydrationNotes({ action: 'copy' }, { measured: true, hazard: true, reason: 'x' });
    assert.ok(notes.some((n) => /WARN line endings/.test(n)));
    assert.ok(notes.some((n) => n.includes('~/.audit-loop.env') && n.includes('audit route:')));
    assert.deepEqual(hydrationNotes({ action: 'noop' }, { measured: true, hazard: false }), []);
  });
});
