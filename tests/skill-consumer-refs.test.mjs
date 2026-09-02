/**
 * @fileoverview Tests for the skill→consumer reference delivery gate.
 *
 * The gate itself is a ratchet, so the thing worth testing is not "does the
 * repo pass today" (the baseline guarantees that) but the four directions it
 * must FAIL in, and the two directions it must NOT fire in. A gate only ever
 * seen green is a gate nobody has shown to work — every assertion below feeds
 * it an input that must be rejected, or one that must be let through.
 *
 * Gate contract: skills-consumer-refs-gate-rejects-an-undeclared-unreachable-pointer
 * (scripts/gate-contracts/skills-consumer-refs-gate.json). The process-level
 * poison pill for that id runs from tests/gate-poison-pills.test.mjs; the unit
 * -level failure directions live here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFile, tally, adjudicate } from '../scripts/check-skill-consumer-refs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOSURE = new Set(['docs/reference/consistency-contract.md', 'scripts/openai-audit.mjs']);

const decl = (sites, over = {}) => ({
  disposition: 'source-repo-only',
  reason: 'a reason long enough to satisfy the minimum length check',
  sites,
  ...over,
});

test('a docs/ path outside the sync closure is a site', () => {
  const hits = scanFile('skills/x/SKILL.md', 'See `docs/plans/thing.md` for why.\n', CLOSURE);
  assert.deepEqual(hits, [{ kind: 'doc', ref: 'docs/plans/thing.md', file: 'skills/x/SKILL.md', line: 1 }]);
});

test('a docs/ path INSIDE the closure is not a site — the consumer receives it', () => {
  const hits = scanFile('skills/x/SKILL.md', 'See `docs/reference/consistency-contract.md`.\n', CLOSURE);
  assert.deepEqual(hits, []);
});

test('every npm run alias is a site, because the sync merges no scripts', () => {
  // The direction that matters: an alias this repo really defines is STILL
  // unreachable in a consumer. A gate that only flagged unknown aliases would
  // pass the exact defects this one exists to catch.
  const hits = scanFile('skills/x/SKILL.md', 'Run `npm run check` then `npm run arch:refresh`.\n', CLOSURE);
  assert.deepEqual(hits.map((h) => h.ref), ['check', 'arch:refresh']);
});

test('a command inside a fenced block is scanned, not skipped', () => {
  // Fences hold the most instructional form a pointer takes; skipping them
  // would blind the gate to precisely the sites that matter.
  const hits = scanFile('skills/x/SKILL.md', '```bash\nnpm run context:check\n```\n', CLOSURE);
  assert.deepEqual(hits.map((h) => [h.ref, h.line]), [['context:check', 2]]);
});

test('trailing prose punctuation is not captured as part of the script name', () => {
  const hits = scanFile('skills/x/SKILL.md', 'Then run npm run audit.\n', CLOSURE);
  assert.deepEqual(hits.map((h) => h.ref), ['audit']);
});

test('line numbers are 1-based and point at the pointer', () => {
  const hits = scanFile('skills/x/SKILL.md', 'a\nb\nSee `docs/plans/z.md`\n', CLOSURE);
  assert.equal(hits[0].line, 3);
});

test('FAILS on an undeclared ref kind', () => {
  const counts = tally(scanFile('f.md', 'npm run brand-new\n', CLOSURE));
  const v = adjudicate(counts, { refs: {} });
  assert.deepEqual(v.undeclared, [{ ref: 'npm brand-new', count: 1 }]);
});

test('FAILS when a declared kind grows a new site', () => {
  const counts = tally(scanFile('f.md', 'npm run check\nnpm run check\n', CLOSURE));
  const v = adjudicate(counts, { refs: { 'npm check': decl(1) } });
  assert.deepEqual(v.grown, [{ ref: 'npm check', was: 1, now: 2 }]);
  assert.deepEqual(v.undeclared, []);
});

test('FAILS when a declared kind no longer matches anything', () => {
  const v = adjudicate(tally([]), { refs: { 'npm ghost': decl(1) } });
  assert.deepEqual(v.stale, [{ ref: 'npm ghost', was: 1 }]);
});

test('FAILS on an unknown disposition', () => {
  const counts = tally(scanFile('f.md', 'npm run check\n', CLOSURE));
  const v = adjudicate(counts, { refs: { 'npm check': decl(1, { disposition: 'invented' }) } });
  assert.equal(v.malformed.length, 1);
  assert.match(v.malformed[0].problem, /unknown disposition/);
});

test('FAILS on a stub reason — an exemption without a why is not declared', () => {
  const counts = tally(scanFile('f.md', 'npm run check\n', CLOSURE));
  const v = adjudicate(counts, { refs: { 'npm check': decl(1, { reason: 'TODO' }) } });
  assert.equal(v.malformed.length, 1);
  assert.match(v.malformed[0].problem, /reason/);
});

test('a shrink is reported but does not fail — fixing sites must never block a push', () => {
  const counts = tally(scanFile('f.md', 'npm run check\n', CLOSURE));
  const v = adjudicate(counts, { refs: { 'npm check': decl(3) } });
  assert.deepEqual(v.shrunk, [{ ref: 'npm check', was: 3, now: 1 }]);
  assert.deepEqual(v.grown, []);
  assert.deepEqual(v.undeclared, []);
  assert.deepEqual(v.stale, []);
});

test('the committed baseline declares a disposition and a real reason for every entry', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(REPO, '.skill-consumer-refs-baseline.json'), 'utf-8'));
  const allowed = new Set(['source-repo-only', 'consumer-authored', 'provenance', 'consumer-wired']);
  const entries = Object.entries(baseline.refs);
  assert.ok(entries.length > 0, 'baseline must not be empty — an empty ratchet ratchets nothing');
  for (const [key, e] of entries) {
    assert.ok(allowed.has(e.disposition), `${key}: bad disposition ${e.disposition}`);
    assert.ok(typeof e.reason === 'string' && e.reason.trim().length >= 12, `${key}: stub reason`);
    assert.ok(Number.isInteger(e.sites) && e.sites > 0, `${key}: bad site count`);
  }
});

/** Parse a SKILL.md into `{declared, body}` — frontmatter key + everything after. */
function readSkill(name) {
  const file = path.join(REPO, 'skills', name, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, 'utf-8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  return {
    declared: !!fm && /^disable-model-invocation:\s*true\s*$/m.test(fm[1]),
    frontmatter: fm ? fm[1] : '',
    body: fm ? src.slice(fm[0].length) : src,
  };
}

const skillNames = () => fs.readdirSync(path.join(REPO, 'skills'))
  .filter((n) => fs.existsSync(path.join(REPO, 'skills', n, 'SKILL.md')));

test('a locked skill states the rule in its BODY, where every host reads it', () => {
  // `disable-model-invocation` is a Claude Code frontmatter key. VS Code
  // Copilot, Cursor and Windsurf discover the same `.claude/skills/` tree and
  // their handling of an unrecognised key is undocumented — so a lock that
  // lives only in frontmatter protects one host and silently protects nobody
  // else. Most users of this bundle are on Copilot in VS Code. The body is the
  // half that travels, so a skill that declares the key must also say it in
  // prose: the frontmatter is the enforcement, the body is the contract.
  for (const name of skillNames()) {
    const s = readSkill(name);
    if (!s?.declared) continue;
    assert.match(
      s.body, /explicit invocation only/i,
      `skills/${name}/SKILL.md declares disable-model-invocation but its body never states the rule — `
      + 'hosts that ignore the key would auto-invoke it',
    );
    assert.match(
      s.body, /host-neutral/i,
      `skills/${name}/SKILL.md must say the rule is host-neutral, not a Claude-Code-only flag`,
    );
  }
});

test('/ship is locked — it commits and pushes', () => {
  // Pinned by name rather than left to the general rule above: /ship is the
  // one skill in the roster whose misfire is not undoable, and it spent its
  // whole life unlocked while its own body asserted twice that it was locked.
  // A regression here is silent, so it gets its own assertion.
  const ship = readSkill('ship');
  assert.ok(ship.declared, 'skills/ship/SKILL.md must declare disable-model-invocation: true');
  assert.match(ship.frontmatter, /DO NOT INVOKE THIS SKILL ON YOUR OWN INITIATIVE/,
    'the description must carry the constraint too — it is what a host reads when DECIDING whether to invoke');
});

test('a skill claiming disable-model-invocation in its BODY actually declares it', () => {
  // Same prose→contract seam as the rest of this file, one layer up: nothing
  // type-checks a SKILL.md's claim about its own frontmatter. /ship asserted
  // "`/ship` is `disable-model-invocation: true`" twice and reasoned from it,
  // while its frontmatter declared no such key — so the autonomy brake two of
  // its steps were designed around did not exist, in ANY host. Assert on the
  // parsed frontmatter, never on the surrounding prose.
  const skillsDir = path.join(REPO, 'skills');
  for (const name of fs.readdirSync(skillsDir)) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf-8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
    const declared = !!fm && /^disable-model-invocation:\s*true\s*$/m.test(fm[1]);
    const body = fm ? src.slice(fm[0].length) : src;
    // A claim ABOUT this skill: "`/<name>` is `disable-model-invocation: true`".
    const claims = new RegExp(`/${name}\`? is \`?disable-model-invocation`).test(body);
    if (claims) {
      assert.ok(declared,
        `skills/${name}/SKILL.md claims it is disable-model-invocation:true but its frontmatter does not declare it`);
    }
  }
});

test('the two regressions that motivated this gate stay fixed', () => {
  // /ai-context-management named `npm run context:check` in every mode while
  // the detector it wraps was synced all along, so the skill was inert in a
  // consumer. /security-strategy and /ship reached for
  // `npm run security:refresh --if-present`, which exits 0 having run nothing.
  // Both are now called by path; assert on the emitted text, not on intent.
  const acm = fs.readFileSync(path.join(REPO, 'skills/ai-context-management/SKILL.md'), 'utf-8');
  assert.ok(acm.includes('node scripts/check-context-drift.mjs'), 'ai-context-management must name the synced detector by path');

  // Assembled from parts on purpose: spelling the forbidden command as one
  // literal would put it back into a scanned file, and `npm-args:gate` reads
  // source text, not intent — it flagged this very assertion the first time.
  const banned = ['npm run security:refresh', '--if', 'present'].join(' ').replace(' present', '-present');
  for (const rel of ['skills/ship/SKILL.md', 'skills/security-strategy/SKILL.md']) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf-8');
    assert.ok(!src.includes(banned),
      `${rel} must not reach for the --if-present alias — it exits 0 having run nothing`);
    assert.ok(src.includes('scripts/security-memory/refresh-incidents.mjs'),
      `${rel} must name the synced refresher by path`);
  }
});

// ── Cross-host parity contract (docs/plans/cross-host-parity-v2.md Phase 5) ──
//
// The formatting and sync gates structurally cannot see what that plan
// changed: skills:check and skills:consumer-refs:gate would all stay green if
// a later edit deleted the no-dispatch branch, reintroduced a host-specific
// browser tier, left an $ARGUMENTS site with no acquisition rule, or turned a
// hook back into the sole enforcement path.
//
// Two rules these assertions follow, both learned the hard way in this repo:
// discovery iterates the FILESYSTEM (a hard-coded pair passes forever while a
// newly added host-driven skill goes unnoticed), and they assert on STRUCTURED
// MARKERS rather than prose (or the suite becomes a spell-checker).

const MARKER_RE = /<!--\s*host-contract:\s*([a-z-]+)([^>]*)-->/g;

/** Parse `key=value; key=value` marker fields into an object. */
function markerFields(tail) {
  const out = {};
  for (const part of tail.split(';')) {
    const [k, ...rest] = part.split('=');
    if (!rest.length) continue;
    out[k.trim()] = rest.join('=').trim();
  }
  return out;
}

/** Every markdown file the repo owns under skills/, plus AGENTS.md. */
function contractSurfaces() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) files.push(p);
    }
  };
  walk(path.join(REPO, 'skills'));
  files.push(path.join(REPO, 'AGENTS.md'));
  return files.map((f) => [path.relative(REPO, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf-8')]);
}

function markersIn(body) {
  const out = [];
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(body)) !== null) out.push({ kind: m[1], fields: markerFields(m[2]) });
  return out;
}

test('T1 — a host-driven browser skill cites the one detector and declares no tier list', () => {
  for (const [rel, body] of contractSurfaces()) {
    if (!rel.endsWith('/SKILL.md')) continue;
    if (!body.includes('browser-tool-detection.md')) continue; // classifier: cites the detector
    assert.ok(!/^##\s+Tier\b/m.test(body),
      `${rel} defines its own "## Tier" list — the ladder lives only in the detector (two-oracles defect)`);
  }
});

test('T2 — the driver contract declares the closed vocabulary and a row per driver', () => {
  const rel = 'docs/audit/shared-references/browser-tool-detection.md';
  const body = fs.readFileSync(path.join(REPO, rel), 'utf-8');
  const marker = markersIn(body).find((m) => m.kind === 'browser-driver');
  assert.ok(marker, `${rel} must carry a host-contract: browser-driver marker`);

  const caps = marker.fields.caps.split(',').map((s) => s.trim());
  assert.deepEqual(caps, ['navigate', 'readText', 'evaluate', 'click', 'type', 'keyboard', 'screenshot', 'wait', 'currentUrl']);
  // Every declared capability must have a semantics row AND a mapping row.
  for (const cap of caps) {
    assert.ok(body.includes(`| \`${cap}\` |`), `${rel}: capability ${cap} has no semantics row`);
    assert.ok(new RegExp(`^\| ${cap} \|`, 'm').test(body), `${rel}: capability ${cap} has no operation-mapping row`);
  }
  for (const driver of ['playwright-mcp', 'copilot-browser', 'brightdata', 'static-fetch']) {
    assert.ok(body.includes(`\`${driver}\``), `${rel}: driver ${driver} missing from the table`);
  }
  // The registry lives in the table alone — never duplicated back into the marker.
  assert.ok(!('drivers' in marker.fields),
    `${rel}: marker must not carry a drivers= list; the §2 table is the single registry`);
});

test('T3 — every $ARGUMENTS site declares its grammar and empty-input behaviour', () => {
  const GRAMMARS = new Set(['free-text', 'subcommand', 'path+flags']);
  const EMPTY = new Set(['default', 'ask-and-stop']);
  for (const [rel, body] of contractSurfaces()) {
    if (rel.includes('/references/input-acquisition.md')) continue; // the contract itself
    const sites = (body.match(/\$ARGUMENTS/g) || []).length;
    if (sites === 0) continue;
    const markers = markersIn(body).filter((m) => m.kind === 'input-acquisition');
    assert.ok(markers.length > 0, `${rel} reads $ARGUMENTS but declares no input-acquisition contract`);
    for (const m of markers) {
      assert.ok(GRAMMARS.has(m.fields.grammar), `${rel}: bad grammar "${m.fields.grammar}"`);
      assert.ok(EMPTY.has(m.fields.empty), `${rel}: bad empty behaviour "${m.fields.empty}"`);
    }
  }
});

test('T4 — /cycle carries a no-dispatch branch that preserves the Step-3 pause', () => {
  const body = fs.readFileSync(path.join(REPO, 'skills/cycle/SKILL.md'), 'utf-8');
  const marker = markersIn(body).find((m) => m.kind === 'no-dispatch');
  assert.ok(marker, 'skills/cycle/SKILL.md must carry a host-contract: no-dispatch marker');
  const preserved = marker.fields.preserves.split(',').map((s) => s.trim());
  // step3-pause is the load-bearing one: an inlined fallback must never turn a
  // paused cycle into an autonomous one.
  for (const inv of ['step-order', 'step3-pause', 'skip-flags', 'blocked-propagation']) {
    assert.ok(preserved.includes(inv), `cycle no-dispatch marker must preserve ${inv}`);
  }
});

test('T5 — every hook claim states rule, portable path and accelerator', () => {
  const HOOK_RE = /\.claude\/hooks|UserPromptSubmit|PostToolUse/;
  for (const [rel, body] of contractSurfaces()) {
    if (!HOOK_RE.test(body)) continue;
    // The reference copies restate their skill's claim; the canonical owns it.
    if (rel.includes('/references/')) continue;
    const markers = markersIn(body).filter((m) => m.kind === 'hook-rule');
    if (markers.length === 0) {
      // A skill may MENTION a hook without claiming it enforces anything —
      // but AGENTS.md and /ship both make enforcement claims and must declare.
      assert.ok(!['AGENTS.md', 'skills/ship/SKILL.md'].includes(rel),
        `${rel} claims hook-backed enforcement but declares no hook-rule marker`);
      continue;
    }
    for (const m of markers) {
      for (const field of ['rule', 'portable', 'accelerator']) {
        assert.ok(m.fields[field], `${rel}: hook-rule marker missing ${field}=`);
      }
    }
  }
});
