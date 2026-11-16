/**
 * Harness retro — the three-things proposal contract, checked against the scan (plan §2 c10–c11).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { checkProposalsAgainstScan, evidenceFor, ProposalSchema, ProposalsEnvelopeSchema } from '../scripts/lib/friction/retro/proposal-schema.mjs';

const SKILL = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'harness-retro', 'SKILL.md'), 'utf8');

/** Every property name the EMITTED schema declares, through unions and nesting. */
function schemaKeys(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node.properties ?? {})) { out.add(k); schemaKeys(v, out); }
  for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) schemaKeys(branch, out);
  if (node.items) schemaKeys(node.items, out);
  return out;
}

describe('SKILL.md ↔ ProposalSchema (the prose↔code seam)', () => {
  const block = SKILL.match(/<!-- harness-retro:proposal-example -->\s*```json\s*([\s\S]*?)```/);
  it('the SKILL.md example is a VALID envelope under the emitted schema', () => {
    assert.ok(block, 'SKILL.md must carry the marked proposal example');
    const parsed = ProposalsEnvelopeSchema.safeParse(JSON.parse(block[1]));
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });
  it('every field the emitted schema declares is named in SKILL.md (no unrepresentable or undocumented field)', () => {
    const keys = schemaKeys(z.toJSONSchema(ProposalsEnvelopeSchema));
    assert.ok(keys.size >= 15, `expected the full key set, got ${[...keys]}`);
    const missing = [...keys].filter((k) => !SKILL.includes(`"${k}"`) && !SKILL.includes(`\`${k}\``));
    assert.deepEqual(missing, []);
  });
});

const A = 'aaaaaaaaaaaaaaaa'; const B = 'bbbbbbbbbbbbbbbb'; const C = 'cccccccccccccccc';
const scan = {
  scanId: '20261116T120000Z-abcdef',
  candidates: [{ fingerprint: A }],
  tripwires: [{ identity: 'tripwire:feedback_m', status: 'promotion-candidate', matchedFingerprints: [B, C] },
    { identity: 'tripwire:feedback_quiet', status: 'no-evidence', matchedFingerprints: [] }],
  sessions: [
    { sessionKey: 's1', counts: { [A]: 2, [B]: 1 } },
    { sessionKey: 's2', counts: { [A]: 1 } },
    { sessionKey: 's3', counts: { [A]: 1, [C]: 1 } },
  ],
};
const propose = (over = {}) => ({
  identity: `fingerprint:${A}`, verdict: 'propose',
  failurePrevented: { summary: 'hooks fail outside the repo root', sessions: 3, occurrences: 4 },
  layer: 'gate', change: { files: ['.claude/settings.json'], description: 'use $CLAUDE_PROJECT_DIR in hook commands' },
  positiveControl: { test: 'tests/hook-paths.test.mjs', assertion: 'a relative hook command fails the test' },
  coordinatorChore: false, ...over,
});
const env = (proposals) => ({ scanId: scan.scanId, proposals });

describe('ProposalSchema', () => {
  it('accepts a complete proposal', () => { assert.ok(checkProposalsAgainstScan(env([propose()]), scan).ok); });
  it('refuses a proposal missing its positive control', () => {
    const { positiveControl, ...rest } = propose();
    const r = checkProposalsAgainstScan(env([rest]), scan);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /positiveControl|Invalid/.test(p)), r.problems.join('\n'));
  });
  it("layer 'agents-md' needs a ladder justification", () => {
    assert.equal(ProposalSchema.safeParse(propose({ layer: 'agents-md' })).success, false);
    assert.equal(ProposalSchema.safeParse(propose({ layer: 'agents-md', ladderJustification: 'no code path performs this action' })).success, true);
  });
  it("'already-covered' must name the covering surface", () => {
    assert.equal(ProposalSchema.safeParse({ identity: `fingerprint:${A}`, verdict: 'already-covered', reason: 'the grep hook already fires' }).success, false);
  });
  it('unknown fields are refused (.strict)', () => {
    assert.equal(ProposalSchema.safeParse({ ...propose(), extra: 1 }).success, false);
  });
});

describe('checked against the scan', () => {
  it('inflated evidence is refused', () => {
    const r = checkProposalsAgainstScan(env([propose({ failurePrevented: { summary: 'hooks fail outside the root', sessions: 9, occurrences: 4 } })]), scan);
    assert.equal(r.ok, false); assert.match(r.problems[0], /claims 9 sessions, scan has 3/);
  });
  it('an identity the scan never ranked is refused', () => {
    assert.equal(checkProposalsAgainstScan(env([propose({ identity: `fingerprint:${C}` })]), scan).ok, false);
    assert.equal(checkProposalsAgainstScan(env([propose({ identity: 'tripwire:feedback_quiet' })]), scan).ok, false);
  });
  it('a tripwire built from two one-off fingerprints is recordable end-to-end', () => {
    const ev = evidenceFor('tripwire:feedback_m', scan);
    assert.deepEqual(ev, { kind: 'tripwire', sessions: 2, occurrences: 2, evidenceFingerprints: [B, C] });
    const r = checkProposalsAgainstScan(env([propose({ identity: 'tripwire:feedback_m', failurePrevented: { summary: 'the tripwire kept firing', sessions: 2, occurrences: 2 } })]), scan);
    assert.ok(r.ok, JSON.stringify(r.problems));
  });
  it('a proposal for another scan is refused', () => {
    assert.equal(checkProposalsAgainstScan({ scanId: 'other', proposals: [propose()] }, scan).ok, false);
  });
});
