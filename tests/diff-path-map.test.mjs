/**
 * @fileoverview Tier-1 tests for the diff-path map — the contract the anchor
 * schema has described since day one ("from the diff-path map") but which was
 * never built, so models invented an id and Stage 0 destroyed their findings.
 *
 * Pure functions with crisp I/O ⇒ test-first per AGENTS.md's testing doctrine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  buildDiffPathMap, renderDiffPathTable, prepareCandidates, DIFF_PATH_MAP_BUDGETS,
} from '../scripts/lib/audit/diff-path-map.mjs';
import { makeProducerFindingV3Schema } from '../scripts/lib/schemas.mjs';

const section = (header, body, extra = '') =>
  `diff --git ${header}\n${extra}index 111..222 100644\n${body}\n`;

const MODIFIED = section('a/src/foo.js b/src/foo.js', '--- a/src/foo.js\n+++ b/src/foo.js\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;');
const ADDED = section('a/src/new.js b/src/new.js', '--- /dev/null\n+++ b/src/new.js\n@@ -0,0 +1 @@\n+export const x = 1;', 'new file mode 100644\n');
const DELETED = section('a/src/gone.js b/src/gone.js', '--- a/src/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const y = 2;', 'deleted file mode 100644\n');
const RENAMED = section('a/src/old-name.js b/src/new-name.js', '--- a/src/old-name.js\n+++ b/src/new-name.js\n@@ -1 +1 @@\n-return true;\n+return false;', 'rename from src/old-name.js\nrename to src/new-name.js\n');

describe('buildDiffPathMap — the three-way result (§7j)', () => {
  it('ready: mints opaque ORDINAL ids in diff-header order, never paths (D7)', () => {
    const r = buildDiffPathMap(MODIFIED + ADDED);
    assert.equal(r.kind, 'ready');
    assert.deepEqual(r.entries.map((e) => e.id), ['f0001', 'f0002']);
    // The whole point of D7: an id must NOT be a path. Path-as-id preserves the
    // convention that hid this bug and cannot express a rename at all.
    for (const e of r.entries) assert.ok(!e.id.includes('/'), `id ${e.id} looks like a path`);
  });

  it('derives oldFile/newFile/fileStatus for all five fileStatus values', () => {
    const r = buildDiffPathMap(MODIFIED + ADDED + DELETED + RENAMED);
    assert.equal(r.kind, 'ready');
    assert.deepEqual(r.entries.map((e) => e.fileStatus), ['modified', 'added', 'deleted', 'renamed']);
    // The rename pair is the case NO diffPathId-mirroring band-aid could ever
    // derive — oldPath !== newPath, so one path is not an identity.
    const ren = r.entries[3];
    assert.equal(ren.oldPath, 'src/old-name.js');
    assert.equal(ren.newPath, 'src/new-name.js');
  });

  it('empty: a well-formed but empty diff is a legitimate no-op, NOT invalid', () => {
    for (const input of ['', '   \n  ', null, undefined]) {
      const r = buildDiffPathMap(input);
      assert.equal(r.kind, 'empty', `input ${JSON.stringify(input)}`);
      assert.equal(r.reason, 'no_eligible_diff_files');
    }
  });

  it('invalid: non-empty input that parses to nothing is a FAILED parse, not an empty scope', () => {
    // The §7j distinction that matters: collapsing this into `empty` would let
    // a broken input read as an ordinary no-op — the anti-green class again.
    const r = buildDiffPathMap('this is not a diff at all\njust some prose\n');
    assert.equal(r.kind, 'invalid');
    assert.equal(r.reason, 'malformed_diff_header');
  });

  it('invalid: over-budget FAILS LOUD and is never truncated (§8a)', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      section(`a/src/f${i}.js b/src/f${i}.js`, `--- a/src/f${i}.js\n+++ b/src/f${i}.js\n@@ -1 +1 @@\n-a\n+b`)).join('');
    const r = buildDiffPathMap(many, { maxMapEntries: 3 });
    assert.equal(r.kind, 'invalid');
    assert.equal(r.reason, 'discovery_map_exceeds_budget');
    // Truncating would make real changed files unauditable while reporting
    // success — the precise failure this plan exists to remove.
    assert.match(r.detail, /not truncated/);
  });

  it('invalid: the DECLARED maxPromptTableBytes budget is actually ENFORCED (round-1 code-audit M1/M3)', () => {
    // JSON.stringify-encoding the path column (§4.2a) can only ever increase
    // the rendered byte count, so an unenforced budget is more reachable, not
    // equally-distant debt, once decoded paths are involved.
    const r = buildDiffPathMap(MODIFIED, { maxMapEntries: 10, maxPromptTableBytes: 5 });
    assert.equal(r.kind, 'invalid');
    assert.equal(r.reason, 'discovery_map_exceeds_budget');
    assert.match(r.detail, /maxPromptTableBytes/);
    assert.match(r.detail, /not truncated/);
  });

  it('inherits the parser\'s accepted debt SAFELY: an unparseable header mints no id', () => {
    // A file the header regex can't parse simply has no entry, so no anchor can
    // cite it (§7i's inherited debt, failure direction preserved).
    const r = buildDiffPathMap(MODIFIED);
    assert.equal(r.entries.length, 1);
  });

  it('a quoted path (spaces) still parses — the G3 fix is inherited, not re-implemented', () => {
    const quoted = section('"a/src/has space.js" "b/src/has space.js"', '--- "a/src/has space.js"\n+++ "b/src/has space.js"\n@@ -1 +1 @@\n-a\n+b');
    const r = buildDiffPathMap(quoted);
    assert.equal(r.kind, 'ready');
    assert.equal(r.entries[0].newPath, 'src/has space.js');
  });

  it('the default budget is a real ceiling, not a placeholder', () => {
    assert.ok(DIFF_PATH_MAP_BUDGETS.maxMapEntries > 0);
    assert.match(DIFF_PATH_MAP_BUDGETS.calibrationNote, /[Rr]ecalibrate/);
  });

  it('invalid: undecodable_diff_header when a real diff --git header cannot be resolved (§4.2) — loud, never a silently missing file', () => {
    // Deliberately SYNTHETIC (round-2 code-audit M4): no real `git diff`
    // invocation emits an unquoted `modified`-status header with two
    // DIFFERENT old/new paths and no rename/copy metadata — a modified file
    // always has old===new; only rename/copy produces old!==new, and those
    // always carry dedicated `rename from`/`rename to` lines (§2 decision 5
    // rule 2). This hand-constructed header exercises the fail-closed rule 4
    // path (§2 decision 5) that no current producer in this repo reaches,
    // proving the parser degrades loudly rather than guessing if one ever did.
    const undecodable = section('a/left.js b/right.js', '--- a/left.js\n+++ b/right.js\n@@ -1 +1 @@\n-a\n+b');
    const r = buildDiffPathMap(MODIFIED + undecodable);
    assert.equal(r.kind, 'invalid');
    assert.equal(r.reason, 'undecodable_diff_header');
    assert.match(r.detail, /1 header/);
  });

  it('seam: a real git-quoted header (escaped char + octal-escaped UTF-8) yields a map entry with the DECODED path', () => {
    const decodeCase = section('"a/quo\\"te.js" "b/quo\\"te.js"', '--- "a/quo\\"te.js"\n+++ "b/quo\\"te.js"\n@@ -1 +1 @@\n-a\n+b');
    const octalCase = section('"a/caf\\303\\251.js" "b/caf\\303\\251.js"', '--- "a/caf\\303\\251.js"\n+++ "b/caf\\303\\251.js"\n@@ -1 +1 @@\n-a\n+b');
    const r = buildDiffPathMap(decodeCase + octalCase);
    assert.equal(r.kind, 'ready');
    assert.deepEqual(r.entries.map((e) => e.newPath), ['quo"te.js', 'café.js']);
    assert.deepEqual(r.entries.map((e) => e.id), ['f0001', 'f0002'], 'ordinal ids, unaffected by decoding');
  });

  it('seam: defect #3 end to end — the whole failure chain in the plan\'s §1, pinned', () => {
    const defect3 = section('a/x b/y.js b/x b/y.js', '--- a/x b/y.js\n+++ a/x b/y.js\n@@ -1 +1 @@\n-a\n+b');
    const r = buildDiffPathMap(defect3);
    assert.equal(r.kind, 'ready');
    assert.equal(r.entries[0].oldPath, 'x b/y.js');
    assert.equal(r.entries[0].newPath, 'x b/y.js');
  });
});

describe('renderDiffPathTable — the prompt table and the enum share one source (D7)', () => {
  it('renders every entry, showing both paths only for a rename', () => {
    const { entries } = buildDiffPathMap(MODIFIED + RENAMED);
    const t = renderDiffPathTable(entries);
    assert.match(t, /f0001\tmodified\t"src\/foo\.js"/);
    assert.match(t, /f0002\trenamed\t"src\/old-name\.js" -> "src\/new-name\.js"/);
    for (const e of entries) assert.ok(t.includes(e.id), `table must offer ${e.id}`);
  });

  it('encodes control characters in the path so no filename can forge a row or column boundary (§4.2a)', () => {
    const entries = [
      { id: 'f0001', oldPath: 'a\nb\tc"d\\e.js', newPath: 'a\nb\tc"d\\e.js', fileStatus: 'modified' },
    ];
    const t = renderDiffPathTable(entries);
    const rows = t.split('\n');
    assert.equal(rows.length, 2, 'header row + exactly one entry row — no forged row from the embedded newline');
    assert.equal(rows[1].split('\t').length, 3, 'exactly id/status/path columns — no forged column from the embedded tab');
    assert.ok(rows[1].includes(JSON.stringify('a\nb\tc"d\\e.js')), 'the path is JSON-encoded, control characters re-escaped');
  });
});

describe('prepareCandidates — the untrusted producer boundary (D6, §7g)', () => {
  const map = buildDiffPathMap(MODIFIED + ADDED + DELETED);
  const producerSchema = makeProducerFindingV3Schema(map.entries.map((e) => e.id));
  const base = {
    id: 'H1', severity: 'HIGH', category: 'c', section: 's', detail: 'd', risk: 'r',
    recommendation: 'rec', is_quick_fix: false, is_mechanical: false, principle: 'p',
    classification: { sonarType: 'CODE_SMELL', effort: 'TRIVIAL', sourceKind: 'MODEL', sourceName: 'sonnet' },
  };
  const commission = (anchor) => ({ ...base, evidenceType: 'commission', anchor });
  const anchor = (over = {}) => ({ diffPathId: 'f0001', side: 'head', startLine: 1, endLine: 1, quote: 'const a = 2;', ...over });
  const run = (raw) => prepareCandidates(raw, map, { producerSchema, headSha: 'WORKTREE' });

  it('hydrates paths + fileStatus from OUR map — the model never supplies them', () => {
    const [r] = run([commission(anchor())]);
    assert.equal(r.kind, 'ready');
    assert.equal(r.finding.anchor.oldFile, 'src/foo.js');
    assert.equal(r.finding.anchor.newFile, 'src/foo.js');
    assert.equal(r.finding.anchor.fileStatus, 'modified');
    assert.equal(r.finding.anchor.headSha, 'WORKTREE');
  });

  it('an added file gets newFile only; a deleted file gets oldFile only', () => {
    const [add] = run([commission(anchor({ diffPathId: 'f0002', quote: 'export const x = 1;' }))]);
    assert.equal(add.finding.anchor.oldFile, null);
    assert.equal(add.finding.anchor.newFile, 'src/new.js');
    const [del] = run([commission(anchor({ diffPathId: 'f0003', side: 'base', quote: 'export const y = 2;' }))]);
    assert.equal(del.finding.anchor.oldFile, 'src/gone.js');
    assert.equal(del.finding.anchor.newFile, null);
  });

  it('CONTRADICTED is its own KIND — not a reasonCode inside malformed (D2a, §7a)', () => {
    // side:'base' on an ADDED file: a model claim the diff DISPROVES.
    // This originally returned kind:'malformed' with a differing reasonCode,
    // so the pipeline's raw counter billed a disproved model claim as OUR
    // contract bug — this plan's own misattribution, inverted. The KIND carries
    // the attribution; a reasonCode is not a substitute for it.
    const [r] = run([commission(anchor({ diffPathId: 'f0002', side: 'base' }))]);
    assert.equal(r.kind, 'contradicted', 'must NOT be malformed — that would blame our contract for the model\'s error');
    assert.equal(r.reasonCode, 'producer_side_contradicted');
    assert.match(r.reasonDetail, /impossible for a 'added' file/);
  });

  it('the two owners never blend: a DTO failure is malformed, a side conflict is contradicted', () => {
    const results = run([
      commission(anchor({ side: 'sideways' })),                    // DTO invalid  -> ours
      commission(anchor({ diffPathId: 'f0002', side: 'base' })),   // diff refutes -> model's
    ]);
    assert.equal(results[0].kind, 'malformed');
    assert.equal(results[1].kind, 'contradicted');
  });

  it('MALFORMED on an unknown id — the enum is a funnel, NOT a trust boundary (D6)', () => {
    // Bypasses the enum deliberately: provider enforcement is exactly what this
    // bug proved cannot be relied on.
    const loose = z.object({}).passthrough();
    const [r] = prepareCandidates([commission(anchor({ diffPathId: 'f9999' }))], map, { producerSchema: loose });
    assert.equal(r.kind, 'malformed');
    assert.match(r.reasonDetail, /unknown diffPathId/);
  });

  it('hostile input degrades ITSELF, never the batch, and never throws', () => {
    const results = run([
      commission(anchor()),            // good
      null,                            // hostile
      { evidenceType: 'commission' },  // missing anchor
      commission(anchor({ side: 'sideways' })),
      commission(anchor({ startLine: 0 })),
      'not an object',
      commission(anchor()),            // good — must survive its neighbours
    ]);
    assert.equal(results.length, 7);
    assert.equal(results[0].kind, 'ready');
    assert.equal(results[6].kind, 'ready', 'one bad candidate must not take out the batch');
    for (const i of [1, 2, 3, 4, 5]) assert.equal(results[i].kind, 'malformed', `index ${i}`);
  });

  it('rawIndex ties every result back to its raw finding (the accounting identity, §7g)', () => {
    const results = run([null, commission(anchor()), null]);
    assert.deepEqual(results.map((r) => r.rawIndex), [0, 1, 2]);
  });

  it('non-array input yields no candidates rather than throwing', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) assert.deepEqual(run(bad), []);
  });

  it('refuses a non-ready map loudly — the caller MUST handle empty/invalid first (§7j)', () => {
    assert.throws(() => prepareCandidates([], buildDiffPathMap(''), { producerSchema }), /must be \{kind:'ready'\}/);
    assert.throws(() => prepareCandidates([], buildDiffPathMap('prose'), { producerSchema }), /must be \{kind:'ready'\}/);
  });
});
