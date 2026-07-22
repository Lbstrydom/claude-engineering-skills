/**
 * @fileoverview Tier 3 test-first (this repo's non-negotiable sensitive-
 * egress doctrine, AGENTS.md — same commit as the code) for Phase 8 of
 * docs/plans/audit-orchestrator-hardening.md: `buildStageOneTriageInput`
 * (scripts/lib/audit/stage1-triage.mjs) must never let a `.env`-path
 * anchor, a bare sensitive filename embedded in prose, a configured-
 * sensitive `section` path, or a symlink resolving into a sensitive path
 * survive into the `StageOneTriageInputSchema` DTO unredacted.
 *
 * Symlink fixtures mirror the EXISTING pattern in
 * tests/sensitive-paths-canonical.test.mjs exactly (mkdtemp + fs.symlinkSync,
 * POSIX-only — Windows symlink creation needs admin/developer mode).
 *
 * Also covers Phase 9's static check: `buildStageOneTriageInput` must never
 * reference `fullClaim`/`evidenceAlternatives` (the internal-only
 * provenance field Phase 9 adds to `candidate-envelope.mjs`) — the DTO is
 * built from `envelope.canonicalFinding` alone.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStageOneTriageInput } from '../scripts/lib/audit/stage1-triage.mjs';
import { StageOneTriageInputSchema } from '../scripts/lib/schemas.mjs';

const skipOnWin = process.platform === 'win32';

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stage1-dto-'));
}

const VALID_ANCHOR_BASE = {
  diffPathId: 'dp1', fileStatus: 'modified', side: 'head',
  startLine: 1, endLine: 1, headSha: 'WORKTREE',
};

describe('buildStageOneTriageInput — repoRoot contract', () => {
  it('throws when opts.repoRoot is missing (no default, no process.cwd() fallback)', () => {
    assert.throws(() => buildStageOneTriageInput({ category: 'c', detail: 'd', section: 's', severity: 'LOW' }, {}), /repoRoot is required/);
    assert.throws(() => buildStageOneTriageInput({ category: 'c', detail: 'd', section: 's', severity: 'LOW' }, undefined), /repoRoot is required/);
    assert.throws(() => buildStageOneTriageInput({ category: 'c', detail: 'd', section: 's', severity: 'LOW' }, { repoRoot: 123 }), /repoRoot is required/);
  });
});

describe('buildStageOneTriageInput — output always schema-valid', () => {
  // audit-orchestrator-hardening H9: an EMPTY finding ({}, missing
  // severity/category/detail entirely) is no longer silently normalized —
  // it's a signal of an upstream producer bug, not a "safe" input. Throws
  // Error{code:'MALFORMED_FINDING'} so the caller escalates just this
  // candidate rather than treating manufactured defaults as a real triage
  // decision.
  it('throws MALFORMED_FINDING for a completely empty finding, never manufactures defaults', () => {
    const repoRoot = mkdtemp();
    try {
      assert.throws(
        () => buildStageOneTriageInput({}, { repoRoot }),
        (err) => err.code === 'MALFORMED_FINDING'
      );
      assert.throws(
        () => buildStageOneTriageInput(null, { repoRoot }),
        (err) => err.code === 'MALFORMED_FINDING'
      );
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('produces a DTO that parses via StageOneTriageInputSchema for a minimal-but-present finding', () => {
    const repoRoot = mkdtemp();
    try {
      // Has SOME identity (severity present) — a real, if sparse, finding,
      // not an empty/absent one. Missing anchor/causalChain still degrade
      // gracefully to null.
      const dto = buildStageOneTriageInput({ severity: 'HIGH' }, { repoRoot });
      assert.doesNotThrow(() => StageOneTriageInputSchema.parse(dto));
      assert.equal(dto.severity, 'HIGH');
      assert.equal(dto.evidenceStatus, 'missing');
      assert.equal(dto.anchorQuote, null);
      assert.equal(dto.causalChain, null);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('never carries a field outside its schema (only the documented DTO fields)', () => {
    const repoRoot = mkdtemp();
    try {
      const dto = buildStageOneTriageInput({ category: 'c', detail: 'd', section: 's', severity: 'HIGH' }, { repoRoot });
      assert.deepEqual(
        Object.keys(dto).sort(),
        ['anchorQuote', 'category', 'causalChain', 'detail', 'evidenceStatus', 'redacted', 'section', 'severity'].sort(),
      );
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('buildStageOneTriageInput — clamps over-limit fields, never crashes the run (detail>600 regression, 2026-07-22)', () => {
  // A live tiered shadow run failed whole (shadow_ok:false) on a ZodError
  // `too_big` for `detail` (<=600): discovery findings can exceed the cap and
  // the builder did a RAW `.parse`. A single over-long finding must degrade
  // ITSELF (truncated), never abort the batch — mirroring the discovery
  // generators' existing clampToJsonSchemaLimits pattern.
  it('a finding whose detail exceeds the 600-char cap is clamped, not thrown', () => {
    const repoRoot = mkdtemp();
    try {
      const dto = buildStageOneTriageInput(
        { severity: 'MEDIUM', category: 'bug', detail: 'x'.repeat(750), section: 'src/a.mjs:10' },
        { repoRoot },
      );
      assert.equal(dto.detail.length, 600, 'detail truncated to the schema cap, not rejected');
      assert.doesNotThrow(() => StageOneTriageInputSchema.parse(dto));
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('also clamps an over-limit category(80) — the schema-length overflow class in general', () => {
    const repoRoot = mkdtemp();
    try {
      const dto = buildStageOneTriageInput(
        { severity: 'LOW', category: 'c'.repeat(200), detail: 'd', section: 's' },
        { repoRoot },
      );
      assert.equal(dto.category.length, 80);
      assert.doesNotThrow(() => StageOneTriageInputSchema.parse(dto));
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('buildStageOneTriageInput — a .env-path anchor never survives unredacted', () => {
  it('degrades anchorQuote to null when the commission anchor cites a .env file', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = {
        category: 'Hardcoded secret', detail: 'A secret is hardcoded in the env file.', section: 'other-file.mjs:5',
        severity: 'HIGH', evidenceType: 'commission',
        anchor: { ...VALID_ANCHOR_BASE, oldFile: '.env', newFile: '.env', quote: 'SECRET_KEY=abc123xyz' },
      };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.anchorQuote, null, 'the .env-sourced quote must never reach the DTO');
      assert.equal(dto.redacted, true);
      assert.equal(dto.evidenceStatus, 'commission');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('degrades anchorQuote to null when the omission trigger anchor cites a .env file', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = {
        category: 'Missing validation', detail: 'A required check was never added.', section: 'other-file.mjs:9',
        severity: 'MEDIUM', evidenceType: 'omission', causalChain: 'the .env config changed, triggering a validation obligation that was never met',
        triggerAnchor: { ...VALID_ANCHOR_BASE, oldFile: '.env', newFile: '.env', quote: 'DB_PASSWORD=hunter2' },
      };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.anchorQuote, null, 'the .env-sourced trigger quote must never reach the DTO');
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('buildStageOneTriageInput — a bare sensitive filename embedded in prose is redacted', () => {
  it('redacts a bare "id_rsa" mention in detail (extension-less, slash-less — no shape pre-filter)', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = {
        category: 'Hardcoded key', detail: 'Hardcoded key found in id_rsa near the top of the file.', section: 'x.mjs:1',
        severity: 'HIGH',
      };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('id_rsa'), false, 'the bare sensitive filename must not survive in prose');
      assert.match(dto.detail, /\[REDACTED\]/);
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('redacts a path-shaped mention (e.g. "secrets/db.yaml") inside category text', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = {
        category: 'Reference to secrets/db.yaml found', detail: 'benign detail', section: 'x.mjs:1', severity: 'LOW',
      };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.category.includes('secrets/db.yaml'), false);
      assert.match(dto.category, /\[REDACTED\]/);
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('buildStageOneTriageInput — a configured-sensitive path in `section` is redacted', () => {
  it('redacts section when its file portion matches a sensitive directory pattern', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'd', section: 'secrets/db.yaml:12', severity: 'MEDIUM' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.section, '[REDACTED]');
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('leaves an ordinary, non-sensitive, REAL (resolvable) section untouched', () => {
    // resolveAndClassify fails closed on an unresolvable path (ENOENT) — by
    // design (see sensitive-paths-canonical.test.mjs's own "resolutionFailed"
    // coverage: "we cannot read what we cannot resolve"). So this fixture
    // creates the actual file, matching the production reality that a
    // finding's cited section is a real repo file.
    const repoRoot = mkdtemp();
    try {
      fs.mkdirSync(path.join(repoRoot, 'src'));
      fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), '');
      const finding = { category: 'c', detail: 'd', section: 'src/index.ts:42', severity: 'LOW' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.section, 'src/index.ts:42');
      assert.equal(dto.redacted, false);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('an unresolvable (nonexistent) section fails closed to sensitive, per resolveAndClassify\'s own documented contract', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'd', section: 'src/does-not-exist.ts:1', severity: 'LOW' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.section, '[REDACTED]');
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('buildStageOneTriageInput — symlink resolving into a sensitive path is redacted (WS-CANON)', () => {
  it('redacts section when its lexically-innocent name resolves (via symlink) into secrets/ INSIDE the repo', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    try {
      const secretsDir = path.join(repoRoot, 'secrets');
      fs.mkdirSync(secretsDir);
      const realTarget = path.join(secretsDir, 'db.yaml');
      fs.writeFileSync(realTarget, '');
      fs.symlinkSync(realTarget, path.join(repoRoot, 'innocent.ts'));

      const finding = { category: 'c', detail: 'd', section: 'innocent.ts:3', severity: 'MEDIUM' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.section, '[REDACTED]', 'canonical target inside secrets/ must classify sensitive even though the visible name is innocent');
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('redacts an evidence anchor whose file is a symlink escaping the repo root', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    const outside = mkdtemp();
    try {
      const target = path.join(outside, 'secret-target.txt');
      fs.writeFileSync(target, 'pretend-secret');
      fs.symlinkSync(target, path.join(repoRoot, 'notes.ts'));

      const finding = {
        category: 'c', detail: 'd', section: 'other.mjs:1', severity: 'HIGH', evidenceType: 'commission',
        anchor: { ...VALID_ANCHOR_BASE, oldFile: 'notes.ts', newFile: 'notes.ts', quote: 'irrelevant quote text' },
      };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.anchorQuote, null, 'a symlink escaping the repo root must fail-closed to sensitive');
      assert.equal(dto.redacted, true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('buildStageOneTriageInput — a symlinked-to-sensitive path MENTIONED IN FREE-TEXT is redacted (audit-code round-1 H1/H3)', () => {
  // The block above covers STRUCTURED path fields (section, anchor.newFile),
  // which already went through resolveAndClassify before this fix. This
  // block covers the gap those tests did NOT reach: a path-shaped token
  // embedded in ordinary prose (category/detail/anchorQuote/causalChain),
  // which previously only got a lexical classifyPath check.
  it('redacts a lexically-innocent path mentioned in `detail` prose that resolves via symlink into secrets/', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    try {
      const secretsDir = path.join(repoRoot, 'secrets');
      fs.mkdirSync(secretsDir);
      const realTarget = path.join(secretsDir, 'db.yaml');
      fs.writeFileSync(realTarget, 'password: hunter2');
      fs.symlinkSync(realTarget, path.join(repoRoot, 'notes.txt'));

      const finding = { category: 'c', detail: 'See notes.txt for the full context of this bug.', section: 'other.mjs:1', severity: 'MEDIUM' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('notes.txt'), false, 'the symlinked mention must not survive unredacted');
      assert.ok(dto.detail.includes('[REDACTED]'), dto.detail);
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('redacts a symlinked-to-sensitive path mentioned in `category` prose too (every free-text field, not just detail)', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    try {
      const secretsDir = path.join(repoRoot, 'secrets');
      fs.mkdirSync(secretsDir);
      const realTarget = path.join(secretsDir, 'creds.yaml');
      fs.writeFileSync(realTarget, '');
      fs.symlinkSync(realTarget, path.join(repoRoot, 'config.txt'));

      const finding = { category: 'Relates to config.txt', detail: 'd', section: 'other.mjs:1', severity: 'LOW' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.category.includes('config.txt'), false);
      assert.ok(dto.category.includes('[REDACTED]'), dto.category);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('redacts a symlink-escaping-the-repo-root path mentioned in an anchorQuote (fail-safe)', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    const outside = mkdtemp();
    try {
      const target = path.join(outside, 'outside-secret.txt');
      fs.writeFileSync(target, 'pretend-secret');
      fs.symlinkSync(target, path.join(repoRoot, 'escape.txt'));

      const finding = {
        category: 'c', detail: 'd', section: 'other.mjs:1', severity: 'HIGH', evidenceType: 'commission',
        anchor: { ...VALID_ANCHOR_BASE, oldFile: 'unrelated.ts', newFile: 'unrelated.ts', quote: 'Mentioned in escape.txt, see there.' },
      };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.anchorQuote.includes('escape.txt'), false);
      assert.ok(dto.anchorQuote.includes('[REDACTED]'), dto.anchorQuote);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('does NOT mass-redact ordinary prose (the false-positive risk a naive resolveAndClassify swap would cause)', () => {
    const repoRoot = mkdtemp();
    try {
      // section is deliberately OMITTED — a non-existent `section` file
      // fail-closes via the PRE-EXISTING, correct, unrelated resolveAndClassify
      // check for structured path fields (not this test's concern; isolating
      // it here so this test only exercises the free-text detail/category path).
      const finding = {
        category: 'Correctness', severity: 'MEDIUM',
        detail: 'The function returns early when the input array is empty, causing downstream consumers to receive undefined instead of a default value. This affects the retry loop and the cache invalidation path.',
      };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('[REDACTED]'), false, 'ordinary English words must never be treated as sensitive paths');
      assert.equal(dto.category.includes('[REDACTED]'), false);
      assert.equal(dto.redacted, false);
      assert.ok(dto.detail.includes('function returns early'));
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a real, existing, but NON-sensitive file mentioned in prose is left unredacted (only sensitive canonical targets trigger)', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    try {
      fs.writeFileSync(path.join(repoRoot, 'helper.mjs'), 'export const x = 1;');
      const finding = { category: 'c', detail: 'See helper.mjs for the utility function.', section: 'other.mjs:1', severity: 'LOW' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.ok(dto.detail.includes('helper.mjs'), 'a real, non-sensitive file mention must survive');
      assert.equal(dto.redacted, false);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('buildStageOneTriageInput — source-location suffix + dotfile classification (audit-code round-2 H1)', () => {
  it('redacts a ".env:12"-style source-location citation in detail', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'The leak is at .env:12 in this repo.', severity: 'MEDIUM' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('.env:12'), false);
      assert.ok(dto.detail.includes('[REDACTED]'), dto.detail);
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('redacts a ".env:12:4"-style line:col citation', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'See .env:12:4 for the value.', severity: 'MEDIUM' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('.env:12:4'), false);
      assert.ok(dto.detail.includes('[REDACTED]'));
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('redacts a BARE ".env" mention in prose (the deeper pre-existing gap this fix root-caused: leading-dot stripping broke dotfile classification entirely, not just the :line suffix case)', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'Check .env for the configuration.', severity: 'MEDIUM' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('.env '), false);
      assert.ok(dto.detail.includes('[REDACTED]'), dto.detail);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a dotfile mention with a trailing sentence period (".env.") is still correctly redacted (trailing-strip regression guard)', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'Check .env. Also see the code.', severity: 'MEDIUM' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('.env.'), false);
      assert.ok(dto.detail.includes('[REDACTED]'), dto.detail);
      assert.ok(dto.detail.includes('Also see the code'), 'the rest of the sentence must survive');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a leading comma/colon before an ordinary word is still stripped correctly (leading-strip regression guard, non-dot punctuation unaffected)', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'Fixed in commit abc123, see the diff.', severity: 'LOW' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.redacted, false);
      assert.ok(dto.detail.includes('commit abc123'));
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('isSensitiveViaSymlinkResolution — resolution-failure classification (audit-code round-2 H2)', () => {
  it('a symlink cycle (ELOOP) fails closed to sensitive, not benign', () => {
    if (skipOnWin) return;
    const repoRoot = mkdtemp();
    try {
      const linkA = path.join(repoRoot, 'cycleA');
      const linkB = path.join(repoRoot, 'cycleB');
      fs.symlinkSync(linkB, linkA);
      fs.symlinkSync(linkA, linkB);
      const finding = { category: 'c', detail: 'See cycleA for details.', severity: 'LOW' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('cycleA'), false, 'an unresolvable symlink cycle must fail-closed, not be treated as an ordinary word');
      assert.ok(dto.detail.includes('[REDACTED]'), dto.detail);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('a genuinely non-existent path (ENOENT) is still treated as benign — the fix must not fail-close ordinary words', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'The variable named nonexistentToken123 is unused.', severity: 'LOW' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.redacted, false);
      assert.ok(dto.detail.includes('nonexistentToken123'));
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('buildStageOneTriageInput — markup-wrapper and URL-fragment bypasses (audit-code round-4 H1/H2)', () => {
  it('redacts a bold-markup-wrapped dotfile mention ("**.env**")', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'The secret leaked via **.env** in the log line.', severity: 'HIGH' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('.env'), false, dto.detail);
      assert.ok(dto.detail.includes('[REDACTED]'), dto.detail);
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('redacts an angle-bracket-wrapped dotfile mention ("<.env>")', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'See <.env> for the value that leaked.', severity: 'HIGH' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('.env'), false, dto.detail);
      assert.ok(dto.detail.includes('[REDACTED]'), dto.detail);
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('redacts a URL-fragment-suffixed dotfile citation (".env#L12")', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'The leak is cited at .env#L12 in the report.', severity: 'HIGH' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('.env#L12'), false, dto.detail);
      assert.ok(dto.detail.includes('[REDACTED]'), dto.detail);
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('an ordinary bold-markup word survives unredacted (leading/trailing "*" strip does not over-match)', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'This is **important** context.', severity: 'LOW' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.redacted, false);
      assert.ok(dto.detail.includes('important'));
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('redacts a GitHub-style hyphenated line-range fragment (".env#L12-L15", audit-code round-5 H1)', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'The leak is cited at .env#L12-L15 in the report.', severity: 'HIGH' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.detail.includes('.env#L12-L15'), false, dto.detail);
      assert.ok(dto.detail.includes('[REDACTED]'), dto.detail);
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('an ordinary hashtag mention (no leading dot) survives unredacted (fragment-class widening does not over-match)', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = { category: 'c', detail: 'Ordinary text with a #hashtag mention.', severity: 'LOW' };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.redacted, false);
      assert.ok(dto.detail.includes('#hashtag'));
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('buildStageOneTriageInput — secret-shaped content is redacted independently of path classification', () => {
  it('redacts a hardcoded-secret-shaped anchorQuote even when its source file is NOT itself sensitive', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = {
        category: 'Hardcoded credential', detail: 'benign detail text', section: 'src/config.mjs:10',
        severity: 'HIGH', evidenceType: 'commission',
        anchor: { ...VALID_ANCHOR_BASE, oldFile: 'src/config.mjs', newFile: 'src/config.mjs', quote: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ' },
      };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      // The quote is secret-SHAPED (an OpenAI-style key), not path-shaped —
      // this must be caught by redactSecrets, not the path-mention scanner.
      assert.notEqual(dto.anchorQuote, 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ');
      assert.equal(dto.redacted, true);
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

describe('buildStageOneTriageInput — closed enums pass through unredacted', () => {
  it('never redacts severity or evidenceStatus', () => {
    const repoRoot = mkdtemp();
    try {
      const finding = {
        category: 'c', detail: 'd', section: 'x.mjs:1', severity: 'HIGH', evidenceType: 'commission',
        anchor: { ...VALID_ANCHOR_BASE, oldFile: 'x.mjs', newFile: 'x.mjs', quote: 'benign quote' },
      };
      const dto = buildStageOneTriageInput(finding, { repoRoot });
      assert.equal(dto.severity, 'HIGH');
      assert.equal(dto.evidenceStatus, 'commission');
    } finally { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 9 static check — buildStageOneTriageInput must never reference
// fullClaim/evidenceAlternatives (the DTO is built from
// envelope.canonicalFinding alone; Phase 9's provenance widening on
// evidenceAlternatives must never leak into Phase 8's narrowing).
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 9 — DTO boundary independence (static check)', () => {
  it('stage1-triage.mjs never references fullClaim or evidenceAlternatives', () => {
    const src = fs.readFileSync(path.resolve('scripts/lib/audit/stage1-triage.mjs'), 'utf-8');
    assert.equal(src.includes('fullClaim'), false);
    assert.equal(src.includes('evidenceAlternatives'), false);
  });
});
