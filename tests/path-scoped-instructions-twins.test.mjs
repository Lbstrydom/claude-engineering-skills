/**
 * @fileoverview Path-scoped instruction files have two readers and one text.
 *
 * Claude Code loads `.claude/rules/<topic>.md` when a file matching its `paths:`
 * is read or edited; the VS Code Copilot harness loads
 * `.github/instructions/<topic>.instructions.md` by its `applyTo:` glob and never
 * reads `.claude/rules` (custom-instructions reference, checked 2026-11-23). The
 * AGENTS.md tripwires moved into these files must reach both hosts, so the two
 * files are byte-identical twins carrying both keys, and the two glob lists must
 * name the same patterns. An `@import` inside a rule is NOT a way round the copy:
 * Claude Code loads a path-scoped rule's import at session start (measured
 * 2026-11-23 with a canary), which would defeat the scoping.
 *
 * The census iterates BOTH directories, so a twin missing on either side fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES = '.claude/rules';
const INSTRUCTIONS = '.github/instructions';
const SUFFIX = '.instructions.md';

/** Both hosts discover recursively, so the census does too: `/`-separated paths relative to `dir`. */
function listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map(f => String(f).split(path.sep).join('/'))
    .filter(f => f.endsWith('.md') && fs.statSync(path.join(dir, f)).isFile())
    .sort();
}

/** `applyTo` is comma-separated, but a comma inside a `{a,b}` brace group belongs to the glob. */
function splitApplyTo(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

/**
 * The YAML header, parsed by a real YAML parser: a malformed header is a problem,
 * never a best-effort extraction. Returns { error } or { paths, applyTo }.
 * EOLs are folded for PARSING only; the twin comparison below is on raw bytes.
 */
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return { error: 'no YAML frontmatter' };
  let doc;
  try { doc = parseYaml(m[1]); } catch (e) { return { error: `frontmatter is not valid YAML (${e.message.split('\n')[0]})` }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'frontmatter is not a mapping' };
  const { paths, applyTo } = doc;
  if (paths !== undefined && !(Array.isArray(paths) && paths.every(p => typeof p === 'string' && p.trim()))) {
    return { error: 'paths: must be a list of non-empty strings' };
  }
  if (applyTo !== undefined && typeof applyTo !== 'string') return { error: 'applyTo: must be a string' };
  return {
    paths: paths ?? [],
    applyTo: applyTo === undefined ? null : splitApplyTo(applyTo),
  };
}

/** Every reason the two directories under `root` are not a faithful twin set. */
function twinProblems(root) {
  const problems = [];
  const rules = listMd(path.join(root, RULES));
  const instr = listMd(path.join(root, INSTRUCTIONS)).filter(f => f.endsWith(SUFFIX));
  const ruleTopics = new Set(rules.map(f => f.slice(0, -'.md'.length)));
  const instrTopics = new Set(instr.map(f => f.slice(0, -SUFFIX.length)));
  for (const t of instrTopics) if (!ruleTopics.has(t)) problems.push(`${t}: no ${RULES}/${t}.md twin`);
  for (const t of ruleTopics) {
    if (!instrTopics.has(t)) { problems.push(`${t}: no ${INSTRUCTIONS}/${t}${SUFFIX} twin`); continue; }
    // Raw bytes: "byte-identical" is the contract. Both files are .md under the
    // same EOL policy, so a checkout converts them alike and only a real
    // difference (including an EOL-only one) fails.
    const a = fs.readFileSync(path.join(root, RULES, `${t}.md`));
    const b = fs.readFileSync(path.join(root, INSTRUCTIONS, `${t}${SUFFIX}`));
    if (!a.equals(b)) problems.push(`${t}: twins differ`);
    const fm = frontmatter(a.toString('utf8'));
    if (fm.error) { problems.push(`${t}: ${fm.error}`); continue; }
    if (fm.paths.length === 0) { problems.push(`${t}: no paths: list (an unscoped rule loads every session)`); continue; }
    if (!fm.applyTo || fm.applyTo.length === 0) { problems.push(`${t}: no applyTo: (Copilot would never attach it)`); continue; }
    if ([...fm.paths].sort().join('\n') !== [...fm.applyTo].sort().join('\n')) {
      problems.push(`${t}: paths and applyTo name different globs`);
    }
  }
  return problems;
}

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twins-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const GOOD = "---\napplyTo: 'a/**, b.mjs'\npaths:\n  - \"a/**\"\n  - \"b.mjs\"\n---\nbody\n";

test('the repo has at least one path-scoped rule (vacuous-pass guard)', () => {
  assert.ok(listMd(path.join(REPO, RULES)).length >= 1);
});

test('every .claude/rules file has a byte-identical .github/instructions twin with matching globs', () => {
  assert.deepEqual(twinProblems(REPO), []);
});

test('positive control: a faithful pair has no problems, LF or CRLF alike', () => {
  assert.deepEqual(twinProblems(fixture({ [`${RULES}/x.md`]: GOOD, [`${INSTRUCTIONS}/x${SUFFIX}`]: GOOD })), []);
  const crlf = GOOD.replace(/\n/g, '\r\n');
  assert.deepEqual(twinProblems(fixture({ [`${RULES}/x.md`]: crlf, [`${INSTRUCTIONS}/x${SUFFIX}`]: crlf })), []);
  const braces = "---\napplyTo: '**/*.{js,ts}, b.mjs'\npaths:\n  - \"**/*.{js,ts}\"\n  - \"b.mjs\"\n---\nbody\n";
  assert.deepEqual(twinProblems(fixture({ [`${RULES}/x.md`]: braces, [`${INSTRUCTIONS}/x${SUFFIX}`]: braces })), []);
  assert.deepEqual(twinProblems(fixture({ [`${RULES}/db/x.md`]: GOOD, [`${INSTRUCTIONS}/db/x${SUFFIX}`]: GOOD })), []);
});

test('negative controls: each defect is named', () => {
  const pair = body => fixture({ [`${RULES}/x.md`]: body, [`${INSTRUCTIONS}/x${SUFFIX}`]: body });

  const differ = fixture({ [`${RULES}/x.md`]: GOOD, [`${INSTRUCTIONS}/x${SUFFIX}`]: GOOD.replace('body', 'bodY') });
  assert.deepEqual(twinProblems(differ), ['x: twins differ']);

  const eolOnly = fixture({ [`${RULES}/x.md`]: GOOD, [`${INSTRUCTIONS}/x${SUFFIX}`]: GOOD.replace(/\n/g, '\r\n') });
  assert.deepEqual(twinProblems(eolOnly), ['x: twins differ']);

  assert.deepEqual(twinProblems(fixture({ [`${RULES}/x.md`]: GOOD })), [`x: no ${INSTRUCTIONS}/x${SUFFIX} twin`]);
  assert.deepEqual(twinProblems(fixture({ [`${INSTRUCTIONS}/x${SUFFIX}`]: GOOD })), [`x: no ${RULES}/x.md twin`]);
  assert.deepEqual(twinProblems(fixture({ [`${RULES}/db/x.md`]: GOOD })), [`db/x: no ${INSTRUCTIONS}/db/x${SUFFIX} twin`]);
  assert.deepEqual(twinProblems(fixture({ [`${RULES}/db/x.md`]: GOOD, [`${INSTRUCTIONS}/x${SUFFIX}`]: GOOD })),
    [`x: no ${RULES}/x.md twin`, `db/x: no ${INSTRUCTIONS}/db/x${SUFFIX} twin`]);

  assert.deepEqual(twinProblems(pair("---\napplyTo: 'a/**'\n---\nbody\n")),
    ['x: no paths: list (an unscoped rule loads every session)']);

  assert.deepEqual(twinProblems(pair('---\npaths:\n  - "a/**"\n---\nbody\n')),
    ['x: no applyTo: (Copilot would never attach it)']);

  // Unterminated quote: a line-regex parser extracted this happily.
  assert.match(twinProblems(pair("---\napplyTo: 'a/**\npaths:\n  - \"a/**\"\n---\nbody\n")).join('\n'),
    /^x: frontmatter is not valid YAML/);

  assert.deepEqual(twinProblems(pair("---\napplyTo: 'a/**'\npaths: 'a/**'\n---\nbody\n")),
    ['x: paths: must be a list of non-empty strings']);
  assert.deepEqual(twinProblems(pair("---\napplyTo: ['a/**']\npaths:\n  - \"a/**\"\n---\nbody\n")),
    ['x: applyTo: must be a string']);

  assert.deepEqual(twinProblems(pair("---\napplyTo: 'a/**'\npaths:\n  - \"a/**\"\n  - \"b.mjs\"\n---\nbody\n")),
    ['x: paths and applyTo name different globs']);
});

