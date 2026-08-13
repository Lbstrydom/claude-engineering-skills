/**
 * Tests for scripts/lib/skills-index.mjs
 *
 * Split verbatim out of tests/skills-help.test.mjs when parseSkill/loadAllSkills
 * moved from the CLI entry point into shared-lib (L5 of the layering series —
 * docs/plans/dashboard-skills-index-layering.md). The assertions are unchanged:
 * an edit here would mean the move was not verbatim.
 *
 * Coverage:
 *   1. parseSkill — frontmatter extraction + edge cases (CRLF, missing fields,
 *      disable-model-invocation buried inside description literal block)
 *   2. loadAllSkills — graceful empty when skills/ missing, sorting, skip rules
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkill, loadAllSkills } from '../scripts/lib/skills-index.mjs';

function mkTmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-index-'));
}

function writeSkill(repoRoot, name, body) {
  const dir = path.join(repoRoot, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, body);
  return file;
}

describe('parseSkill', () => {
  it('extracts name + oneLiner + triggers + usage from a clean LF file', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'foo', `---
name: foo
description: |
  A short summary sentence.
  More background that should NOT be the one-liner.
  Triggers on: "do foo", "run foo", "/foo"
  Usage:
    /foo arg                 — does the thing
    /foo --flag              — does the thing with a flag
---

# Foo
Body.
`);
    const r = parseSkill(file);
    assert.equal(r.name, 'foo');
    assert.equal(r.oneLiner, 'A short summary sentence.');
    assert.deepEqual(r.triggers, ['do foo', 'run foo', '/foo']);
    assert.equal(r.usage.length, 2);
    assert.match(r.usage[0], /\/foo arg/);
    assert.equal(r.disableModelInvocation, false);
  });

  it('falls back to a `## Usage` body section when the frontmatter has none (Copilot 1024-cap relocation)', () => {
    // Regression: 2026-07-21 six skills relocated Usage out of the ≤1024-char
    // description into a body `## Usage` fence; parseSkill scraped Usage only
    // from the description and silently dropped it (caught by the Gemini gate).
    const root = mkTmpRepo();
    const file = writeSkill(root, 'baz', `---
name: baz
description: |
  A short summary.
  Triggers on: "do baz", "/baz"
  Full command syntax: see the Usage section in this skill.
---

# Baz

## Usage

\`\`\`
Usage: /baz <arg>            — does the thing
Usage: /baz --flag          — with a flag
Triggers on: "do baz", "/baz"
\`\`\`

More body.
`);
    const r = parseSkill(file);
    assert.equal(r.name, 'baz');
    assert.deepEqual(r.triggers, ['do baz', '/baz'], 'triggers still come from the description');
    assert.equal(r.usage.length, 2, 'both Usage lines recovered from the body fence');
    assert.match(r.usage[0], /\/baz <arg>/);
    assert.ok(!r.usage.some((u) => /triggers on:/i.test(u)), 'stray Triggers line in the fence is not treated as usage');
  });

  it('handles CRLF line endings', () => {
    const root = mkTmpRepo();
    const lfBody = `---
name: bar
description: |
  CRLF test.
  Triggers on: "bar"
  Usage:
    /bar
---

Body
`;
    const file = writeSkill(root, 'bar', lfBody.replace(/\n/g, '\r\n'));
    const r = parseSkill(file);
    assert.ok(r, 'should parse despite CRLF');
    assert.equal(r.name, 'bar');
  });

  it('handles disable-model-invocation as a top-level YAML key', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'baz', `---
name: baz
description: |
  Manual-only skill.
  Triggers on: "/baz"
  Usage:
    /baz
disable-model-invocation: true
---
`);
    const r = parseSkill(file);
    assert.equal(r.disableModelInvocation, true);
  });

  it('returns null on missing frontmatter', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'noframe', `# No frontmatter\nJust body.\n`);
    assert.equal(parseSkill(file), null);
  });

  it('returns null on missing name', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'anon', `---
description: |
  Anonymous.
---
`);
    assert.equal(parseSkill(file), null);
  });

  it('returns null on missing description', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'nodesc', `---
name: nodesc
---
`);
    assert.equal(parseSkill(file), null);
  });

  it('returns null on unreadable file', () => {
    const r = parseSkill(path.join(os.tmpdir(), 'definitely-does-not-exist.md'));
    assert.equal(r, null);
  });

  it('returns null on a non-string name (number / boolean / map)', () => {
    // Regression, code-audit R1/H1 (2026-08-01): the check was `!fm.name`, so YAML
    // scalars other than strings passed. Repro'd before fixing — loadAllSkills then
    // threw `a.name.localeCompare is not a function` and aborted the entire scan,
    // which the dashboard's try/catch turned into a silently empty skills section.
    const root = mkTmpRepo();
    for (const [label, value] of [['numeric', '123'], ['boolish', 'true'], ['mapish', '\n  value: foo']]) {
      const file = writeSkill(root, label, `---
name: ${value}
description: |
  Non-string name.
  Triggers on: "x"
---
`);
      assert.equal(parseSkill(file), null, `${label}: a non-string name must be rejected, not coerced`);
    }
  });

  it('extracts first sentence even when no period present', () => {
    const root = mkTmpRepo();
    const file = writeSkill(root, 'noperiod', `---
name: noperiod
description: |
  No period in this summary text
  Triggers on: "x"
  Usage:
    /noperiod
---
`);
    const r = parseSkill(file);
    assert.match(r.oneLiner, /No period in this summary text/);
  });
});

describe('loadAllSkills', () => {
  it('returns [] when skills/ does not exist', () => {
    const root = mkTmpRepo();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      assert.deepEqual(loadAllSkills(), []);
    } finally { process.chdir(cwd); }
  });

  it('returns sorted array when present', () => {
    const root = mkTmpRepo();
    writeSkill(root, 'zebra', `---
name: zebra
description: |
  Z skill.
  Triggers on: "z"
  Usage: /zebra
---
`);
    writeSkill(root, 'alpha', `---
name: alpha
description: |
  A skill.
  Triggers on: "a"
  Usage: /alpha
---
`);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const skills = loadAllSkills();
      assert.equal(skills.length, 2);
      assert.equal(skills[0].name, 'alpha');
      assert.equal(skills[1].name, 'zebra');
    } finally { process.chdir(cwd); }
  });

  it('skips directories without SKILL.md', () => {
    const root = mkTmpRepo();
    fs.mkdirSync(path.join(root, 'skills', 'no-skill-md'), { recursive: true });
    writeSkill(root, 'has-skill', `---
name: has-skill
description: |
  Real one.
  Triggers on: "x"
  Usage: /has-skill
---
`);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const skills = loadAllSkills();
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, 'has-skill');
    } finally { process.chdir(cwd); }
  });

  it('skips a malformed-name skill instead of aborting the whole scan', () => {
    // The other half of R1/H1: the sort must survive a bad neighbour.
    const root = mkTmpRepo();
    writeSkill(root, 'numeric', `---
name: 123
description: |
  Non-string name.
  Triggers on: "x"
---
`);
    writeSkill(root, 'good', `---
name: good
description: |
  Fine.
  Triggers on: "x"
---
`);
    const skills = loadAllSkills(path.join(root, 'skills'));
    assert.equal(skills.length, 1, 'the good skill must still be returned');
    assert.equal(skills[0].name, 'good');
  });

  it('reports WHY a present SKILL.md was skipped, per cause', () => {
    // `loadAllSkills` already existsSync-gates the file, so a null from
    // parseSkill at that call site is NEVER "absent" — it is always a file that
    // is present and unparseable. It was dropped with no diagnostic, so a skill
    // with corrupt YAML simply vanished from the dashboard and from skills-help
    // and read exactly like a skill that had not been written yet.
    const root = mkTmpRepo();
    writeSkill(root, 'badyaml', `---\nname: [unclosed\ndescription: x\n---\n`);
    writeSkill(root, 'noframe', `# no frontmatter\n`);
    writeSkill(root, 'numeric', `---\nname: 123\ndescription: |\n  x\n---\n`);
    writeSkill(root, 'good', `---\nname: good\ndescription: |\n  Fine.\n  Triggers on: "x"\n---\n`);

    const skipped = [];
    const skills = loadAllSkills(path.join(root, 'skills'), { onSkip: (s) => skipped.push(s) });

    assert.equal(skills.length, 1, 'the good skill is still returned');
    assert.equal(skills[0].name, 'good');

    const byReason = Object.fromEntries(skipped.map((s) => [s.reason, s]));
    assert.deepEqual(
      Object.keys(byReason).sort(),
      ['invalid-frontmatter', 'no-frontmatter', 'unparseable-yaml'],
      'the three causes must be distinguishable, not one undifferentiated null',
    );
    // Every report names the file, or it cannot be acted on.
    for (const s of skipped) assert.match(s.file, /SKILL\.md$/);
    // The YAML failure carries the parser's own message.
    assert.ok(byReason['unparseable-yaml'].detail, 'a YAML failure must carry its error detail');
  });

  it('POSITIVE CONTROL: onSkip is not called when every skill parses', () => {
    // Without this, the test above could pass against a function that reports
    // everything as skipped.
    const root = mkTmpRepo();
    writeSkill(root, 'good', `---\nname: good\ndescription: |\n  Fine.\n  Triggers on: "x"\n---\n`);
    const skipped = [];
    const skills = loadAllSkills(path.join(root, 'skills'), { onSkip: (s) => skipped.push(s) });
    assert.equal(skills.length, 1);
    assert.deepEqual(skipped, []);
  });

  it('omitting onSkip keeps the existing signature working (no throw, same result)', () => {
    const root = mkTmpRepo();
    writeSkill(root, 'badyaml', `---\nname: [unclosed\ndescription: x\n---\n`);
    writeSkill(root, 'good', `---\nname: good\ndescription: |\n  Fine.\n  Triggers on: "x"\n---\n`);
    const skills = loadAllSkills(path.join(root, 'skills'));
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'good');
  });

  it('accepts an explicit skills directory without chdir (the call-site contract)', () => {
    // §2.5: collect-reference.mjs passes path.join(root, 'skills') rather than
    // relying on cwd. Cover that path explicitly — nothing else did.
    const root = mkTmpRepo();
    writeSkill(root, 'explicit', `---
name: explicit
description: |
  Explicit-root skill.
  Triggers on: "x"
  Usage: /explicit
---
`);
    const skills = loadAllSkills(path.join(root, 'skills'));
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'explicit');
  });
});
