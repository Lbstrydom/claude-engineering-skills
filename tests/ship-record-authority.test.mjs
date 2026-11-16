/**
 * @fileoverview What a RECORD commit may contain (scripts/lib/ship-record/authority.mjs) — and that ship-commit enforces it.
 * Plan: docs/plans/ship-record-catchup.md §2.6. Both directions: what must pass, and each thing that must refuse with its
 * own reason. The decision is a declaration; the path check is the safety, so it is tested independently of it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateRecordCommit, planChangeIsRecordOnly } from '../scripts/lib/ship-record/authority.mjs';
import { renderInitReadme } from '../scripts/lib/ship-record/entry.mjs';
import { formatTrailerBlock, AI_TRAILER_KEYS } from '../scripts/lib/commit-trailers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINE = '- 2026-11-16: merged #5 (abababababab) — recorded by ship-record catch-up <!-- ship-record pr=5 -->';
const DEC = { ok: true, decision: { id: 'dec-20261116000000-abcd', scope: 'record-catchup' } };
const entry = (rel, text = '## 2026-11-16 — x\n', extra = {}) => ({ rel, atHead: 'absent', kind: 'regular', oldText: null, newText: text, ...extra });
const good = (paths, extra = {}) => evaluateRecordCommit({ gate: 'not-run', flags: {}, decision: DEC, paths, ...extra });
const reasonOf = (v, id) => v.conditions.find((c) => c.id === id).reason;

describe('planChangeIsRecordOnly', () => {
  const plan = '# P\n\n## Implementation Log\n- old\n\n## Out of Scope\n- y\n';
  it('accepts a suggestion line inserted inside a log that is NOT the last section', () => {
    assert.deepEqual(planChangeIsRecordOnly(plan, plan.replace('- old\n', `- old\n${LINE}\n`)), { ok: true, inserted: 1 });
  });
  it('accepts the section created at EOF when absent', () => {
    assert.equal(planChangeIsRecordOnly('# P\n', `# P\n\n## Implementation Log\n${LINE}\n`).ok, true);
  });
  it('refuses a modified line, a non-suggestion insertion, and a line outside the section', () => {
    assert.match(planChangeIsRecordOnly(plan, plan.replace('- old', '- edited')).reason, /changed or removed/);
    assert.match(planChangeIsRecordOnly(plan, plan.replace('- old\n', '- old\n- my own note\n')).reason, /not a ship-record/);
    assert.match(planChangeIsRecordOnly(plan, plan.replace('- y\n', `- y\n${LINE}\n`)).reason, /outside/);
    assert.match(planChangeIsRecordOnly(plan, plan).reason, /unchanged/);
  });
  it('folds CRLF (autocrlf checkouts)', () => {
    assert.equal(planChangeIsRecordOnly(plan.replace(/\n/g, '\r\n'), plan.replace('- old\n', `- old\n${LINE}\n`)).ok, true);
  });
});

describe('evaluateRecordCommit', () => {
  it('passes new entries, the canonical marker and a record-only plan insertion', () => {
    const v = good([
      entry('docs/status/entries/2026-11-16-091244-pr-5.md'),
      entry('docs/status/entries/README.md', renderInitReadme().replace(/\n/g, '\r\n')),
      { rel: 'docs/plans/p.md', atHead: 'blob', kind: 'regular', oldText: '# P\n\n## Implementation Log\n', newText: `# P\n\n## Implementation Log\n${LINE}\n` },
    ]);
    assert.equal(v.ok, true, v.refusals.join('\n'));
  });
  it('refuses each non-record change with its own reason', () => {
    const cases = [
      [entry('scripts/x.mjs'), /outside the record allowlist/],
      [entry('docs/status/entries/2026-11-16-091244-pr-5.md', '## a\n', { atHead: 'blob' }), /immutable/],
      [entry('docs/status/entries/README.md', 'not the marker'), /differs from the marker/],
      [entry('docs/status/entries/notes.md'), /does not match/],
      [entry('docs/status/entries/2026-11-16-091244-pr-5.md', '## a\n## b\n'), /2 "## " headings/],
      [entry('docs/status/entries/2026-11-16-091244-pr-5.md', null, { kind: 'symlink' }), /not a regular file/],
      [entry('docs/status/entries/2026-11-16-091244-pr-5.md', null, { kind: 'missing' }), /deleted/],
      [{ rel: 'docs/plans/new.md', atHead: 'absent', kind: 'regular', newText: LINE }, /not an existing plan/],
    ];
    for (const [p, re] of cases) {
      const v = good([p]);
      assert.equal(v.ok, false, p.rel);
      assert.match(reasonOf(v, 'paths'), re);
    }
  });
  it('refuses an empty set, a non-not-run gate, conflicting flags and an inactive decision', () => {
    assert.match(reasonOf(good([]), 'paths'), /empty record/);
    assert.match(reasonOf(good([entry('docs/status/entries/2026-11-16-091244-pr-5.md')], { gate: 'converged' }), 'gate'), /not-run/);
    assert.match(reasonOf(good([entry('docs/status/entries/2026-11-16-091244-pr-5.md')], { flags: { preauthorised: true } }), 'flags'), /preauthorised/);
    assert.match(reasonOf(good([entry('docs/status/entries/2026-11-16-091244-pr-5.md')], { decision: { ok: false, reason: 'revoked' } }), 'decision'), /revoked/);
  });
  it('the path check fires even with a valid decision (the decision is not the safety)', () => {
    assert.equal(good([entry('scripts/x.mjs')]).ok, false);
  });
});

describe('trailers', () => {
  it('renders record-catchup only with a well-formed decision id, and AI-Decision is a reserved key', () => {
    const base = { skill: 'ship', models: ['claude'], gate: 'not-run' };
    assert.deepEqual(formatTrailerBlock({ ...base, shipAuthority: 'record-catchup', decision: 'dec-20261116000000-abcd' }).slice(-2), ['AI-Ship-Authority: record-catchup', 'AI-Decision: dec-20261116000000-abcd']);
    assert.ok(!formatTrailerBlock({ ...base, shipAuthority: 'record-catchup', decision: 'bogus' }).some((l) => l.startsWith('AI-Ship-Authority')));
    assert.ok(AI_TRAILER_KEYS.includes('AI-Decision'));
  });
});

describe('ship-commit --record (integration)', () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', CLAUDE_BACKEND: 'sdk', AUDIT_DB_URL: '' };
  const run = (cwd, cmd, args, input) => spawnSync(cmd, args, { cwd, input, encoding: 'utf8', env });
  it('commits a record with its authority trailers, and refuses a code path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-record-commit-'));
    run(dir, 'git', ['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(dir, 'skills/ship'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills/ship/SKILL.md'), '---\nname: ship\ndescription: x\n---\n');
    run(dir, 'git', ['add', '-A']); run(dir, 'git', ['commit', '-q', '-m', 'init']);
    const fleet = path.join(ROOT, 'scripts/fleet.mjs');
    assert.equal(run(dir, process.execPath, [fleet, 'decision', 'record', '--scope', 'record-catchup', '--words-file', '-'], 'Commit docs-only records.\n').status, 0);
    const dec = JSON.parse(run(dir, process.execPath, [fleet, 'decision', 'list', '--json']).stdout).decisions[0].id;
    fs.mkdirSync(path.join(dir, 'docs/status/entries'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/status/entries/2026-11-16-091244-pr-5.md'), '## 2026-11-16 — #5 x\n');
    fs.writeFileSync(path.join(dir, 'evil.mjs'), 'x');
    const head = run(dir, 'git', ['rev-parse', 'HEAD']).stdout.trim();
    const sc = path.join(ROOT, 'scripts/ship-commit.mjs');
    const common = ['--record', '--decision', dec, '--message-file', '-', '--skill', 'ship', '--models', 'claude', '--gate', 'not-run', '--no-run-id', '--expect-head', head, '--expect-branch', 'main'];
    const bad = run(dir, process.execPath, [sc, ...common, '--path', 'evil.mjs'], 'x\n');
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /REFUSED paths\s+evil\.mjs/);
    const okRun = run(dir, process.execPath, [sc, ...common, '--path', 'docs/status/entries/2026-11-16-091244-pr-5.md'], 'docs(status): record\n');
    assert.equal(okRun.status, 0, okRun.stderr);
    const msg = run(dir, 'git', ['log', '-1', '--format=%B']).stdout;
    assert.match(msg, /AI-Ship-Authority: record-catchup\nAI-Decision: dec-/);
    assert.equal(run(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']).stdout.trim(), 'docs/status/entries/2026-11-16-091244-pr-5.md');
  });
});
