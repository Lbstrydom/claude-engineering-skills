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
  // Audit H14 (2026-09-27): wholesale whitespace trimming rewrote consumer
  // bytes adjacent to the block — here an indented Markdown code block (whose
  // meaning IS its leading spaces) and trailing blank lines of the consumer's.
  it('consumer bytes adjacent to the block are preserved exactly (indented code block)', () => {
    const before = '# Rules\n\n    npm run lint   # indented = code block\n\n';
    const after = '\n\n    keep this indent\n\n\n';
    const plan = planLegacyCopilotBlockRetirement(`${before}${BLOCK}\n${after}`);
    assert.equal(plan.action, 'remove-block');
    // Only the installer's own separator line (one EOL before the block) and the
    // block's terminating EOL are removed.
    assert.equal(plan.content, `${before.slice(0, -1)}${after}`);
  });

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

describe('R2 hardening — ambiguity, symlinks, non-UTF-8 bytes', () => {
  it('two marker pairs are ambiguous → malformed, untouched (R2 H6)', () => {
    const plan = planLegacyCopilotBlockRetirement(`# A\n\n${BLOCK}\n\n# B\n\n${BLOCK}\n`);
    assert.equal(plan.action, 'malformed');
  });

  it('bytes outside the block survive even when not valid UTF-8 (R2 H4)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-copilot-bytes-'));
    try {
      const dir = path.join(root, '.github');
      fs.mkdirSync(dir, { recursive: true });
      // "# " + invalid UTF-8 (ff fe 80) + "\n\n" (the installer's separator)
      const prefix = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x80, 0x0a, 0x0a]);
      fs.writeFileSync(path.join(dir, 'copilot-instructions.md'), Buffer.concat([prefix, Buffer.from(`${BLOCK}\n`)]));
      retireLegacyCopilotBlock(root);
      const out = fs.readFileSync(path.join(dir, 'copilot-instructions.md'));
      assert.deepEqual([...out], [0x23, 0x20, 0xff, 0xfe, 0x80, 0x0a]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a symlinked copilot-instructions.md is refused, target untouched (R2 H3/M6)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-copilot-link-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-copilot-outside-'));
    try {
      const target = path.join(outside, 'victim.md');
      fs.writeFileSync(target, `${BLOCK}\n`);
      fs.mkdirSync(path.join(root, '.github'), { recursive: true });
      try {
        fs.symlinkSync(target, path.join(root, '.github', 'copilot-instructions.md'), 'file');
      } catch (err) {
        t.skip(`symlink creation unavailable here (${err.code})`);
        return;
      }
      const lines = retireLegacyCopilotBlock(root);
      assert.match(lines.join('\n'), /left untouched/);
      assert.equal(fs.readFileSync(target, 'utf8'), `${BLOCK}\n`, 'the outside file must not be modified');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});


describe('R3 — markers alone do not prove ownership', () => {
  it('a marker pair around consumer text without the retired payload is left untouched', () => {
    const quoted = `${LEGACY_COPILOT_START}\nOur own notes about the old bundle.\n${LEGACY_COPILOT_END}`;
    assert.equal(planLegacyCopilotBlockRetirement(`# Docs\n\n${quoted}\n`).action, 'malformed');
  });
});

describe('R4 — ownership is the installer structure, not a substring', () => {
  it('a consumer example quoting markers + the bootstrap path inline is left untouched', () => {
    const example = `Example: ${LEGACY_COPILOT_START} run node .audit-loop/bootstrap.mjs check ${LEGACY_COPILOT_END}`;
    assert.equal(planLegacyCopilotBlockRetirement(`# Docs\n\n${example}\n`).action, 'malformed');
  });
  it('markers on their own lines around consumer text mentioning the path are left untouched', () => {
    const quoted = `${LEGACY_COPILOT_START}\nWe used to run node .audit-loop/bootstrap.mjs here.\n${LEGACY_COPILOT_END}`;
    assert.equal(planLegacyCopilotBlockRetirement(`# Docs\n\n${quoted}\n`).action, 'malformed');
  });
  it('control: the real installer block (CRLF too) is still recognised', () => {
    assert.equal(planLegacyCopilotBlockRetirement(`# A\r\n\r\n${BLOCK.replace(/\n/g, '\r\n')}\r\n`).action, 'remove-block');
  });
});

describe('R5 — a fenced example of the real block is the consumer\'s', () => {
  it('the historical block quoted inside a ``` fence is left untouched', () => {
    const fenced = '# How we used to install\n\n```md\n' + BLOCK + '\n```\n';
    assert.equal(planLegacyCopilotBlockRetirement(fenced).action, 'malformed');
  });
  it('control: a real block AFTER a closed fence is still recognised', () => {
    const doc = '# Notes\n\n```sh\nnpm test\n```\n\n' + BLOCK + '\n';
    assert.equal(planLegacyCopilotBlockRetirement(doc).action, 'remove-block');
  });
});

describe('R6 — CommonMark fence tracking and exact-empty deletion', () => {
  it('~~~ inside a backtick fence does not close it: the block stays an example', () => {
    const doc = '```md\n~~~\n' + BLOCK + '\n```\n';
    assert.equal(planLegacyCopilotBlockRetirement(doc).action, 'malformed');
  });
  it('``` inside a ```` fence does not close it: the block stays an example', () => {
    const doc = '````md\n```\n' + BLOCK + '\n````\n';
    assert.equal(planLegacyCopilotBlockRetirement(doc).action, 'malformed');
  });
  it('control: a block after a properly closed ```` fence is removed', () => {
    const doc = '````md\n```\nx\n````\n\n' + BLOCK + '\n';
    assert.equal(planLegacyCopilotBlockRetirement(doc).action, 'remove-block');
  });
  it('consumer whitespace outside the span keeps the file (no delete)', () => {
    const plan = planLegacyCopilotBlockRetirement('  \n\n' + BLOCK + '\n');
    assert.equal(plan.action, 'remove-block');
    assert.equal(plan.content, '  \n');
  });
});
