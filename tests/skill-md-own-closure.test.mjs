/**
 * A SKILL.md — and every `references/*.md` / `examples/*.md` it ships — may cite
 * only files its OWN skill directory contains.
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
 *
 * The reference and example files are scanned too (2026-10-02): every generated
 * copy of verification-discipline.md outside audit-code linked
 * `../../audit-code/examples/contract-test-scaffold.md` — the sync renderer kept
 * any `skills/` target relative — and a SKILL.md-only scan could not see it.
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
 * @param {string} text contents of a markdown file the skill ships
 * @param {Set<string>} skillNames every skill directory name
 * @param {string} [fileDir] directory of that file — relative hrefs resolve from
 *   here, while bare `references/…` mentions stay skill-root-relative prose
 * @returns {{violations: Array<{line:number, kind:string, target:string}>, linksScanned:number}}
 */
function findOutOfSkillRefs(skillDir, text, skillNames, fileDir = skillDir) {
  const own = path.basename(skillDir);
  const violations = [];
  let linksScanned = 0;
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    const at = i + 1;
    // Inside a fenced block `](x)` is literal text, not a link — e.g. a CLAUDE.md
    // TEMPLATE whose `[AGENTS.md](./AGENTS.md)` is meant for the consumer's root.
    // Mentions are still checked there: `cat references/x.md` in a command block
    // is a citation all the same.
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    for (const m of inFence ? [] : line.matchAll(/\]\(([^)\s]+)/g)) {
      const href = m[1].split('#')[0];
      // URLs, mailto:, pure anchors and repo-absolute paths are not relative links.
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) continue;
      linksScanned++;
      const abs = path.resolve(fileDir, href);
      const rel = path.relative(skillDir, abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        violations.push({ line: at, kind: 'link-escapes-skill', target: m[1] });
      } else if (!fs.existsSync(abs)) {
        violations.push({ line: at, kind: 'link-missing', target: m[1] });
      }
    }
    // A path inside a URL names the upstream repo, not this skill's closure —
    // and so does the TEXT of a link whose href is that URL: the citation is
    // carried by the href, which resolves anywhere.
    const prose = line
      .replaceAll(/\[[^\]]*\]\([a-z][a-z0-9+.-]*:[^)]*\)/gi, '')
      .replaceAll(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '');
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

describe('every references/*.md and examples/*.md cites only files inside its own skill directory', () => {
  const skills = listSkills();
  const names = new Set(skills);
  let filesScanned = 0;
  let totalLinks = 0;

  for (const skill of skills) {
    const dir = path.join(SKILLS_DIR, skill);
    for (const sub of ['references', 'examples']) {
      const subDir = path.join(dir, sub);
      if (!fs.existsSync(subDir)) continue;
      for (const f of fs.readdirSync(subDir).filter(n => n.endsWith('.md')).sort()) {
        it(`skills/${skill}/${sub}/${f}`, () => {
          const { violations, linksScanned } = findOutOfSkillRefs(
            dir, fs.readFileSync(path.join(subDir, f), 'utf-8'), names, subDir);
          filesScanned++;
          totalLinks += linksScanned;
          assert.deepEqual(
            violations.map(v => `${sub}/${f}:${v.line} ${v.kind} ${v.target}`), [],
            'A generated copy is fixed in its canonical or in scripts/sync-shared-audit-refs.mjs '
            + '(re-run it), never by hand; otherwise give the skill its own copy or link the '
            + 'upstream URL.',
          );
        });
      }
    }
  }

  it('vacuous-pass guard: the scan read reference files with relative links in them', () => {
    assert.ok(filesScanned >= 20, `expected the skills' reference files, scanned ${filesScanned}`);
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
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("resolves a reference file's links from ITS directory, not the skill root", () => {
    const { root, dir, names } = fixture();
    try {
      const refs = path.join(dir, 'references');
      // `../../beta/…` from alpha/references/ escapes alpha; `./own.md` is a sibling file.
      const text = 'see [x](../../beta/references/theirs.md) and [y](./own.md)';
      const kinds = findOutOfSkillRefs(dir, text, names, refs).violations.map(v => v.kind);
      assert.deepEqual(kinds, ['link-escapes-skill', 'names-sibling-skill-file']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('accepts a sibling path cited as the TEXT of an upstream-URL link', () => {
    const { root, dir, names } = fixture();
    try {
      const text = '[`skills/beta/references/theirs.md`](https://example.com/skills/beta/references/theirs.md)';
      assert.deepEqual(findOutOfSkillRefs(dir, text, names).violations, []);
      // ...but the same text as a bare mention is still a sibling citation.
      const bare = findOutOfSkillRefs(dir, 'per `skills/beta/references/theirs.md`', names);
      assert.deepEqual(bare.violations.map(v => v.kind), ['names-sibling-skill-file']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('ignores link syntax inside a fenced block, but not a mention there', () => {
    const { root, dir, names } = fixture();
    try {
      const text = ['```markdown', 'see [a](./AGENTS.md)', 'cat `references/absent.md`', '```',
        'see [b](./AGENTS.md)'].join('\n');
      const got = findOutOfSkillRefs(dir, text, names).violations.map(v => `${v.line}:${v.kind}`);
      assert.deepEqual(got, ['3:mention-missing', '5:link-missing']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
