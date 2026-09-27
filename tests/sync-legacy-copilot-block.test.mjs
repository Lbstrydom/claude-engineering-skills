/**
 * @fileoverview Consumer sync retires the stale audit-loop block the retired
 * installer merged into `.github/copilot-instructions.md`
 * (lib/sync-legacy-copilot-block.mjs). Tier-3 consumer-sync contract — the
 * sync edits a (usually TRACKED) consumer file, so both the edit and the
 * leave-alone directions are pinned here, in the same commit as the change.
 *
 * The block text below is the retired `COPILOT_BLOCK` verbatim in shape
 * (`git show b7efb9e6^:scripts/lib/install/merge.mjs`), trimmed of its skill list.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  planLegacyCopilotBlockRetirement, describeLegacyCopilotBlockRetirement, retireLegacyCopilotBlock,
  LEGACY_COPILOT_START, LEGACY_COPILOT_END, DOCTOR_CONSUMER_PATH, COPILOT_INSTRUCTIONS_PATH,
} from '../scripts/lib/sync-legacy-copilot-block.mjs';
import { sourceRelToDestRel } from '../scripts/lib/sync-path-map.mjs';

const BLOCK = `${LEGACY_COPILOT_START}
## Engineering Skills Bundle

This repo uses \`claude-engineering-skills\`. Skills available:

- \`/plan\` -- unified architecture + UX planner

## Keeping Skills Current
- Check for updates: \`node .audit-loop/bootstrap.mjs check\`
- Install latest: \`node .audit-loop/bootstrap.mjs install --surface both\`
${LEGACY_COPILOT_END}`;

describe('planLegacyCopilotBlockRetirement', () => {
  it('file holding ONLY the block (installer created it) → delete-file', () => {
    assert.deepEqual(planLegacyCopilotBlockRetirement(`${BLOCK}\n`), { action: 'delete-file' });
  });

  it('operator content before AND after survives; only the block goes', () => {
    const before = '# Our Copilot rules\n\nUse tabs.';
    const after = '## Team notes\nKeep PRs small.\n';
    const plan = planLegacyCopilotBlockRetirement(`${before}\n\n${BLOCK}\n\n${after}`);
    assert.equal(plan.action, 'remove-block');
    assert.equal(plan.content, `${before}\n\n${after}`);
    assert.doesNotMatch(plan.content, /bootstrap\.mjs|audit-loop-bundle/);
  });

  it('appended-at-end shape (mergeBlock appended to an existing file) → prefix kept, one trailing newline', () => {
    const plan = planLegacyCopilotBlockRetirement(`# Rules\n\nBe kind.\n\n${BLOCK}\n`);
    assert.equal(plan.content, '# Rules\n\nBe kind.\n');
  });

  it('preserves CRLF files as CRLF', () => {
    const crlf = `# Rules\r\n\r\n${BLOCK.replace(/\n/g, '\r\n')}\r\n\r\n## After\r\n`;
    const plan = planLegacyCopilotBlockRetirement(crlf);
    assert.equal(plan.content, '# Rules\r\n\r\n## After\r\n');
  });

  it('negative control: no markers → noop; absent file → noop', () => {
    assert.deepEqual(planLegacyCopilotBlockRetirement('# Just ours\n'), { action: 'noop' });
    assert.deepEqual(planLegacyCopilotBlockRetirement(null), { action: 'noop' });
  });

  it('one marker only, or out of order → malformed, never edited', () => {
    assert.equal(planLegacyCopilotBlockRetirement(`x\n${LEGACY_COPILOT_START}\ny\n`).action, 'malformed');
    assert.equal(planLegacyCopilotBlockRetirement(`${LEGACY_COPILOT_END}\n${LEGACY_COPILOT_START}\n`).action, 'malformed');
  });
});

describe('describeLegacyCopilotBlockRetirement — the operator is told where diagnostics live now', () => {
  it('doctor path is DERIVED from the sync path map, not hand-written', () => {
    assert.equal(DOCTOR_CONSUMER_PATH, sourceRelToDestRel('scripts/doctor.mjs'));
    assert.ok(fs.existsSync(path.join(process.cwd(), 'scripts', 'doctor.mjs')), 'the doctor it names must exist in source');
  });

  it('dry-run says "would", a real run says what it did', () => {
    const plan = { action: 'remove-block', content: 'x\n' };
    assert.match(describeLegacyCopilotBlockRetirement(plan, { dryRun: true }), /^would remove/);
    assert.match(describeLegacyCopilotBlockRetirement(plan), /^removed.*node scripts\/\.claude-skills\/doctor\.mjs/);
    assert.equal(describeLegacyCopilotBlockRetirement({ action: 'noop' }), null);
  });
});

describe('retireLegacyCopilotBlock — the sync call site, against a real temp consumer', () => {
  const mkConsumer = (content) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-copilot-'));
    if (content !== null) {
      fs.mkdirSync(path.join(root, '.github'));
      fs.writeFileSync(path.join(root, COPILOT_INSTRUCTIONS_PATH), content);
    }
    return root;
  };
  const read = (root) => fs.readFileSync(path.join(root, COPILOT_INSTRUCTIONS_PATH), 'utf-8');

  it('dry-run reports and writes nothing', () => {
    const original = `# Mine\n\n${BLOCK}\n`;
    const root = mkConsumer(original);
    const lines = retireLegacyCopilotBlock(root, { dryRun: true });
    assert.equal(lines.length, 1);
    assert.equal(read(root), original);
  });

  it('real run removes the block in place and is idempotent on the second run', () => {
    const root = mkConsumer(`# Mine\n\n${BLOCK}\n`);
    assert.equal(retireLegacyCopilotBlock(root).length, 1);
    assert.equal(read(root), '# Mine\n');
    assert.deepEqual(retireLegacyCopilotBlock(root), [], 'second invocation must be a silent noop');
  });

  it('a block-only file is deleted', () => {
    const root = mkConsumer(`${BLOCK}\n`);
    retireLegacyCopilotBlock(root);
    assert.equal(fs.existsSync(path.join(root, COPILOT_INSTRUCTIONS_PATH)), false);
  });

  it('a consumer with no copilot-instructions file is untouched and silent', () => {
    const root = mkConsumer(null);
    assert.deepEqual(retireLegacyCopilotBlock(root), []);
    assert.equal(fs.existsSync(path.join(root, '.github')), false);
  });
});

describe('the dead template is gone and nothing reads it', () => {
  it('scripts/lib/bootstrap-template.mjs no longer exists and build-manifest no longer hashes it', () => {
    assert.equal(fs.existsSync(path.join(process.cwd(), 'scripts', 'lib', 'bootstrap-template.mjs')), false);
    const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'build-manifest.mjs'), 'utf-8');
    assert.doesNotMatch(src, /artifactParts\.push\(`bootstrap:/);
  });
});
