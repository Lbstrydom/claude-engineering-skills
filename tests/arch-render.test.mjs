import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeMarkdown,
  escapeMermaidLabel,
  mermaidId,
  renderMermaidContainer,
  groupByDomain,
  renderArchitectureMap,
  renderNeighbourhoodCallout,
  renderDriftIssue,
} from '../scripts/lib/arch-render.mjs';
import { DEFAULT_EXT_ALLOWLIST } from '../scripts/lib/sensitive-egress-gate.mjs';

describe('escapeMarkdown', () => {
  it('escapes pipes', () => assert.equal(escapeMarkdown('a|b'), 'a\\|b'));
  it('strips newlines', () => assert.equal(escapeMarkdown('a\nb'), 'a b'));
  it('handles null/undefined', () => assert.equal(escapeMarkdown(null), ''));
});

describe('escapeMermaidLabel', () => {
  it('strips angle brackets and pipes', () => {
    assert.equal(escapeMermaidLabel('foo<bar|baz>'), 'foo bar baz ');
  });
  it('caps length', () => {
    assert.ok(escapeMermaidLabel('x'.repeat(120)).length <= 60);
  });
});

describe('mermaidId — collisions merge nodes silently', () => {
  // Deferred at audit round 1, fixed here. Mermaid MERGES nodes sharing an id,
  // so every collision below used to drop a symbol from the diagram while the
  // flat table kept listing it — a picture that looks complete and is not.

  it('normalisation no longer collides: a-b.mjs vs a_b.mjs', () => {
    // Both collapse to the same stem; only the digest separates them now.
    assert.notEqual(mermaidId('file', 'a-b.mjs'), mermaidId('file', 'a_b.mjs'));
  });

  it('truncation no longer collides: keys sharing their first 40 chars', () => {
    const shared = 'src/very/deeply/nested/module/path/aaaaaaaa';
    assert.ok(shared.length >= 40, 'fixture must exceed the 40-char cut');
    assert.notEqual(mermaidId('file', `${shared}/one.mjs`), mermaidId('file', `${shared}/two.mjs`));
  });

  it('two records sharing file + symbolName are distinct via uniqueKey', () => {
    // Overloads, re-exports and a re-indexed rename all produce this shape.
    const a = mermaidId('sym', 'lib/x.mjs_foo', 'id-aaa');
    const b = mermaidId('sym', 'lib/x.mjs_foo', 'id-bbb');
    assert.notEqual(a, b);
  });

  it('is deterministic — same input yields the same id', () => {
    // The byte-determinism guarantee of the whole map rests on this.
    assert.equal(mermaidId('file', 'a/b.mjs'), mermaidId('file', 'a/b.mjs'));
    assert.equal(mermaidId('sym', 'k', 'u'), mermaidId('sym', 'k', 'u'));
  });

  it('emits only characters Mermaid accepts in an identifier', () => {
    const id = mermaidId('sym', 'a/b-c.mjs::weird name!', 'x');
    assert.match(id, /^[A-Za-z0-9_]+$/);
  });

  it('renderMermaidContainer emits unique node ids for colliding inputs', () => {
    // End-to-end: the unit guarantee is worthless if a call site drops uniqueKey.
    const symbols = [
      { id: 's1', symbolName: 'foo', filePath: 'a-b.mjs', startLine: 1, endLine: 2 },
      { id: 's2', symbolName: 'foo', filePath: 'a_b.mjs', startLine: 1, endLine: 2 },
      { id: 's3', symbolName: 'foo', filePath: 'a_b.mjs', startLine: 9, endLine: 9 },
    ];
    const out = renderMermaidContainer('dom', symbols);
    const symIds = [...out.matchAll(/^\s{2}(sym_[A-Za-z0-9_]+)\[/gm)].map(m => m[1]);
    assert.equal(symIds.length, 3, 'every symbol must emit a node');
    assert.equal(new Set(symIds).size, 3, 'no two symbol nodes may share an id');
  });
});

describe('groupByDomain', () => {
  it('groups by domainTag with stable ordering', () => {
    const symbols = [
      { domainTag: 'b', filePath: 'b.mjs', symbolName: 'y' },
      { domainTag: 'a', filePath: 'a.mjs', symbolName: 'x' },
      { domainTag: 'a', filePath: 'a.mjs', symbolName: 'w' },
    ];
    const g = groupByDomain(symbols);
    assert.deepEqual([...g.keys()], ['a', 'b']);
    assert.equal(g.get('a').length, 2);
    assert.equal(g.get('a')[0].symbolName, 'w');
  });
  it('sends untagged to _other', () => {
    const g = groupByDomain([{ filePath: 'x.mjs', symbolName: 'a' }]);
    assert.ok(g.has('_other'));
  });
});

describe('renderArchitectureMap — partial-coverage banner', () => {
  const base = {
    repoName: 'r', generatedAt: '2026-05-01T00:00:00Z', commitSha: 'abc1234',
    refreshId: '00000000-0000-4000-8000-000000000001',
    drift: 0, threshold: 20, status: 'GREEN', symbols: [], violations: [],
  };

  it('warns when the repo carries unindexed symbol-bearing sources', () => {
    // Sibling of the Truncated banner: both mean "this document is
    // incomplete". A map that reads complete while covering half a repo is
    // the failure — a reader takes "absent" for "does not exist".
    const { markdown } = renderArchitectureMap({ ...base, unindexedStackKinds: ['python'] });
    assert.match(markdown, /Partial coverage/);
    assert.match(markdown, /python/);
    assert.match(markdown, /JS\/TS portion ONLY/);
  });

  it('names every unindexed kind, not just the first', () => {
    const { markdown } = renderArchitectureMap({
      ...base, unindexedStackKinds: ['python', 'java'],
    });
    assert.match(markdown, /python, java/);
  });

  it('states the allowlist DERIVED from the extractor, not a hardcoded copy', () => {
    // Round-2 audit finding: the module imports the allowlist as its single
    // source of truth and then restated it in prose — the exact drift the
    // import exists to prevent. Pin the derivation: widening the extractor
    // must change what the banner tells the reader.
    const { markdown } = renderArchitectureMap({ ...base, unindexedStackKinds: ['python'] });
    for (const ext of DEFAULT_EXT_ALLOWLIST) {
      assert.ok(markdown.includes(ext), `banner must name ${ext} from the real allowlist`);
    }
  });

  it('is SILENT for a pure JS/TS repo — a banner that always fires is unread', () => {
    const { markdown } = renderArchitectureMap({ ...base, unindexedStackKinds: [] });
    assert.doesNotMatch(markdown, /Partial coverage/);
  });

  it('defaults to silent when the caller omits the field entirely', () => {
    // Back-compat: every existing call site predates this parameter.
    const { markdown } = renderArchitectureMap({ ...base });
    assert.doesNotMatch(markdown, /Partial coverage/);
  });
});

describe('renderArchitectureMap', () => {
  it('starts with the sticky marker', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: '2026-05-01T00:00:00Z', commitSha: 'abc1234',
      refreshId: '00000000-0000-4000-8000-000000000001',
      drift: 0, threshold: 20, status: 'GREEN',
      symbols: [], violations: [],
    });
    assert.ok(markdown.startsWith('<!-- audit-loop:architectural-map -->'));
  });
  it('includes timestamp + commit + refresh_id in header', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: '2026-05-01T00:00:00Z', commitSha: 'abc1234',
      refreshId: '00000000-0000-4000-8000-000000000001',
      drift: 0, threshold: 20, status: 'GREEN',
      symbols: [], violations: [],
    });
    assert.match(markdown, /Generated: \d{4}-\d{2}-\d{2}T.*commit: [0-9a-f]{7,}.*refresh_id: [0-9a-f-]{36}/);
  });
  it('includes drift score line', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: '2026-05-01T00:00:00Z', commitSha: 'abc',
      refreshId: 'rid', drift: 5, threshold: 20, status: 'GREEN',
      symbols: [], violations: [],
    });
    assert.match(markdown, /Drift score: \d+ \/ threshold \d+/);
  });
  it('includes "How to regenerate" + "How to interpret" footers', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: 't', commitSha: 'c', refreshId: 'r',
      drift: 0, threshold: 20, status: 'GREEN',
      symbols: [], violations: [],
    });
    assert.ok(markdown.includes('## How to regenerate'));
    assert.ok(markdown.includes('## How to interpret'));
  });
  it('marks duplicates with [DUP] in table and dup class in mermaid', () => {
    const symbols = [
      { id: 'a', symbolName: 'foo', kind: 'function', filePath: 'a.mjs', startLine: 1, endLine: 2, purposeSummary: '' },
      { id: 'b', symbolName: 'bar', kind: 'function', filePath: 'b.mjs', startLine: 1, endLine: 2, purposeSummary: '' },
    ];
    const dups = new Set(['a', 'b']);
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: 't', commitSha: 'c', refreshId: 'rid',
      drift: 5, threshold: 20, status: 'AMBER',
      symbols, violations: [], dupSymbolIds: dups,
    });
    assert.ok(markdown.includes('[DUP]'));
    assert.ok(markdown.includes(':::dup'));
  });
  it('every classDef has both fill: and color:', () => {
    const { markdown } = renderArchitectureMap({
      repoName: 'r', generatedAt: 't', commitSha: 'c', refreshId: 'rid',
      drift: 0, threshold: 20, status: 'GREEN',
      symbols: [{ id: 'x', symbolName: 'x', kind: 'function', filePath: 'a.mjs', startLine: 1, endLine: 2 }],
      violations: [],
    });
    const classDefs = (markdown.match(/^classDef [^\n]+$/gm) || []);
    assert.ok(classDefs.length > 0);
    for (const c of classDefs) {
      assert.ok(c.includes('fill:'), `classDef missing fill: ${c}`);
      assert.ok(c.includes('color:'), `classDef missing color: ${c}`);
    }
  });
  it('is byte-deterministic for identical input', () => {
    const args = {
      repoName: 'r', generatedAt: '2026-05-01T00:00:00Z', commitSha: 'abc',
      refreshId: 'rid', drift: 0, threshold: 20, status: 'GREEN',
      symbols: [
        { id: 'b', symbolName: 'b', kind: 'function', filePath: 'b.mjs', startLine: 1, endLine: 2 },
        { id: 'a', symbolName: 'a', kind: 'function', filePath: 'a.mjs', startLine: 1, endLine: 2 },
      ],
      violations: [],
    };
    const r1 = renderArchitectureMap(args).markdown;
    const r2 = renderArchitectureMap(args).markdown;
    assert.equal(r1, r2);
  });
});

describe('renderNeighbourhoodCallout', () => {
  it('cloud-off state includes refresh hint', () => {
    const { markdown } = renderNeighbourhoodCallout({ records: [], cloudStatus: 'cloud-off' });
    assert.ok(markdown.includes('npm run arch:refresh'));
  });
  it('error state includes "consultation failed"', () => {
    const { markdown } = renderNeighbourhoodCallout({ records: [], cloudStatus: 'error', hint: 'RPC_ERROR' });
    assert.match(markdown, /consultation failed/);
  });
  it('empty records emits "No near-duplicates found"', () => {
    const { markdown } = renderNeighbourhoodCallout({
      records: [], cloudStatus: 'ok', targetPaths: ['x.mjs'],
    });
    assert.match(markdown, /No near-duplicates found/);
  });
  // ── unindexed file types — absence of evidence vs evidence of absence ────
  //
  // AGENTS.md makes this consultation mandatory before writing a new symbol
  // and reads empty records as "proceed greenfield". For a .py/.java target
  // there are no rows to match because nothing was ever indexed, so the
  // greenfield wording would be a confident wrong answer — and would invite
  // exactly the duplicate arch-memory exists to prevent.
  it('empty records for an UNINDEXED path must NOT say greenfield', () => {
    const { markdown } = renderNeighbourhoodCallout({
      records: [], cloudStatus: 'ok', targetPaths: ['api/users.py'],
    });
    assert.doesNotMatch(markdown, /greenfield/i);
    assert.doesNotMatch(markdown, /No near-duplicates found/);
    assert.match(markdown, /not indexed/i);
    assert.match(markdown, /absence of evidence/i);
    assert.match(markdown, /api\/users\.py/);
  });

  it('empty records for an INDEXED path still says greenfield (no false alarm)', () => {
    const { markdown } = renderNeighbourhoodCallout({
      records: [], cloudStatus: 'ok', targetPaths: ['lib/x.mjs'],
    });
    assert.match(markdown, /greenfield/i);
    assert.doesNotMatch(markdown, /not indexed/i);
  });

  it('a mixed target list warns even when the JS half returned records', () => {
    const { markdown } = renderNeighbourhoodCallout({
      cloudStatus: 'ok',
      targetPaths: ['lib/x.mjs', 'api/users.py'],
      totalCandidatesConsidered: 1,
      records: [{
        symbolName: 'foo', filePath: 'lib/x.mjs', startLine: 10,
        kind: 'function', purposeSummary: 'does foo',
        similarityScore: 0.91, hopScore: 1.0, score: 0.95, recommendation: 'reuse',
      }],
    });
    const partialLine = markdown.split('\n').find(l => l.includes('Partial'));
    assert.ok(partialLine, 'expected a Partial caveat line');
    assert.match(partialLine, /api\/users\.py/);
    // The INDEXED path must not be named as unindexed — the caveat has to be
    // precise about which target it disclaims, or it just reads as noise.
    assert.doesNotMatch(partialLine, /lib\/x\.mjs/);
  });

  it('non-empty emits a blockquote callout starting with "Neighbourhood considered"', () => {
    const { markdown } = renderNeighbourhoodCallout({
      cloudStatus: 'ok',
      targetPaths: ['x.mjs'],
      totalCandidatesConsidered: 1,
      records: [{
        symbolName: 'foo', filePath: 'lib/x.mjs', startLine: 10,
        kind: 'function', purposeSummary: 'does foo',
        similarityScore: 0.91, hopScore: 1.0, score: 0.95, recommendation: 'reuse',
      }],
    });
    assert.match(markdown, /^> \*\*Neighbourhood considered\*\*/);
  });
});

describe('renderDriftIssue', () => {
  it('starts with sticky marker', () => {
    const { markdown } = renderDriftIssue({
      drift: { score: 25 }, threshold: 20, status: 'RED',
      generatedAt: '2026-05-01T00:00:00Z', commitSha: 'abc', refreshId: 'rid',
      repoName: 'r',
    });
    assert.ok(markdown.startsWith('<!-- audit-loop:architectural-drift -->'));
  });
  it('collapses long tail under <details>', () => {
    const clusters = Array.from({ length: 8 }, (_, i) => ({
      label: `cluster ${i}`, similarity: 0.9, members: [{ symbolName: `s${i}`, filePath: 'a.mjs' }],
    }));
    const { markdown, longTailHidden } = renderDriftIssue({
      drift: { score: 30 }, threshold: 20, status: 'RED',
      generatedAt: 't', commitSha: 'c', refreshId: 'r',
      repoName: 'x', clusters,
    });
    assert.ok(markdown.includes('<details>'));
    assert.ok(markdown.match(/<summary>Long tail/));
    assert.equal(longTailHidden, 3);
  });
});
