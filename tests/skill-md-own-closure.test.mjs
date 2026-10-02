/**
 * A SKILL.md may cite only files its OWN skill directory contains.
 *
 * A packaged skill ships exactly one directory, and a consumer receives each
 * skill as `.claude/skills/<name>/` — so a citation that reaches into a sibling
 * skill (`../persona-test/references/auth-bootstrap.md`) or names a
 * `references/<file>.md` the skill never received resolves to nothing the moment
 * the skill is loaded alone. Shared material reaches a skill as its own
 * generated copy via `scripts/sync-shared-audit-refs.mjs` (the precedent: click-test
 * resolves the browser driver contract from its own `references/` copy), never
 * by pointing across.
 *
 * Three shapes, because one is not enough:
 *   - a relative markdown LINK that escapes the skill dir or names a missing file;
 *   - a bare `references/<f>.md` / `examples/<f>.md` MENTION with no file behind
 *     it (the prose form — `cycle` cited `references/input-acquisition.md` and
 *     owned no copy; no link checker can see it);
 *   - a `<other-skill>/references/<f>.md` path naming a sibling skill's file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

/**
 * @param {string} skillDir absolute skill directory
 * @param {string} text SKILL.md contents
 * @param {Set<string>} skillNames every skill directory name
 * @returns {{violations: Array<{line:number, kind:string, target:string}>, linksScanned:number}}
 */
function findOutOfSkillRefs(skillDir, text, skillNames) {
  const own = path.basename(skillDir);
  const violations = [];
  let linksScanned = 0;
  text.split('\n').forEach((line, i) => {
    const at = i + 1;
    for (const m of line.matchAll(/\]\(([^)\s]+)/g)) {
      const href = m[1].split('#')[0];
      // URLs, mailto:, pure anchors and repo-absolute paths are not relative links.
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) continue;
      linksScanned++;
      const abs = path.resolve(skillDir, href);
      const rel = path.relative(skillDir, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        violations.push({ line: at, kind: 'link-escapes-skill', target: m[1] });
      } else if (!fs.existsSync(abs)) {
        violations.push({ line: at, kind: 'link-missing', target: m[1] });
      }
    }
    // A path inside a URL names the upstream repo, not this skill's closure.
    const prose = line.replaceAll(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '');
    for (const m of prose.matchAll(/(?<![\w/.-])((?:references|examples)\/[\w.-]+\.md)/g)) {
      if (!fs.existsSync(path.join(skillDir, m[1]))) {
        violations.push({ line: at, kind: 'mention-missing', target: m[1] });
      }
    }
    for (const m of prose.matchAll(/(?<![\w.-])([\w-]+)\/(?:references|examples)\/[\w.-]+\.md/g)) {
      if (m[1] !== own && skillNames.has(m[1])) {
        violations.push({ line: at, kind: 'names-sibling-skill-file', target: m[0] });
      }
    }
  });
  // One citation is often both a link text and its href; report it once.
  const seen = new Set();
  return {
    violations: violations.filter(v => !seen.has(`${v.line}|${v.kind}|${v.target}`)
      && seen.add(`${v.line}|${v.kind}|${v.target}`)),
    linksScanned,
  };
}

function listSkills() {
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map(d => d.name)
    .sort();
}

describe('every SKILL.md cites only files inside its own skill directory', () => {
  const skills = listSkills();
  const names = new Set(skills);
  let totalLinks = 0;

  for (const skill of skills) {
    it(`skills/${skill}/SKILL.md`, () => {
      const dir = path.join(SKILLS_DIR, skill);
      const { violations, linksScanned } = findOutOfSkillRefs(
        dir, fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8'), names);
      totalLinks += linksScanned;
      assert.deepEqual(
        violations.map(v => `SKILL.md:${v.line} ${v.kind} ${v.target}`), [],
        'Give the skill its own copy (enrol it in EXPECTED_CONSUMERS in '
        + 'scripts/sync-shared-audit-refs.mjs) or reroute the citation to a file the skill owns.',
      );
    });
  }

  it('vacuous-pass guard: the scan saw skills and relative links', () => {
    assert.ok(skills.length >= 10, `expected the skill roster, saw ${skills.length}`);
    assert.ok(totalLinks > 0, 'no relative links were scanned — the detector is reading nothing');
  });
});

describe('findOutOfSkillRefs — the detector fires, and only where it should', () => {
  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-closure-'));
    for (const s of ['alpha', 'beta']) {
      fs.mkdirSync(path.join(root, s, 'references'), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'alpha', 'references', 'own.md'), 'x');
    fs.writeFileSync(path.join(root, 'beta', 'references', 'theirs.md'), 'x');
    return { root, dir: path.join(root, 'alpha'), names: new Set(['alpha', 'beta']) };
  }

  it('flags each of the three shapes', () => {
    const { root, dir, names } = fixture();
    try {
      const text = [
        'see [x](../beta/references/theirs.md)',
        'see [y](references/gone.md)',
        'per `references/absent.md`',
        "per beta's `beta/references/theirs.md`",
      ].join('\n');
      const kinds = findOutOfSkillRefs(dir, text, names).violations.map(v => `${v.line}:${v.kind}`);
      assert.deepEqual(kinds, [
        '1:link-escapes-skill',
        '1:names-sibling-skill-file',
        '2:link-missing',
        '2:mention-missing',
        '3:mention-missing',
        '4:names-sibling-skill-file',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves in-skill links, URLs, anchors and unrelated paths alone', () => {
    const { root, dir, names } = fixture();
    try {
      const text = [
        'see [x](references/own.md) and [x2](./references/own.md#sec)',
        'see [u](https://example.com/beta/references/theirs.md) and [a](#anchor)',
        'per `references/own.md`; also `scripts/lib/references/thing.md`',
        'per `alpha/references/own.md` (own skill)',
      ].join('\n');
      assert.deepEqual(findOutOfSkillRefs(dir, text, names).violations, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
