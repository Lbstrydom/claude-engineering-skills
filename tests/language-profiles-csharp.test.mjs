import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanCsharpBoundaries, maskLine } from '../scripts/lib/csharp-scanner.mjs';
import { getProfile, getProfileForFile, buildLanguageContext } from '../scripts/lib/language-profiles.mjs';
import { chunkLargeFile, buildDependencyGraph } from '../scripts/lib/code-analysis.mjs';

const scan = (src) => scanCsharpBoundaries(src.split('\n'));
const starts = (src) => scan(src).boundaries.map((i) => src.split('\n')[i].trim());

describe('cs profile', () => {
  it('registers .cs, and only through the taxonomy', () => {
    const p = getProfileForFile('src/Layout/BodyComposer.cs');
    assert.equal(p.id, 'cs');
    assert.deepEqual([...p.extensions], ['.cs']);
    assert.equal(getProfile('cs').id, 'cs');
  });

  it('imports: using directives are extracted; resolveImport is honest ([]), not a fake path resolver', () => {
    const p = getProfile('cs');
    const src = [
      'using System.Text;', 'global using Foo.Bar;', 'using static System.Math;', 'using A = X.Y;',
      'using var f = File.Open("x");', 'namespace N;',
    ].join('\n');
    const re = new RegExp(p.importRegex.source, p.importRegex.flags);
    const got = [];
    let m;
    while ((m = re.exec(src)) !== null) got.push(p.importExtractor(m).namespace);
    assert.deepEqual(got, ['System.Text', 'Foo.Bar', 'System.Math', 'X.Y']);
    assert.deepEqual(p.resolveImport({ kind: 'using', namespace: 'System.Text' }, 'a.cs', new Set(['b.cs']), {}), []);
  });

  it('tools: dotnet-build is project-scoped, --no-incremental and --no-restore, with a probe', () => {
    const [build, format] = getProfile('cs').tools;
    assert.equal(build.id, 'dotnet-build');
    assert.ok(build.args.includes('--no-incremental'), 'an incremental build re-emits no warnings for an up-to-date project');
    assert.ok(build.args.includes('--no-restore'), 'no NuGet network access by default');
    assert.ok(build.args.includes('{project}'));
    assert.deepEqual([...build.projectMarkers], ['.csproj', '.sln', '.slnx']);
    assert.deepEqual([...build.availabilityProbe[1]], ['--version']);
    assert.equal(format.id, 'dotnet-format');
  });

  it('chunking a large .cs file splits at declarations, not at arbitrary lines', () => {
    const body = (n) => Array.from({ length: 40 }, (_, i) => `        var x${n}_${i} = ${i}; // filler line to make the method sizeable`).join('\n');
    const src = ['namespace N;', 'public class A', '{', ...[1, 2, 3, 4].map((n) => `    public void M${n}()\n    {\n${body(n)}\n    }`), '}'].join('\n');
    const chunks = chunkLargeFile(src, 'A.cs', 400);
    assert.ok(chunks.length > 1, 'expected a real split');
    for (const c of chunks.slice(1)) for (const item of c.items) assert.match(item.source, /^\s*(public|\/\/\/|\[)/, 'each chunk item starts at a declaration');
  });

  it('buildDependencyGraph does not throw on C# and yields no edges', () => {
    const g = buildDependencyGraph(['a.cs'], buildLanguageContext(['a.cs']));
    assert.equal(g.get('a.cs').size, 0);
  });
});

describe('scanCsharpBoundaries — structure', () => {
  it('file-scoped namespace, doc comments and attributes are grouped onto their declaration', () => {
    const src = [
      'using System;', '', 'namespace N;', '',
      '/// <summary>A.</summary>', '[Serializable]', 'public class A', '{',
      '    /// <summary>M.</summary>', '    public int M(int x)', '    {', '        return x;', '    }', '}',
    ].join('\n');
    const r = scan(src);
    assert.equal(r.state, 'completed');
    assert.deepEqual(r.boundaries, [4, 8]);
  });

  it('block namespace, nested type, accessors, lambda and object initializer are not member boundaries', () => {
    const src = [
      'namespace N', '{',
      '    public class Outer', '    {',
      '        public int P { get; set; }',
      '        public string Q { get { return "q"; } }',
      '        public void Run()', '        {',
      '            var f = (int x) => { return x; };',
      '            var o = new Foo { A = 1, B = 2 };',
      '        }',
      '        public class Inner', '        {', '            public void InnerM() { }', '        }',
      '    }', '}',
    ].join('\n');
    assert.deepEqual(starts(src), ['public class Outer', 'public void Run()', 'public class Inner', 'public void InnerM() { }']);
  });

  it('a local function inside a method of a file-scoped namespace is NOT a boundary (absolute depth cannot tell)', () => {
    const src = [
      'namespace N;', 'public class A', '{',
      '    public void M()', '    {',
      '        int Local(int x)', '        {', '            return x;', '        }',
      '        Local(1);',
      '    }',
      '}',
    ].join('\n');
    assert.deepEqual(starts(src), ['public class A', 'public void M()']);
  });

  it('records with primary-constructor parameter lists and parameter attributes stay one boundary', () => {
    const src = [
      'public sealed record R(', '    [property: JsonPropertyName("a")] string A,', '    [property: JsonPropertyName("b")] int B);',
      'public sealed record S(int X) { }',
    ].join('\n');
    assert.deepEqual(starts(src), ['public sealed record R(', 'public sealed record S(int X) { }']);
  });

  it('modifier-less members at type scope, constructors, expression-bodied methods and operators', () => {
    const src = [
      'class C', '{',
      '    C() { }',
      '    void Go() => Console.WriteLine();',
      '    public static C operator +(C a, C b) => a;',
      '    public int Field = Compute();',
      '    public int P => Compute();',
      '}',
    ].join('\n');
    assert.deepEqual(starts(src), ['class C', 'C() { }', 'void Go() => Console.WriteLine();', 'public static C operator +(C a, C b) => a;']);
  });

  it('tuple-returning members and explicit-interface members are boundaries (audit R1-M18)', () => {
    const src = ['class C', '{', '    public (int a, int b) Pair()', '    {', '        return (1, 2);', '    }', '    void IFoo.Bar() { }', '}'].join('\n');
    assert.deepEqual(starts(src), ['class C', 'public (int a, int b) Pair()', 'void IFoo.Bar() { }']);
  });

  it('a brace inside a primary-constructor base argument does not consume the pending type scope (audit R1-M8)', () => {
    const src = ['public class A(int x) : Base(new Foo { P = 1 })', '{', '    public void M() { }', '}'].join('\n');
    assert.equal(scan(src).state, 'completed');
    assert.deepEqual(starts(src), ['public class A(int x) : Base(new Foo { P = 1 })', 'public void M() { }']);
  });

  it('ref struct and readonly ref struct declarations are type boundaries (audit R2-M8)', () => {
    const src = ['public ref struct Buffer', '{', '    public int N;', '}', 'public readonly ref struct View', '{', '}'].join('\n');
    assert.deepEqual(starts(src), ['public ref struct Buffer', 'public readonly ref struct View']);
  });

  it('top-level statements are valid and have no boundaries — `completed`, not `degraded`', () => {
    const r = scan('using System;\nConsole.WriteLine("hi");\nvar x = 1;');
    assert.deepEqual(r, { state: 'completed', boundaries: [], reason: null });
  });

  it('an empty file is completed with no boundaries', () => {
    assert.equal(scan('').state, 'completed');
  });
});

describe('scanCsharpBoundaries — the lexer (audit-plan R1-M2 / R3-M2)', () => {
  const wrap = (member) => ['public class A', '{', `    ${member}`, '    public void After() { }', '}'].join('\n');
  const stillBalanced = (member) => {
    const r = scan(wrap(member));
    assert.equal(r.state, 'completed', `${member} → ${r.reason}`);
    assert.ok(starts(wrap(member)).includes('public void After() { }'), `${member}: After() must still be found`);
  };

  const LITERALS = [
    ['regular string holding a brace', 'string s = "{";'],
    ['escaped quote then brace', 'string s = "\\"{";'],
    ['char literal brace', "char c = '{';"],
    ['escaped char literal', "char c = '\\'';"],
    ['verbatim string with brace and doubled quote', 'string s = @"a""{";'],
    ['interpolated with hole and literal {{', 'string s = $"{a}{{";'],
    ['nested string in interpolation hole', 'string s = $"{(x ? "}" : "{")}";'],
    ['interpolated-verbatim $@', 'string s = $@"{a} \\ {{";'],
    ['interpolated-verbatim @$', 'string s = @$"{a} \\ {{";'],
    ['raw string', 'string s = """{""";'],
    ['four-quote raw string holding three quotes', 'string s = """"a"""{"""";'],
    ['one-dollar interpolated raw string', 'string s = $"""{a}""";'],
    ['three-dollar interpolated raw, {{ below the threshold is literal', 'string s = $$$"""{{ not a hole }} {{{a}}}""";'],
    ['block comment holding braces', '/* { */ int x;'],
    ['line comment holding a brace', 'int x; // {'],
  ];
  for (const [name, member] of LITERALS) it(name, () => stillBalanced(member));

  it('a multi-line verbatim string and a multi-line raw string keep their braces out of scope', () => {
    const src = ['public class A', '{', '    string s = @"', '{ not a scope', '";', '    string r = """', '   } also not', '   """;', '    public void After() { }', '}'].join('\n');
    const r = scan(src);
    assert.equal(r.state, 'completed', r.reason);
    assert.ok(starts(src).includes('public void After() { }'));
  });

  it('preprocessor directive lines are erased', () => {
    const src = ['public class A', '{', '#if DEBUG', '    public void D() { }', '#endif', '    public void After() { }', '}'].join('\n');
    assert.equal(scan(src).state, 'completed');
    assert.deepEqual(starts(src), ['public class A', 'public void D() { }', 'public void After() { }']);
  });

  it('maskLine leaves only scope-shaping code', () => {
    const st = [];
    assert.equal(maskLine('int x = "a{b}" + \'}\' + 1; // {', st).replace(/\s+/g, ' ').trim(), 'int x = + + 1;');
    assert.equal(st.length, 0);
  });

  it('a lone unterminated regular string cannot mask the rest of the file', () => {
    const src = ['public class A', '{', '    string s = "oops;', '    public void After() { }', '}'].join('\n');
    assert.equal(scan(src).state, 'completed');
    assert.ok(starts(src).includes('public void After() { }'));
  });
});

describe('scanCsharpBoundaries — degrade, never guess', () => {
  const cases = {
    'missing closing brace': 'public class A\n{\n    public void M() { }\n',
    'extra closing brace': 'public class A { }\n}\n',
    'open block comment': 'public class A { }\n/* never closed\n',
    'open verbatim string': 'public class A { string s = @"never closed;\n}',
    'open raw string': 'public class A { string s = """never closed;\n}',
    'open interpolation hole across EOF': 'public class A { string s = $"{ never closed\n}',
    'a #if that splits a brace pair': 'public class A\n#if X\n{\n#else\n{\n#endif\n}',
  };
  for (const [name, src] of Object.entries(cases)) {
    it(`${name} → degraded with no boundaries and a reason`, () => {
      const r = scan(src);
      assert.equal(r.state, 'degraded');
      assert.deepEqual(r.boundaries, []);
      assert.ok(r.reason);
    });
  }
});

describe('scanCsharpBoundaries — properties over real C#', () => {
  const dirs = [path.resolve('tests/fixtures/csharp')];
  const files = dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.cs')).map((f) => path.join(d, f)) : []));

  it('the fixture corpus is non-empty (negative control: the property loop must not be vacuous)', () => {
    assert.ok(files.length >= 2, `found ${files.length} fixtures`);
  });

  for (const f of files) {
    it(`${path.basename(f)}: boundaries are strictly ascending, in range, and the scan completes`, () => {
      const lines = fs.readFileSync(f, 'utf-8').split('\n');
      const r = scanCsharpBoundaries(lines);
      assert.equal(r.state, 'completed', r.reason);
      assert.ok(r.boundaries.length > 0);
      for (let i = 0; i < r.boundaries.length; i++) {
        assert.ok(r.boundaries[i] >= 0 && r.boundaries[i] < lines.length);
        if (i > 0) assert.ok(r.boundaries[i] > r.boundaries[i - 1]);
      }
      // the chunks preserve every source line, in order
      let rebuilt = [];
      const b = r.boundaries;
      if (b[0] > 0) rebuilt = rebuilt.concat(lines.slice(0, b[0]));
      for (let i = 0; i < b.length; i++) rebuilt = rebuilt.concat(lines.slice(b[i], i + 1 < b.length ? b[i + 1] : lines.length));
      assert.deepEqual(rebuilt, lines);
    });
  }
});
