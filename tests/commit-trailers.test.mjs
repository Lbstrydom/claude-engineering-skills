/**
 * @fileoverview Unit tests for the AI-* commit-trailer pure logic
 * (scripts/lib/commit-trailers.mjs). Byte-asserts the pinned AGENT FIX
 * stderr formats (§F1.5 — the format is an API for our own agents), the
 * §F1.3b evidence table, and the §F1.3a message-normalization invariants.
 * CLI/process rows of the §F1.4 taxonomy live in tests/ship-commit-cli.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  canonicaliseModels,
  parseMessageTrailers,
  findReservedTrailers,
  resolveEvidence,
  checkMessageFileSafety,
  validateTrailerInput,
  renderAgentFixLines,
  messageFileError,
  formatTrailerBlock,
  composeFinalMessage,
} from '../scripts/lib/commit-trailers.mjs';

const SKILLS = ['ship', 'audit-code', 'plan'];

function validInput(overrides = {}) {
  return {
    skill: 'ship',
    modelsRaw: 'claude,gpt,gemini',
    gate: 'not-run',
    messageText: 'feat: subject\n\nbody text\n',
    evidence: { state: 'absent', runId: null, ts: null },
    ...overrides,
  };
}

// ---------------------------------------------------------------- grammar

test('models: dedup + lowercase + alphabetical sort (canonical order)', () => {
  const r = canonicaliseModels('GPT,claude,gpt, gemini');
  assert.ok(r.ok);
  assert.deepEqual(r.models, ['claude', 'gemini', 'gpt']);
});

test('models: rejects bad token and empty list', () => {
  assert.equal(canonicaliseModels('Claude GPT').ok, false);  // space inside token
  assert.equal(canonicaliseModels('9model').ok, false);      // must start with letter
  assert.equal(canonicaliseModels('').ok, false);
  assert.ok(canonicaliseModels('glm-4.7,claude').ok);        // dots + dashes legal
});

test('skill: enum from directory names; unknown rejected with sorted list in the message', () => {
  const r = validateTrailerInput(validInput({ skill: 'shipping' }), { skillNames: SKILLS });
  assert.equal(r.ok, false);
  const lines = renderAgentFixLines(r.errors);
  assert.equal(lines.length, 1);
  assert.equal(
    lines[0],
    'AGENT FIX: --skill: expected one of [audit-code|plan|ship] (skills/ directory names); got "shipping". Example: --skill ship',
  );
});

test('gate: enum rejection is the pinned byte format', () => {
  const r = validateTrailerInput(validInput({ gate: 'green' }), { skillNames: SKILLS });
  const lines = renderAgentFixLines(r.errors);
  assert.deepEqual(lines, [
    'AGENT FIX: --gate: expected one of passed|converged|waived|not-run; got "green". Example: --gate passed',
  ]);
});

test('models: normalization makes "Claude, GPT-5" legal (lowercase + trim is silent canonicalization)', () => {
  const r = validateTrailerInput(validInput({ modelsRaw: 'Claude, GPT-5' }), { skillNames: SKILLS });
  assert.ok(r.ok);
  assert.deepEqual(r.values.models, ['claude', 'gpt-5']);
});

test('models: rejection is the pinned byte format', () => {
  const r = validateTrailerInput(validInput({ modelsRaw: 'claude gpt' }), { skillNames: SKILLS });
  const lines = renderAgentFixLines(r.errors);
  assert.deepEqual(lines, [
    'AGENT FIX: --models: expected comma-separated tokens matching ^[a-z][a-z0-9.-]*$; got "claude gpt". Example: --models claude,gpt',
  ]);
});

test('all violations are reported in one pass (agents fix once, not N times)', () => {
  const r = validateTrailerInput(
    validInput({ skill: 'nope', modelsRaw: '!', gate: 'green' }),
    { skillNames: SKILLS },
  );
  assert.equal(r.errors.length, 3);
});

// ------------------------------------------------------- message trailers

test('parseMessageTrailers: last paragraph of Key: value lines is the trailer block', () => {
  const msg = 'feat: x\n\nbody\n\nFixes: #12\nSigned-off-by: A B <a@b.c>\n';
  const { isTrailerBlock, trailers } = parseMessageTrailers(msg);
  assert.ok(isTrailerBlock);
  assert.deepEqual(trailers.map((t) => t.key), ['Fixes', 'Signed-off-by']);
});

test('parseMessageTrailers: subject-only message is not a trailer block', () => {
  assert.equal(parseMessageTrailers('feat: subject only\n').isTrailerBlock, false);
});

test('parseMessageTrailers: key:value-shaped prose mid-body is not a trailer (git semantics — last block only)', () => {
  const msg = 'feat: x\n\nNote: this colon line is prose\n\nfinal body paragraph\n';
  assert.equal(parseMessageTrailers(msg).isTrailerBlock, false);
});

test('reserved AI-* trailer in the trailer block is detected (case-insensitive)', () => {
  const msg = 'feat: x\n\nbody\n\nai-skill: ship\n';
  const hits = findReservedTrailers(msg);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 5);
});

test('an AI-* mention in body prose (not the trailer block) is NOT reserved-rejected', () => {
  const msg = 'docs: explain trailers\n\nThe convention adds AI-Skill: ship to commits.\n\nSee docs for details.\n';
  assert.equal(findReservedTrailers(msg).length, 0);
});

test('reserved-trailer rejection is the pinned byte format', () => {
  const messageText = 'feat: x\n\nbody\n\nAI-Skill: ship\n';
  const r = validateTrailerInput(validInput({ messageText }), { skillNames: SKILLS });
  const lines = renderAgentFixLines(r.errors);
  assert.deepEqual(lines, [
    'AGENT FIX: reserved-trailer: expected no AI-* trailers in the message (the helper is the only writer); got "AI-Skill: ship" at message line 5. Example: remove the line and pass --skill ship',
  ]);
});

// ------------------------------------------------------------- evidence

const EV_PATH = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ev-'));
  return { dir, file: path.join(dir, 'last-audit-run.json') };
};

test('evidence: fresh when ts postdates HEAD commit time', () => {
  const { dir, file } = EV_PATH();
  fs.writeFileSync(file, JSON.stringify({ runId: 'ecae388d-c176-4182-9d27-0210b919b844', ts: '2026-07-14T10:00:00Z' }));
  const ev = resolveEvidence({ auditRunPath: file, headCommitTs: Date.parse('2026-07-14T09:00:00Z') / 1000 });
  assert.equal(ev.state, 'fresh');
  assert.equal(ev.runId, 'ecae388d-c176-4182-9d27-0210b919b844');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('evidence: stale when ts predates HEAD; absent when file missing; opted-out with --no-run-id', () => {
  const { dir, file } = EV_PATH();
  fs.writeFileSync(file, JSON.stringify({ runId: 'ecae388d-c176-4182-9d27-0210b919b844', ts: '2026-06-01T00:00:00Z' }));
  assert.equal(resolveEvidence({ auditRunPath: file, headCommitTs: Date.parse('2026-07-14T00:00:00Z') / 1000 }).state, 'stale');
  assert.equal(resolveEvidence({ auditRunPath: path.join(dir, 'nope.json'), headCommitTs: 0 }).state, 'absent');
  assert.equal(resolveEvidence({ auditRunPath: file, headCommitTs: 0, noRunId: true }).state, 'opted-out');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('evidence: unborn HEAD (T_head=0) makes any parseable evidence fresh (Gemini R2-G1)', () => {
  const { dir, file } = EV_PATH();
  fs.writeFileSync(file, JSON.stringify({ runId: 'ecae388d-c176-4182-9d27-0210b919b844', ts: '2020-01-01T00:00:00Z' }));
  assert.equal(resolveEvidence({ auditRunPath: file, headCommitTs: 0 }).state, 'fresh');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('evidence: non-ENOENT read failure → unreadable with errno, never absent (R2 H2/H5 — fail closed)', () => {
  const boom = (code) => ({ readFileSync() { const e = new Error(code); e.code = code; throw e; } });
  assert.deepEqual(
    resolveEvidence({ auditRunPath: '/x/last-audit-run.json', headCommitTs: 0, fsMod: boom('EACCES') }),
    { state: 'unreadable', runId: null, ts: null, errno: 'EACCES' },
  );
  assert.equal(resolveEvidence({ auditRunPath: '/x/y.json', headCommitTs: 0, fsMod: boom('EISDIR') }).state, 'unreadable');
  // ENOENT stays the expected absent condition
  assert.equal(resolveEvidence({ auditRunPath: '/x/y.json', headCommitTs: 0, fsMod: boom('ENOENT') }).state, 'absent');
  // --no-run-id opts out before any read
  assert.equal(resolveEvidence({ auditRunPath: '/x/y.json', headCommitTs: 0, noRunId: true, fsMod: boom('EACCES') }).state, 'opted-out');
});

test('evidence: malformed JSON / bad runId / missing ts → malformed (row 10 feeds exit 1)', () => {
  const { dir, file } = EV_PATH();
  fs.writeFileSync(file, '{not json');
  assert.equal(resolveEvidence({ auditRunPath: file, headCommitTs: 0 }).state, 'malformed');
  fs.writeFileSync(file, JSON.stringify({ runId: 'short', ts: '2026-07-14T10:00:00Z' }));
  assert.equal(resolveEvidence({ auditRunPath: file, headCommitTs: 0 }).state, 'malformed');
  fs.writeFileSync(file, JSON.stringify({ runId: 'ecae388d-c176-4182-9d27-0210b919b844' }));
  assert.equal(resolveEvidence({ auditRunPath: file, headCommitTs: 0 }).state, 'malformed');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ------------------------------------------------- gate ↔ evidence rules

test('fresh evidence + --gate not-run is rejected with the pinned line', () => {
  const evidence = { state: 'fresh', runId: 'ecae388d-c176-4182-9d27-0210b919b844', ts: '2026-07-14T09:41:00Z' };
  const r = validateTrailerInput(validInput({ gate: 'not-run', evidence }), { skillNames: SKILLS });
  const lines = renderAgentFixLines(r.errors);
  assert.deepEqual(lines, [
    'AGENT FIX: gate-evidence: an audit ran after HEAD (.audit/last-audit-run.json ts 2026-07-14T09:41:00Z) but --gate is "not-run"; pass --gate passed|converged|waived, or --no-run-id --gate not-run if that audit was unrelated. Example: --gate converged',
  ]);
});

test('no fresh evidence + --gate passed is rejected with the pinned line (unevidenced passed cannot exist)', () => {
  const r = validateTrailerInput(validInput({ gate: 'passed' }), { skillNames: SKILLS });
  const lines = renderAgentFixLines(r.errors);
  assert.deepEqual(lines, [
    'AGENT FIX: gate-evidence: no fresh audit evidence exists but --gate is "passed"; only not-run is legal without evidence. Example: --gate not-run',
  ]);
});

test('fresh evidence + passed → ok, runId injected; opted-out + not-run → ok, no runId', () => {
  const evidence = { state: 'fresh', runId: 'ecae388d-c176-4182-9d27-0210b919b844', ts: '2026-07-14T09:41:00Z' };
  const r1 = validateTrailerInput(validInput({ gate: 'passed', evidence }), { skillNames: SKILLS });
  assert.ok(r1.ok);
  assert.equal(r1.values.runId, 'ecae388d-c176-4182-9d27-0210b919b844');
  const r2 = validateTrailerInput(validInput({ gate: 'not-run', evidence: { state: 'opted-out', runId: null, ts: null } }), { skillNames: SKILLS });
  assert.ok(r2.ok);
  assert.equal(r2.values.runId, null);
});

// ------------------------------------ verdict verification (R1 H3/H5 fix)

import { evaluateGateVerification } from '../scripts/lib/commit-trailers.mjs';

// E1 added a THIRD leg to `passed`: the committed tree must equal the audited
// tree. These tests target the store-verdict leg, so they supply a matching
// identity to get past it — otherwise they would silently start asserting the
// identity refusal instead of the verdict refusal they were written for.
// The identity leg itself is covered in tests/gate-evidence-tree-identity.test.mjs.
const AUDITED_TREE = 'a'.repeat(40);
const FRESH = { state: 'fresh', runId: 'ecae388d-c176-4182-9d27-0210b919b844', ts: '2026-07-14T09:41:00Z', auditedTree: AUDITED_TREE, auditedSha: AUDITED_TREE };
const TREE = { committedTree: AUDITED_TREE };

test('gate verification: only fires for the VERIFIED gates + fresh (waived/not-run/stale never verified)', () => {
  assert.equal(evaluateGateVerification({ gate: 'waived', evidence: FRESH, cloudEnabled: false, convergence: null }), null);
  assert.equal(evaluateGateVerification({ gate: 'not-run', evidence: { state: 'absent', runId: null }, cloudEnabled: false, convergence: null }), null);
  assert.equal(evaluateGateVerification({ gate: 'passed', evidence: { state: 'stale', runId: 'x'.repeat(10) }, cloudEnabled: true, convergence: null }), null);
  // `converged` joins the verified set — but is just as inert on stale evidence.
  assert.equal(evaluateGateVerification({ gate: 'converged', evidence: { state: 'stale', runId: 'x'.repeat(10) }, cloudEnabled: true, convergence: null }), null);
});

// ── `converged`: the new accept state ──────────────────────────────────────
// The direction that must FIRE is cheap to get right; the directions that must
// NOT fire are where a false accept hides silently, so they outnumber it here.

const OTHER_TREE = 'b'.repeat(40);
const CONVERGED = { roundConvergedAfter: 2, rounds: 3 };

test('converged: fresh + store-converged + DIFFERING tree → accepted', () => {
  assert.equal(
    evaluateGateVerification({
      gate: 'converged', evidence: FRESH, cloudEnabled: true, convergence: CONVERGED, committedTree: OTHER_TREE,
    }),
    null,
    'the audited-then-remediated ship is exactly what this value is for',
  );
});

test('converged: EQUAL tree → refused, naming passed (the under-claim direction)', () => {
  // Without this the weaker label is grantable whenever the stronger one is
  // earned, and `passed` decays into "whatever the agent happened to type".
  const e = evaluateGateVerification({
    gate: 'converged', evidence: FRESH, cloudEnabled: true, convergence: CONVERGED, ...TREE,
  });
  assert.ok(e, 'converged must be REFUSED when the trees match');
  assert.match(e.custom, /IS what run .* audited/);
  assert.match(e.custom, /--gate passed/, 'the refusal must name the value that is actually earnable');
});

test('converged: run did NOT converge → refused, naming waived (not the sibling gate)', () => {
  const e = evaluateGateVerification({
    gate: 'converged', evidence: FRESH, cloudEnabled: true, convergence: { roundConvergedAfter: null, rounds: 3 }, committedTree: OTHER_TREE,
  });
  assert.ok(e, 'a differing tree alone must never buy the gate — the store verdict is the other half');
  assert.match(e.custom, /"converged" is not available/);
  assert.match(e.custom, /--gate waived/);
});

test('converged: cloud off → refused (same store bar as passed; no cheaper path)', () => {
  const e = evaluateGateVerification({
    gate: 'converged', evidence: FRESH, cloudEnabled: false, convergence: null, committedTree: OTHER_TREE,
  });
  assert.ok(e, 'converged must be exactly as hard to forge as passed');
  assert.match(e.custom, /"converged" requires a verified verdict/);
  assert.match(e.custom, /AUDIT_DB_URL unset/);
});

test('converged: unresolvable comparand → refused (cannot prove difference either)', () => {
  // A gate predicated on the trees DIFFERING is as unprovable as one predicated
  // on their matching when there is nothing to compare. Fail-closed both ways.
  const e = evaluateGateVerification({
    gate: 'converged', evidence: FRESH, cloudEnabled: true, convergence: CONVERGED, committedTree: null,
  });
  assert.ok(e, 'a null comparand must refuse, not default to "well, it differs"');
  assert.match(e.custom, /cannot resolve the tree being committed/);
  assert.match(e.custom, /"converged"/, 'the refusal names the gate that was actually requested');
});

test('converged: no audited-tree identity (pre-E1 marker) → refused', () => {
  const e = evaluateGateVerification({
    gate: 'converged',
    evidence: { ...FRESH, auditedTree: null },
    cloudEnabled: true,
    convergence: CONVERGED,
    committedTree: OTHER_TREE,
  });
  assert.ok(e, 'an evidence-less run cannot support converged any more than passed');
  assert.match(e.custom, /recorded no audited-tree identity/);
});

test('passed: tree mismatch now names converged (the refusal points at the earnable value)', () => {
  const e = evaluateGateVerification({
    gate: 'passed', evidence: FRESH, cloudEnabled: true, convergence: CONVERGED, committedTree: OTHER_TREE,
  });
  assert.ok(e, 'passed is still refused on a delta — the E1 contract is unchanged');
  assert.match(e.custom, /--gate converged/, 'sending the operator to waived here would be telling them to under-claim');
});

test('formatTrailerBlock: AI-Audited-Tree is emitted on passed and NEVER on converged', () => {
  // §2.3: on `converged` the audited tree is a synthetic object that is
  // unreachable from any ref, gc-prunable, and absent from every clone — a
  // provenance line that looks checkable and is not. Asserted rather than
  // assumed, because an omission nothing tests for is an omission that returns.
  const base = { skill: 'ship', models: ['claude'], runId: 'ecae388d-c176-4182-9d27-0210b919b844', auditedTree: AUDITED_TREE };
  assert.ok(
    formatTrailerBlock({ ...base, gate: 'passed' }).some((l) => l.startsWith('AI-Audited-Tree: ')),
    'passed still carries the identity it compared',
  );
  const convergedLines = formatTrailerBlock({ ...base, gate: 'converged' });
  assert.equal(
    convergedLines.some((l) => l.startsWith('AI-Audited-Tree: ')),
    false,
    'converged must never publish an unreachable tree id',
  );
  assert.ok(convergedLines.includes('AI-Gate: converged'));
  assert.ok(convergedLines.includes('AI-Run-ID: ecae388d-c176-4182-9d27-0210b919b844'), 'forensics still resolve via the run id');
});

test('gate verification: cloud off → passed refused with the pinned unavailable line', () => {
  const e = evaluateGateVerification({ gate: 'passed', evidence: FRESH, cloudEnabled: false, convergence: null, ...TREE });
  assert.equal(
    e.custom,
    'AGENT FIX: gate-evidence: "passed" requires a verified verdict for run ecae388d-c176-4182-9d27-0210b919b844 but verification is unavailable (AUDIT_DB_URL unset); use --gate waived (declared, unverified) or fix connectivity. Example: --gate waived',
  );
});

test('gate verification: run not found / query failed → passed refused (fail-closed)', () => {
  const e = evaluateGateVerification({ gate: 'passed', evidence: FRESH, cloudEnabled: true, convergence: null, ...TREE });
  assert.match(e.custom, /verification is unavailable \(run not found in the store, or the query failed\); use --gate waived/);
});

test('gate verification: run recorded but NOT converged → passed refused (the sustained-HIGH scenario)', () => {
  const e = evaluateGateVerification({ gate: 'passed', evidence: FRESH, cloudEnabled: true, convergence: { roundConvergedAfter: null, rounds: 3 }, ...TREE });
  assert.equal(
    e.custom,
    'AGENT FIX: gate-evidence: run ecae388d-c176-4182-9d27-0210b919b844 did not converge (verdict recorded in the store); "passed" is not available — --gate waived declares shipping past the gate. Example: --gate waived',
  );
});

test('gate verification: converged run → passed allowed', () => {
  assert.equal(
    evaluateGateVerification({ gate: 'passed', evidence: FRESH, cloudEnabled: true, convergence: { roundConvergedAfter: 2, rounds: 3 }, ...TREE }),
    null,
  );
});

// -------------------------------------------------- message-file safety

test('message-file safety: in-repo clean file passes; escape/sensitive/missing rejected (Gemini G1)', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-repo-'));
  fs.mkdirSync(path.join(repoRoot, '.claude', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.claude', 'tmp', 'msg.txt'), 'feat: x\n');
  fs.writeFileSync(path.join(repoRoot, '.env'), 'SECRET=1\n');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-out-'));
  fs.writeFileSync(path.join(outside, 'evil.txt'), 'x');

  assert.equal(checkMessageFileSafety('.claude/tmp/msg.txt', { repoRoot }), null);
  assert.equal(checkMessageFileSafety('.env', { repoRoot })?.reason, 'sensitive');
  assert.equal(checkMessageFileSafety(path.join(outside, 'evil.txt'), { repoRoot })?.reason, 'escapes-repo');
  assert.equal(checkMessageFileSafety('.claude/tmp/nope.txt', { repoRoot })?.reason, 'unresolvable');

  fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('messageFileError: pinned formats for missing / containment (rows 6/6b)', () => {
  assert.equal(
    messageFileError('missing', '.claude/tmp/missing.txt').custom,
    'AGENT FIX: --message-file: expected a readable non-empty file; got ".claude/tmp/missing.txt" (ENOENT). Example: --message-file .claude/tmp/ship-commit-msg-1784022000000.txt',
  );
  assert.match(
    messageFileError('escapes-repo', '../../.env').custom,
    /^AGENT FIX: --message-file: must resolve inside the repo and not be a sensitive path; got "\.\.\/\.\.\/\.env" \(escapes-repo\)\./,
  );
});

// ------------------------------------------------------------ rendering

// AI-Audited-Tree (2026-08-04). The gate compares the INDEX tree at ship time
// against the marker's WORKTREE tree from audit time; before this trailer, that
// compared value was persisted NOWHERE. audit_runs.audited_tree holds the
// worktree tree, a DIFFERENT quantity (pinned in gate-evidence-tree-identity:
// "an unstaged edit changes the worktree tree but NOT the index tree"), so a
// historical `passed` could not be re-checked from the record. An audit of the
// two `passed` commits in this repo's history hit exactly that wall: one had a
// stored tree unequal to its committed tree, and the evidence could neither
// convict nor clear it because .audit/last-audit-run.json is transient.
// The trailer makes the claim self-verifying with pure git.
test('formatTrailerBlock: AI-Audited-Tree is emitted on a verified passed', () => {
  const tree = 'b'.repeat(40);
  assert.deepEqual(
    formatTrailerBlock({ skill: 'ship', models: ['claude'], gate: 'passed', runId: 'abc12345', auditedTree: tree }),
    ['AI-Skill: ship', 'AI-Models: claude', 'AI-Gate: passed', 'AI-Run-ID: abc12345', `AI-Audited-Tree: ${tree}`],
  );
});

test('formatTrailerBlock: AI-Audited-Tree is refused on any gate other than passed', () => {
  // The trailer asserts "this tree was checked and matched". Only the accept
  // branch of evaluateGateVerification sets it, but the renderer refuses too:
  // a caller that threads the value through on waived/not-run would otherwise
  // publish an identity claim nothing verified.
  for (const gate of ['waived', 'not-run']) {
    assert.deepEqual(
      formatTrailerBlock({ skill: 'ship', models: ['claude'], gate, runId: 'abc12345', auditedTree: 'c'.repeat(40) }),
      ['AI-Skill: ship', 'AI-Models: claude', `AI-Gate: ${gate}`, 'AI-Run-ID: abc12345'],
    );
  }
});

test('formatTrailerBlock: a malformed oid emits nothing rather than a bogus identity', () => {
  for (const bad of ['', null, undefined, 'not-a-tree', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]) {
    const lines = formatTrailerBlock({ skill: 'ship', models: ['claude'], gate: 'passed', runId: 'abc12345', auditedTree: bad });
    assert.ok(
      !lines.some((l) => l.startsWith('AI-Audited-Tree:')),
      `expected no identity trailer for ${JSON.stringify(bad)}`,
    );
  }
});

test('formatTrailerBlock: the emitted value round-trips through git’s own trailer parser', () => {
  // Capture honesty: the three assertions above only prove the STRING is built.
  // If git does not parse it as a trailer, the whole point — re-checking a
  // historical passed with `git log --format=%(trailers:...)` — silently fails.
  // So assert through git itself, not through our own renderer.
  const tree = 'd'.repeat(40);
  const msg = composeFinalMessage('feat: x\n\nbody', {
    skill: 'ship', models: ['claude'], gate: 'passed', runId: 'abc12345', auditedTree: tree,
  });
  const out = execFileSync('git', ['interpret-trailers', '--parse'], { input: msg, encoding: 'utf-8' });
  assert.match(out, new RegExp(`^AI-Audited-Tree: ${tree}$`, 'm'));
  // Negative control: the same parse must NOT invent the trailer when the
  // renderer withheld it, or the assertion above proves nothing about the gate.
  const withheld = composeFinalMessage('feat: x\n\nbody', {
    skill: 'ship', models: ['claude'], gate: 'waived', runId: 'abc12345', auditedTree: tree,
  });
  const out2 = execFileSync('git', ['interpret-trailers', '--parse'], { input: withheld, encoding: 'utf-8' });
  assert.doesNotMatch(out2, /^AI-Audited-Tree:/m);
});

test('formatTrailerBlock: fixed key order; AI-Run-ID only when present', () => {
  assert.deepEqual(
    formatTrailerBlock({ skill: 'ship', models: ['claude', 'gpt'], gate: 'passed', runId: 'abc12345' }),
    ['AI-Skill: ship', 'AI-Models: claude,gpt', 'AI-Gate: passed', 'AI-Run-ID: abc12345'],
  );
  assert.deepEqual(
    formatTrailerBlock({ skill: 'ship', models: ['claude'], gate: 'not-run', runId: null }),
    ['AI-Skill: ship', 'AI-Models: claude', 'AI-Gate: not-run'],
  );
});

const VALUES = { skill: 'ship', models: ['claude', 'gpt'], gate: 'not-run', runId: null };

test('compose: plain body → exactly one blank line before the AI block, final newline ensured', () => {
  const out = composeFinalMessage('feat: x\n\nbody', VALUES);
  assert.equal(out, 'feat: x\n\nbody\n\nAI-Skill: ship\nAI-Models: claude,gpt\nAI-Gate: not-run\n');
});

test('compose: existing trailer block → AI block joins it (one contiguous block for git)', () => {
  const out = composeFinalMessage('feat: x\n\nbody\n\nFixes: #12\n', VALUES);
  assert.equal(out, 'feat: x\n\nbody\n\nFixes: #12\nAI-Skill: ship\nAI-Models: claude,gpt\nAI-Gate: not-run\n');
});

test('compose: CRLF normalized, trailing whitespace trimmed, no-final-newline input handled', () => {
  const out = composeFinalMessage('feat: x\r\n\r\nbody  ', VALUES);
  assert.equal(out, 'feat: x\n\nbody\n\nAI-Skill: ship\nAI-Models: claude,gpt\nAI-Gate: not-run\n');
});

test('compose: never mutates its input (pure — Gemini G2 is enforced at the CLI seam)', () => {
  const input = 'feat: x\n\nbody\n';
  const copy = `${input}`;
  composeFinalMessage(input, VALUES);
  assert.equal(input, copy);
});
