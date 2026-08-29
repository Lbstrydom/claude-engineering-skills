/**
 * @fileoverview Guards `.sync-overrides.json` — the consumer's half of the
 * ownership contract.
 *
 * Two properties carry most of the weight, and both are about failure modes
 * rather than happy paths:
 *
 *  - a malformed file must ABORT, never fail open. Fail-open would silently
 *    resume overwriting exactly the paths the consumer wrote it to protect,
 *    while the sync reported clean — the operator's evidence that the guard
 *    works is that nothing happened, so a silent no-op is indistinguishable
 *    from success.
 *  - an override may never claim `scripts/.claude-skills/**`. Letting one make
 *    a local patch of upstream-owned tooling DURABLE would convert the single
 *    governance rule the upstream banner enforces into an opt-out.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  OVERRIDES_PATH, compileGlob, normaliseOverridePath, validateOverrides,
  loadOverrides, matchOverride, renderGitignoreExtras,
} from '../scripts/lib/sync-overrides.mjs';

function tmpRepo(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-overrides-'));
  if (contents !== undefined) {
    fs.writeFileSync(path.join(dir, OVERRIDES_PATH), contents, 'utf-8');
  }
  return dir;
}

describe('normaliseOverridePath', () => {
  test('folds Windows separators — a pasted backslash path must still match', () => {
    // Otherwise an operator writes a correct-looking override that matches
    // nothing: a guard that reads as active and is not.
    assert.equal(normaliseOverridePath('.claude\\skills\\plan\\SKILL.md'), '.claude/skills/plan/SKILL.md');
  });

  test('strips a leading ./ and leading slashes', () => {
    assert.equal(normaliseOverridePath('./a/b.json'), 'a/b.json');
    assert.equal(normaliseOverridePath('/a/b.json'), 'a/b.json');
  });
});

describe('compileGlob', () => {
  test('* stays within one segment', () => {
    const re = compileGlob('.claude/skills/*/SKILL.md');
    assert.equal(re.test('.claude/skills/plan/SKILL.md'), true);
    assert.equal(re.test('.claude/skills/plan/references/SKILL.md'), false);
  });

  test('** crosses segments', () => {
    const re = compileGlob('docs/**/notes.md');
    assert.equal(re.test('docs/a/b/notes.md'), true);
  });

  test('regex metacharacters in a path are literal', () => {
    const re = compileGlob('a+b/c.json');
    assert.equal(re.test('a+b/c.json'), true);
    assert.equal(re.test('aab/cXjson'), false);
  });
});

describe('validateOverrides — accepts a well-formed document', () => {
  const doc = {
    version: 1,
    overrides: [
      { path: '.vscode/mcp.json', reason: 'pinning gate' },
      { glob: '.claude/skills/*/SKILL.md', reason: 'condensed preflight block' },
    ],
    gitignoreExtra: [{ pattern: '.audit-loop/cache/', reason: 'runtime cache' }],
  };

  test('no errors, and both rule kinds are compiled', () => {
    const r = validateOverrides(doc);
    assert.deepEqual(r.errors, []);
    assert.equal(r.overrides.length, 2);
    assert.equal(r.gitignoreExtra.length, 1);
  });

  test('an exact path rule does not match by prefix', () => {
    const { overrides } = validateOverrides(doc);
    assert.ok(matchOverride('.vscode/mcp.json', overrides));
    assert.equal(matchOverride('.vscode/mcp.json.bak', overrides), null);
  });

  test('first declared rule wins, so the file reads top-to-bottom', () => {
    const { overrides } = validateOverrides({
      version: 1,
      overrides: [
        { glob: '.claude/skills/**', reason: 'first' },
        { path: '.claude/skills/plan/SKILL.md', reason: 'second' },
      ],
    });
    assert.equal(matchOverride('.claude/skills/plan/SKILL.md', overrides).reason, 'first');
  });
});

describe('validateOverrides — rejects', () => {
  const reject = (doc, pattern) => {
    const r = validateOverrides(doc);
    assert.ok(r.errors.length > 0, 'expected at least one error');
    assert.ok(r.errors.some((e) => pattern.test(e)), `no error matched ${pattern}: ${r.errors.join(' | ')}`);
  };

  test('a missing reason', () => {
    reject({ version: 1, overrides: [{ path: 'a.json' }] }, /"reason" is required/);
  });

  test('a blank reason', () => {
    reject({ version: 1, overrides: [{ path: 'a.json', reason: '   ' }] }, /"reason" is required/);
  });

  test('both path and glob on one entry', () => {
    reject({ version: 1, overrides: [{ path: 'a', glob: 'b', reason: 'r' }] }, /exactly one of/);
  });

  test('neither path nor glob', () => {
    reject({ version: 1, overrides: [{ reason: 'r' }] }, /needs a "path" or a "glob"/);
  });

  test('a wrong version', () => {
    reject({ version: 2, overrides: [] }, /"version" must be 1/);
  });

  test('a non-object top level', () => {
    reject([], /expected a JSON object/);
  });

  test('an override claiming the upstream-owned tooling tree', () => {
    reject(
      { version: 1, overrides: [{ path: 'scripts/.claude-skills/cross-skill.mjs', reason: 'local patch' }] },
      /upstream-owned/,
    );
  });

  test('the tooling-tree refusal names the sanctioned path instead', () => {
    // A refusal that does not say what to do instead is how a consumer ends up
    // patching the synced copy anyway.
    const r = validateOverrides({
      version: 1,
      overrides: [{ glob: 'scripts/.claude-skills/**', reason: 'x' }],
    });
    assert.ok(r.errors.some((e) => /upstream report/.test(e)));
  });

  test('an override claiming the manifest itself', () => {
    reject({ version: 1, overrides: [{ path: 'scripts/.sync-manifest.json', reason: 'r' }] }, /may not be overridden/);
  });

  test('a gitignore pattern carrying a managed-block marker', () => {
    // Authored here, but it would corrupt the block and abort the NEXT sync.
    reject(
      { version: 1, gitignoreExtra: [{ pattern: '# managed-by:claude-engineering-skills-sync — DO NOT EDIT INSIDE', reason: 'r' }] },
      /may not contain a managed-block marker/,
    );
  });

  test('a multi-line gitignore pattern', () => {
    reject({ version: 1, gitignoreExtra: [{ pattern: 'a\nb', reason: 'r' }] }, /single line/);
  });

  test('all errors are reported at once, not one per sync', () => {
    const r = validateOverrides({
      version: 1,
      overrides: [{ path: 'a' }, { path: 'b' }, { reason: 'c' }],
    });
    assert.equal(r.errors.length, 3);
  });
});

describe('loadOverrides — the absent/malformed distinction', () => {
  test('an absent file is the ordinary case: empty and error-free', () => {
    const r = loadOverrides(tmpRepo(undefined));
    assert.equal(r.present, false);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.overrides, []);
  });

  test('a malformed file is an ERROR, never a silent empty result', () => {
    // The two states are indistinguishable to the caller unless separated here,
    // and collapsing them makes a typo silently disable every override the
    // consumer believes it has.
    const r = loadOverrides(tmpRepo('{ not json'));
    assert.equal(r.present, true);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /unreadable or malformed JSON/);
  });

  test('a valid file loads', () => {
    const dir = tmpRepo(JSON.stringify({
      version: 1, overrides: [{ path: '.vscode/mcp.json', reason: 'pinned' }],
    }));
    const r = loadOverrides(dir);
    assert.deepEqual(r.errors, []);
    assert.equal(r.overrides.length, 1);
  });
});

describe('renderGitignoreExtras', () => {
  test('renders nothing for an empty list, so the block is unchanged', () => {
    assert.deepEqual(renderGitignoreExtras([]), []);
  });

  test('each pattern is preceded by its reason and the file that declares it', () => {
    const lines = renderGitignoreExtras([{ pattern: '.audit-loop/cache/', reason: 'runtime cache' }]);
    assert.ok(lines.some((l) => l.includes(OVERRIDES_PATH)));
    assert.ok(lines.includes('# runtime cache'));
    assert.ok(lines.includes('.audit-loop/cache/'));
  });

  test('emits no blank line — updateManagedBlock drops those', () => {
    // A separator that is silently discarded reads as a formatting bug in the
    // consumer's .gitignore rather than as intended output.
    const lines = renderGitignoreExtras([{ pattern: 'x', reason: 'y' }]);
    assert.equal(lines.some((l) => l.trim() === ''), false);
  });
});
