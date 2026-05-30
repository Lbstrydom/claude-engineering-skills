/**
 * @fileoverview Tests for the security-strategy markdown parser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSecurityStrategy } from '../scripts/security-memory/parse-strategy.mjs';

const ONE = `# Security Strategy

## Threat model

We protect customer telemetry. Attackers are drive-by + insiders.

## Incidents

<!-- incident:start id="INC-001" -->
**Description**: Symlink bypass of the path classifier.

**Affected paths**: \`scripts/lib/a.mjs\`, \`scripts/lib/b.mjs\`

**Classification**: CONFIDENTIAL

**Compliance tags**: \`wartsila-security\`, \`wartsila-data\`

**Mitigation**: \`semgrep:symlink-guard\`

**Commit**: \`abc1234def5678\`

**Lessons learned**: Canonicalise before classify.
<!-- incident:end -->
`;

test('parses a full incident with corporate fields', () => {
  const { incidents, threatModel, warnings } = parseSecurityStrategy(ONE);
  assert.equal(warnings.length, 0);
  assert.match(threatModel, /customer telemetry/);
  assert.equal(incidents.length, 1);
  const i = incidents[0];
  assert.equal(i.incident_id, 'INC-001');
  assert.match(i.description, /Symlink bypass/);
  assert.deepEqual(i.affected_paths, ['scripts/lib/a.mjs', 'scripts/lib/b.mjs']);
  assert.equal(i.classification, 'CONFIDENTIAL');
  assert.deepEqual(i.compliance_tags, ['wartsila-security', 'wartsila-data']);
  assert.equal(i.mitigation_ref, 'semgrep:symlink-guard');
  assert.equal(i.mitigation_kind, 'semgrep');
  assert.equal(i.commit_sha, 'abc1234def5678');
  assert.match(i.lessons_learned, /Canonicalise/);
  assert.match(i.source_fingerprint, /^[0-9a-f]{16}$/);
});

test('mitigation_kind derivation', () => {
  const mk = (ref) => parseSecurityStrategy(
    `## Incidents\n<!-- incident:start id="INC-001" -->\n**Description**: x\n**Mitigation**: \`${ref}\`\n<!-- incident:end -->`
  ).incidents[0].mitigation_kind;
  assert.equal(mk('manual'), 'manual');
  assert.equal(mk('semgrep:p/owasp-top-ten'), 'semgrep');
  assert.equal(mk('scripts/lib/check.mjs'), 'file-ref');
});

test('classification is upper-cased and backtick-unwrapped', () => {
  const { incidents } = parseSecurityStrategy(
    `## Incidents\n<!-- incident:start id="INC-001" -->\n**Description**: x\n**Classification**: \`internal\`\n<!-- incident:end -->`
  );
  assert.equal(incidents[0].classification, 'INTERNAL');
});

test('missing description → warning, incident skipped', () => {
  const { incidents, warnings } = parseSecurityStrategy(
    `## Incidents\n<!-- incident:start id="INC-001" -->\n**Affected paths**: \`a\`\n<!-- incident:end -->`
  );
  assert.equal(incidents.length, 0);
  assert.equal(warnings[0].kind, 'missing-description');
});

test('duplicate id → first wins, warning emitted', () => {
  const md = `## Incidents
<!-- incident:start id="INC-001" -->
**Description**: first
<!-- incident:end -->
<!-- incident:start id="INC-001" -->
**Description**: second
<!-- incident:end -->`;
  const { incidents, warnings } = parseSecurityStrategy(md);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].description, 'first');
  assert.equal(warnings.filter(w => w.kind === 'duplicate-id').length, 1);
});

test('placeholder threat model is treated as none', () => {
  const md = `## Threat model\n\n_(no threat model recorded yet — run bootstrap)_\n\n## Incidents\n`;
  assert.equal(parseSecurityStrategy(md).threatModel, null);
});

test('empty / non-string input is safe', () => {
  assert.deepEqual(parseSecurityStrategy(''), { incidents: [], threatModel: null, warnings: [] });
  assert.deepEqual(parseSecurityStrategy(null), { incidents: [], threatModel: null, warnings: [] });
});

test('fingerprint ignores classification/commit changes', () => {
  const base = (cls, commit) =>
    `## Incidents\n<!-- incident:start id="INC-001" -->\n**Description**: same text\n**Classification**: ${cls}\n**Commit**: \`${commit}\`\n<!-- incident:end -->`;
  const a = parseSecurityStrategy(base('INTERNAL', 'aaa')).incidents[0];
  const b = parseSecurityStrategy(base('CONFIDENTIAL', 'bbb')).incidents[0];
  assert.equal(a.source_fingerprint, b.source_fingerprint);
});
