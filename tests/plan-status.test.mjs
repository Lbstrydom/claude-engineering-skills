import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  parsePlanStatus,
  selectAuditPlan,
  PLAN_STATUS_VOCABULARY,
} from '../scripts/lib/plan-status.mjs';

// Contract: docs/plans/reference-integrity-gate.md §2 "The status contract".
// The single source of truth the shell hook must NOT re-implement (R1-H2).

describe('plan-status / parsePlanStatus — grammar', () => {
  const S = (line) => `# Plan: Foo\n\n- **Date**: 2026-01-01\n- **Status**: ${line}\n- **Author**: x\n\nbody`;

  it('no Status line → absent (NOT a failure — 20 real files depend on this)', () => {
    assert.deepEqual(parsePlanStatus('# Plan\n\nno metadata'), { ok: false, reason: 'absent' });
  });

  it('two Status lines → duplicate (never first-wins)', () => {
    const md = '- **Status**: Complete\n- **Status**: Draft\n';
    assert.equal(parsePlanStatus(md).reason, 'duplicate');
  });

  it('non-string → absent', () => {
    assert.equal(parsePlanStatus(null).ok, false);
    assert.equal(parsePlanStatus(123).ok, false);
  });

  it('only the metadata-block Status counts — audit-trail sub-statuses are prose', () => {
    // A real archived plan: one header Status + audit-trail `- **Status**:`
    // narrative lines after the first `## ` heading. The header one wins; the
    // prose ones are not "duplicates".
    const md = [
      '# Plan: Foo',
      '- **Status**: Complete — shipped',
      '- **Author**: x',
      '',
      '## Audit trail',
      '- **Status**: GPT-round audit complete (prose)',
      '- **Status**: plan-audit complete (prose)',
    ].join('\n');
    assert.deepEqual(parsePlanStatus(md), { ok: true, token: 'Complete', kind: 'terminal', raw: 'Complete — shipped' });
  });

  it('two Status lines WITHIN the metadata block → still duplicate', () => {
    const md = '# Plan\n- **Status**: Complete\n- **Status**: Draft\n\n## Body\n';
    assert.equal(parsePlanStatus(md).reason, 'duplicate');
  });
});

describe('plan-status / parsePlanStatus — the leading bullet is optional', () => {
  // The metadata block is conventionally a bullet list, but the corpus has a
  // plan (docs/plans/audit-tool-staleness-check.md) whose Status line is a bare
  // `**Status**: …`. Requiring `- ` made that plan unparseable here while the
  // dashboard's own looser regex still displayed its text — so it rendered
  // under "Active" showing the word "Complete". One contract, one parser.
  it('parses a bare **Status**: line with no bullet', () => {
    const r = parsePlanStatus('# Plan\n**Status**: Complete — shipped 2026-05-13.\n\n## Body\n');
    assert.equal(r.ok, true);
    assert.equal(r.token, 'Complete');
    assert.equal(r.kind, 'terminal');
    assert.equal(r.raw, 'Complete — shipped 2026-05-13.');
  });

  it('and still parses the conventional bulleted form identically', () => {
    const bare = parsePlanStatus('**Status**: Draft\n');
    const bullet = parsePlanStatus('- **Status**: Draft\n');
    assert.deepEqual(bare, bullet);
  });

  it('exposes `raw` whenever a Status line exists — even an unrecognized one', () => {
    // The dashboard's inclusion test is `parsed.raw != null`, so a plan with a
    // malformed status must still be DISCOVERABLE (flagged), never invisible.
    const r = parsePlanStatus('- **Status**: Wibble\n');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unrecognized');
    assert.equal(r.raw, 'Wibble');
  });
});

describe('plan-status / parsePlanStatus — vocabulary', () => {
  const V = (line) => parsePlanStatus(`- **Status**: ${line}\n`);

  it('terminal: Complete, Superseded', () => {
    // `raw` echoes the status text as authored — it is part of the contract
    // (the dashboard renders it instead of re-implementing the regex), so the
    // full return shape is asserted, not just the token.
    assert.deepEqual(V('Complete'), { ok: true, token: 'Complete', kind: 'terminal', raw: 'Complete' });
    assert.deepEqual(V('Superseded'), { ok: true, token: 'Superseded', kind: 'terminal', raw: 'Superseded' });
  });

  it('active: Draft, Approved, In Progress', () => {
    assert.equal(V('Draft').kind, 'active');
    assert.equal(V('Approved').kind, 'active');
    assert.deepEqual(V('In Progress'), { ok: true, token: 'In Progress', kind: 'active', raw: 'In Progress' });
  });

  it('separators: token is a prefix followed by end/space/em-dash/paren/colon/comma/semicolon', () => {
    assert.equal(V('Complete — pending release').token, 'Complete');
    assert.equal(V('**Complete**').token, 'Complete');
    assert.equal(V('Complete (v1)').token, 'Complete');
    assert.equal(V('Complete — shipped as abc123').token, 'Complete');
    assert.equal(V('__Approved__ — 3 rounds').token, 'Approved');
  });

  it('hyphen is NOT a separator: Complete-ish → unrecognized', () => {
    assert.equal(V('Complete-ish').reason, 'unrecognized');
  });

  it('longest-token-first: "In Progress" matches before "In"', () => {
    assert.equal(V('In Progress — halfway').token, 'In Progress');
  });

  it('case-insensitive token match', () => {
    assert.equal(V('COMPLETE').token, 'Complete');
    assert.equal(V('complete').token, 'Complete');
  });

  it('Implemented → rejected, ambiguous, message names both replacements', () => {
    const r = V('Implemented');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'implemented');
    assert.match(r.message, /Complete/);
    assert.match(r.message, /In Progress/);
  });

  it('Phase 1 IMPLEMENTED → rejected (unrecognized or implemented, never active/terminal)', () => {
    assert.equal(V('Phase 1 IMPLEMENTED').ok, false);
  });

  it('"Ready to implement" → unrecognized', () => {
    assert.equal(V('Ready to implement').reason, 'unrecognized');
  });

  it('exports the closed vocabulary', () => {
    assert.ok(Array.isArray(PLAN_STATUS_VOCABULARY.terminal));
    assert.ok(PLAN_STATUS_VOCABULARY.terminal.includes('Complete'));
    assert.ok(PLAN_STATUS_VOCABULARY.active.includes('In Progress'));
  });
});

describe('plan-status / selectAuditPlan', () => {
  let dir, plans;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
    plans = path.join(dir, 'docs', 'plans');
    fs.mkdirSync(plans, { recursive: true });
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
  });
  const write = (name, status, mtimeMs) => {
    const p = path.join(plans, name);
    fs.writeFileSync(p, status === null ? '# Plan\n\nno status\n' : `# Plan\n\n- **Status**: ${status}\n`);
    if (mtimeMs) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  };

  it('selects the sole active plan', () => {
    write('active.md', 'Draft');
    write('done.md', 'Complete');
    assert.equal(path.basename(selectAuditPlan(plans).path ?? selectAuditPlan(plans)), 'active.md');
  });

  it('a Complete plan is NEVER selected (the live bug this fixes)', () => {
    write('done.md', 'Complete');
    const sel = selectAuditPlan(plans);
    assert.equal(sel?.path ?? sel, null);
  });

  it('a Status-less doc is not selectable', () => {
    write('nostatus.md', null);
    const sel = selectAuditPlan(plans);
    assert.equal(sel?.path ?? sel, null);
  });

  it('excludes *-audit-summary.md from selection even with an active-looking status', () => {
    write('foo-audit-summary.md', 'Draft');
    const sel = selectAuditPlan(plans);
    assert.equal(sel?.path ?? sel, null);
  });

  it('a malformed status is skipped, not selected, and never throws', () => {
    write('bad.md', 'Implemented');
    write('good.md', 'Draft');
    const sel = selectAuditPlan(plans);
    assert.equal(path.basename(sel.path ?? sel), 'good.md');
  });

  // CONTRACT CHANGE (2026-07-19): this used to assert ">1 active picks the
  // newest mtime". That heuristic was field-confirmed harmful — it selected a
  // plan unrelated to the push, the audit's A1 guard then aborted with "0
  // implementation files reached the prompt", and the shadow comparison (which
  // the chooser starts in PARALLEL with the legacy promise) still made paid LLM
  // calls and recorded an observation with comparison:null. Refusing to guess
  // is now the contract; the operator binds it explicitly instead.
  it('>1 active with no change signal: refuses to pick by mtime and says why', () => {
    write('a.md', 'Draft', 1000000);
    write('b.md', 'Approved', 2000000); // newer — must NOT win any more
    const warnings = [];
    const sel = selectAuditPlan(plans, { warn: m => warnings.push(m) });
    assert.equal(sel?.path ?? sel, null, 'must not guess when nothing binds the push to a plan');
    assert.ok(warnings.some(w => /mtime/i.test(w) && /AUDIT_PREPUSH_PLAN/.test(w)),
      'must name the refused heuristic and the explicit override');
  });

  it('binds to the active plan changed in this push, ignoring a newer unrelated one', () => {
    write('implemented.md', 'In Progress', 1000000);
    write('unrelated.md', 'Draft', 9000000); // newer — the old mtime winner
    const sel = selectAuditPlan(plans, { changedFiles: ['docs/plans/implemented.md', 'src/thing.mjs'] });
    assert.equal(path.basename(sel.path), 'implemented.md');
    assert.equal(sel.boundBy, 'changed-file');
  });

  it('>1 active plan changed in one push: refuses rather than guessing', () => {
    write('a.md', 'Draft');
    write('b.md', 'Approved');
    const warnings = [];
    const sel = selectAuditPlan(plans, {
      changedFiles: ['docs/plans/a.md', 'docs/plans/b.md'],
      warn: m => warnings.push(m),
    });
    assert.equal(sel?.path ?? sel, null);
    assert.ok(warnings.some(w => /refusing to guess/i.test(w)));
  });

  it('a sole active plan is still selected when the push changed no plan at all', () => {
    write('only.md', 'Draft');
    const sel = selectAuditPlan(plans, { changedFiles: ['src/thing.mjs'] });
    assert.equal(path.basename(sel.path), 'only.md');
    assert.equal(sel.boundBy, 'sole-active-plan', 'one active plan needs no guess');
  });

  it('distinguishes "no change signal" (null) from "this push changed nothing" ([])', () => {
    write('a.md', 'Draft');
    write('b.md', 'Draft');
    // Both must refuse, but neither may throw — the empty list is a real answer,
    // not a missing one, and both land in the >1-active refusal.
    assert.equal(selectAuditPlan(plans, { changedFiles: [] })?.path ?? null, null);
    assert.equal(selectAuditPlan(plans, { changedFiles: undefined })?.path ?? null, null);
  });

  it('matches changed paths regardless of separator or depth', () => {
    write('target.md', 'Draft');
    write('other.md', 'Draft');
    const sel = selectAuditPlan(plans, { changedFiles: ['docs\\plans\\target.md'] });
    assert.equal(path.basename(sel.path), 'target.md', 'a Windows-separator path must still bind');
  });

  it('reports plans whose Status is non-conforming — they are invisible to selection', () => {
    // "no active plan to audit" while silently discarding unreadable candidates
    // is a lie by omission, and it is exactly why a consumer's pre-push audit
    // produced a verdict zero times (2026-07-19).
    write('freetext.md', 'Cluster 1 SHIPPED · Cluster 3 BLOCKED');
    const warnings = [];
    const sel = selectAuditPlan(plans, { warn: m => warnings.push(m) });
    assert.equal(sel?.path ?? sel, null);
    assert.ok(warnings.some(w => /non-conforming Status/.test(w) && /freetext\.md/.test(w)),
      'must name the unreadable plan, not just report nothing to do');
  });

  it('reports unreadable candidates even when a different plan IS selected', () => {
    // The hint must not be conditional on failure — an unreadable plan alongside
    // a selectable one is how you end up auditing the wrong thing and not knowing.
    write('good.md', 'Draft');
    write('freetext.md', 'mostly done I think');
    const warnings = [];
    const sel = selectAuditPlan(plans, { warn: m => warnings.push(m) });
    assert.equal(path.basename(sel.path), 'good.md');
    assert.ok(warnings.some(w => /non-conforming Status/.test(w)), 'hint must fire on the success path too');
  });

  it('a changed *-audit-summary.md never binds (it is not a selectable plan)', () => {
    write('a.md', 'Draft');
    write('b.md', 'Draft');
    const sel = selectAuditPlan(plans, { changedFiles: ['docs/plans/a-audit-summary.md'] });
    assert.equal(sel?.path ?? sel, null, 'summary files are excluded from selection, so they cannot bind');
  });

  it('is shallow — a nested plan is not discovered', () => {
    fs.mkdirSync(path.join(plans, 'security'), { recursive: true });
    fs.writeFileSync(path.join(plans, 'security', 'nested.md'), '# Plan\n\n- **Status**: Draft\n');
    const sel = selectAuditPlan(plans);
    assert.equal(sel?.path ?? sel, null);
  });
});
