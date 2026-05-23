/**
 * @fileoverview Tests for scripts/lint-plan-mermaid.mjs.
 *
 * The linter's load-bearing rule: subgraph IDs must not appear as edge
 * endpoints. Caught real-world by `docs/plans/liveness-and-canonical-paths.md`
 * — that diagram renders on GitHub but flashes-then-fails in VS Code's
 * stricter preview.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../scripts/lint-plan-mermaid.mjs';

const { extractMermaidBlocks, parseGraphBlock, ruleSubgraphAsEdgeEndpoint } = _internals;

describe('extractMermaidBlocks', () => {
  it('returns [] when no mermaid blocks are present', () => {
    assert.deepEqual(extractMermaidBlocks('# heading\n\nplain prose.\n'), []);
  });

  it('extracts a single block with its starting line', () => {
    const md = [
      '# title',                  // line 1
      '',                          // 2
      'intro',                     // 3
      '',                          // 4
      '```mermaid',                // 5  ← startLine
      'graph LR',                  // 6
      '  A --> B',                 // 7
      '```',                       // 8
      '',                          // 9
      'after',                     // 10
    ].join('\n');
    const blocks = extractMermaidBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].startLine, 5);
    assert.match(blocks[0].body, /graph LR\n\s+A --> B/);
  });

  it('extracts multiple blocks correctly', () => {
    const md = '```mermaid\ngraph LR\nA --> B\n```\n\nprose\n\n```mermaid\nflowchart TD\nX --> Y\n```\n';
    const blocks = extractMermaidBlocks(md);
    assert.equal(blocks.length, 2);
  });

  it('ignores non-mermaid fenced code blocks', () => {
    const md = '```js\nconst x = 1;\n```\n\n```mermaid\ngraph LR\nA --> B\n```\n';
    const blocks = extractMermaidBlocks(md);
    assert.equal(blocks.length, 1);
  });
});

describe('parseGraphBlock', () => {
  it('returns null for non-graph diagrams', () => {
    assert.equal(parseGraphBlock('sequenceDiagram\n  A->>B: hi'), null);
    assert.equal(parseGraphBlock('erDiagram\n  USER ||--o{ POST : authors'), null);
    assert.equal(parseGraphBlock('stateDiagram-v2\n  [*] --> Idle'), null);
  });

  it('accepts both graph and flowchart with all directions', () => {
    for (const header of ['graph LR', 'graph TD', 'graph RL', 'graph BT',
                          'flowchart LR', 'flowchart TD']) {
      const parsed = parseGraphBlock(`${header}\n  A --> B`);
      assert.ok(parsed, `should accept "${header}"`);
      assert.ok(['graph', 'flowchart'].includes(parsed.kind));
    }
  });

  it('collects subgraph IDs', () => {
    const parsed = parseGraphBlock(
      'graph LR\n' +
      '  subgraph WS_LIVE["WS-LIVE — pipeline liveness (arch-memory)"]\n' +
      '    R1[node]\n' +
      '  end\n' +
      '  subgraph WS_CANON\n' +
      '    G[gate]\n' +
      '  end\n'
    );
    assert.ok(parsed.subgraphs.has('WS_LIVE'));
    assert.ok(parsed.subgraphs.has('WS_CANON'));
  });

  it('collects node IDs from edge declarations', () => {
    const parsed = parseGraphBlock(
      'graph LR\n' +
      '  R1[scripts/symbol-index/refresh.mjs<br/>main + CLI]\n' +
      '  R1 --> SP[scripts/lib/subprocess.mjs<br/>NEW]\n'
    );
    assert.ok(parsed.nodes.has('R1'));
    assert.ok(parsed.nodes.has('SP'));
  });

  it('captures edges with text labels and various arrow shapes', () => {
    const parsed = parseGraphBlock(
      'graph LR\n' +
      '  A --> B\n' +
      '  B -->|some text| C\n' +    // pipe-label form (valid Mermaid)
      '  C -.-> D\n' +
      '  D -.- E\n' +
      '  E ==> F\n'
    );
    const lhsSet = new Set(parsed.edges.map(e => e.lhs));
    const rhsSet = new Set(parsed.edges.map(e => e.rhs));
    for (const id of ['A', 'B', 'C', 'D', 'E']) assert.ok(lhsSet.has(id), `LHS missing: ${id}`);
    for (const id of ['B', 'C', 'D', 'E', 'F']) assert.ok(rhsSet.has(id), `RHS missing: ${id}`);
  });

  it('ignores %% line comments', () => {
    const parsed = parseGraphBlock(
      'graph LR\n' +
      '  %% this is a comment with subgraph WS_FOO inside\n' +
      '  A --> B\n'
    );
    assert.equal(parsed.subgraphs.size, 0);
    assert.equal(parsed.edges.length, 1);
  });
});

describe('ruleSubgraphAsEdgeEndpoint (load-bearing)', () => {
  it('flags subgraph used as LHS of an edge (the liveness-plan bug)', () => {
    const parsed = parseGraphBlock(
      'graph LR\n' +
      '  subgraph WS_LIVE["WS-LIVE — pipeline"]\n' +
      '    R1[refresh.mjs]\n' +
      '  end\n' +
      '  note1[caption]\n' +
      '  WS_LIVE -.- note1\n'
    );
    const issues = ruleSubgraphAsEdgeEndpoint(parsed, 0);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].rule, 'subgraph-as-edge-endpoint');
    assert.equal(issues[0].severity, 'ERROR');
    assert.match(issues[0].message, /WS_LIVE/);
    assert.match(issues[0].message, /subgraph ID/);
  });

  it('flags subgraph used as RHS of an edge', () => {
    const parsed = parseGraphBlock(
      'graph LR\n' +
      '  subgraph Inner\n' +
      '    A[node]\n' +
      '  end\n' +
      '  X[external]\n' +
      '  X --> Inner\n'
    );
    const issues = ruleSubgraphAsEdgeEndpoint(parsed, 0);
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /Inner/);
  });

  it('passes when edges only target real nodes (the fixed liveness plan)', () => {
    const parsed = parseGraphBlock(
      'graph LR\n' +
      '  subgraph WS_LIVE["WS-LIVE — pipeline"]\n' +
      '    R1[refresh.mjs]\n' +
      '  end\n' +
      '  subgraph WS_CANON\n' +
      '    G[gate]\n' +
      '  end\n' +
      '  note1[caption]\n' +
      '  R1 -.- note1\n' +
      '  G  -.- note1\n'
    );
    const issues = ruleSubgraphAsEdgeEndpoint(parsed, 0);
    assert.equal(issues.length, 0);
  });

  it('correctly applies fileLineOffset (1-based line numbers in the file)', () => {
    const parsed = parseGraphBlock(
      'graph LR\n' +    // intra-block line 1
      '  subgraph SG\n' + // 2
      '    A[n]\n' +    // 3
      '  end\n' +       // 4
      '  B --> SG\n'    // 5  ← issue here
    );
    const issues = ruleSubgraphAsEdgeEndpoint(parsed, 100);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].lineNo, 105, 'should be 100 (offset) + 5 (intra-block)');
  });
});
