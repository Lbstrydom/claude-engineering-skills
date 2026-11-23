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
import { canonicalizeEol } from '../scripts/lib/file-io.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES = '.claude/rules';
const INSTRUCTIONS = '.github/instructions';
const SUFFIX = '.instructions.md';

function listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
}

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const lines = m[1].split('\n');
  const paths = [];
  let applyTo = null;
  let inPaths = false;
  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    const item = inPaths && /^\s+-\s+["']?(.*?)["']?\s*$/.exec(line);
    if (item) { paths.push(item[1]); continue; }
    inPaths = false;
    const a = /^applyTo:\s*["']?(.*?)["']?\s*$/.exec(line);
    if (a) applyTo = a[1].split(',').map(s => s.trim()).filter(Boolean);
  }
  return { paths, applyTo };
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
    const a = canonicalizeEol(fs.readFileSync(path.join(root, RULES, `${t}.md`)));
    const b = canonicalizeEol(fs.readFileSync(path.join(root, INSTRUCTIONS, `${t}${SUFFIX}`)));
    if (!a.equals(b)) problems.push(`${t}: twins differ`);
    const fm = frontmatter(a.toString('utf8'));
    if (!fm || fm.paths.length === 0) { problems.push(`${t}: no paths: list (an unscoped rule loads every session)`); continue; }
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

test('positive control: a faithful pair has no problems, CRLF on one side included', () => {
  const dir = fixture({ [`${RULES}/x.md`]: GOOD, [`${INSTRUCTIONS}/x${SUFFIX}`]: GOOD.replace(/\n/g, '\r\n') });
  assert.deepEqual(twinProblems(dir), []);
});

test('negative controls: each defect is named', () => {
  const differ = fixture({ [`${RULES}/x.md`]: GOOD, [`${INSTRUCTIONS}/x${SUFFIX}`]: GOOD.replace('body', 'bodY') });
  assert.deepEqual(twinProblems(differ), ['x: twins differ']);

  const lonelyRule = fixture({ [`${RULES}/x.md`]: GOOD });
  assert.deepEqual(twinProblems(lonelyRule), [`x: no ${INSTRUCTIONS}/x${SUFFIX} twin`]);

  const lonelyInstr = fixture({ [`${INSTRUCTIONS}/x${SUFFIX}`]: GOOD });
  assert.deepEqual(twinProblems(lonelyInstr), [`x: no ${RULES}/x.md twin`]);

  const unscoped = '---\napplyTo: \'a/**\'\n---\nbody\n';
  const noPaths = fixture({ [`${RULES}/x.md`]: unscoped, [`${INSTRUCTIONS}/x${SUFFIX}`]: unscoped });
  assert.deepEqual(twinProblems(noPaths), ['x: no paths: list (an unscoped rule loads every session)']);

  const skew = GOOD.replace("'a/**, b.mjs'", "'a/**'");
  const globSkew = fixture({ [`${RULES}/x.md`]: skew, [`${INSTRUCTIONS}/x${SUFFIX}`]: skew });
  assert.deepEqual(twinProblems(globSkew), ['x: paths and applyTo name different globs']);
});
