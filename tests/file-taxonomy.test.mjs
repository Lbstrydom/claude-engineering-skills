import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchFileKind, fenceLanguageFor, extensionLabel, languageById, languageForExtension,
  LANGUAGES, SOURCE_CODE_EXTENSIONS, DECLARATIVE_EXTENSIONS, NON_CODE_EXTENSIONS, AUDITABLE_EXTENSIONS,
} from '../scripts/lib/file-taxonomy.mjs';
import { classifyFileCoverage, getAllProfiles } from '../scripts/lib/language-profiles.mjs';
import { resolveReferenceExtension, PLAN_REFERENCE_EXTENSIONS } from '../scripts/lib/plan-paths.mjs';

// Table-driven precedence matrix (audit-plan R1-M3): exact names, then compound
// suffixes, then the last extension, then `uncovered`. Path only.
const MATRIX = [
  // [path, kind, language]
  ['src/Foo.cs', 'source', 'cs'],
  ['src/FOO.CS', 'source', 'cs'],
  ['a.mjs', 'source', 'js'],
  ['a.cjs', 'source', 'js'],
  ['a.mts', 'source', 'ts'],
  ['a.cts', 'source', 'ts'],
  ['stubs/a.pyi', 'source', 'py'],
  ['main.go', 'source', 'go'],
  ['lib.rs', 'source', 'rs'],
  ['App.csproj', 'declarative', null],
  ['Directory.Build.props', 'declarative', null],
  ['x.sln', 'declarative', null],
  ['app.config', 'declarative', null],
  ['a.json', 'declarative', null],
  ['ci.yml', 'declarative', null],
  ['Dockerfile', 'declarative', null],
  ['.editorconfig', 'declarative', null],
  ['.gitignore', 'declarative', null],
  ['public/index.html.template', 'declarative', null],
  ['a.png', 'non-code', null],
  ['x.woff2', 'non-code', null],
  ['package-lock.json', 'non-code', null],   // lockfile beats the .json extension
  ['sub/packages.lock.json', 'non-code', null],
  ['Cargo.lock', 'non-code', null],
  ['pkg.json.lock', 'non-code', null],
  ['Foo.g.cs', 'non-code', null],            // generated beats the .cs extension
  ['Foo.designer.cs', 'non-code', null],
  ['obj/Proj.AssemblyInfo.cs', 'non-code', null],
  ['dist/app.min.js', 'non-code', null],
  ['a.js.map', 'non-code', null],
  ['notes.txt', 'non-code', null],
  ['requirements.txt', 'declarative', null], // exact name beats the .txt extension
  ['a.xyz', 'uncovered', null],
  ['NOTES', 'uncovered', null],
  ['.env', 'uncovered', null],               // sensitive-paths owns this; taxonomy just does not recognise it
];

describe('matchFileKind — ordered precedence matrix', () => {
  for (const [p, kind, language] of MATRIX) {
    it(`${p} → ${kind}${language ? `/${language}` : ''}`, () => {
      const m = matchFileKind(p);
      assert.equal(m.kind, kind);
      if (language) assert.equal(m.language, language);
    });
  }

  it('is a function of the path only — Windows separators and case are normalised', () => {
    assert.equal(matchFileKind('src\\Deep\\Foo.CS').kind, 'source');
    assert.equal(matchFileKind('SRC\\PACKAGE-LOCK.JSON').kind, 'declarative' /* exact names are case-sensitive */);
    assert.equal(matchFileKind('a/package-lock.json').kind, 'non-code');
  });

  it('a directory named like a sensitive word is not a taxonomy concern', () => {
    assert.equal(matchFileKind('Password/Hasher.cs').kind, 'source');
  });
});

describe('taxonomy tables', () => {
  it('every language extension is unique to one language', () => {
    const seen = new Map();
    for (const l of LANGUAGES) for (const e of l.extensions) {
      assert.ok(!seen.has(e), `${e} claimed by ${seen.get(e)} and ${l.id}`);
      seen.set(e, l.id);
    }
  });

  it('source / declarative / non-code extension sets are disjoint', () => {
    const src = new Set(SOURCE_CODE_EXTENSIONS);
    for (const e of [...DECLARATIVE_EXTENSIONS, ...NON_CODE_EXTENSIONS]) assert.ok(!src.has(e), `${e} is both source and not`);
    const decl = new Set(DECLARATIVE_EXTENSIONS);
    for (const e of NON_CODE_EXTENSIONS) assert.ok(!decl.has(e), `${e} is both declarative and non-code`);
  });

  it('AUDITABLE = source + declarative, and PLAN_REFERENCE_EXTENSIONS derives from it', () => {
    assert.equal(AUDITABLE_EXTENSIONS.length, SOURCE_CODE_EXTENSIONS.length + DECLARATIVE_EXTENSIONS.length);
    assert.deepEqual([...PLAN_REFERENCE_EXTENSIONS].sort(), AUDITABLE_EXTENSIONS.map((e) => e.slice(1)).sort());
  });

  it('languageById / languageForExtension agree', () => {
    assert.equal(languageForExtension('.CS').id, 'cs');
    assert.equal(languageById('cs').fence, 'csharp');
    assert.equal(languageById('nope'), null);
  });

  it('fence languages: historical values are byte-identical, new ones are added', () => {
    assert.equal(fenceLanguageFor('a.ts'), 'js');   // deliberately unchanged
    assert.equal(fenceLanguageFor('a.mjs'), 'js');
    assert.equal(fenceLanguageFor('a.py'), 'python');
    assert.equal(fenceLanguageFor('a.md'), 'markdown');
    assert.equal(fenceLanguageFor('a.sh'), 'bash');
    assert.equal(fenceLanguageFor('a.cs'), 'csharp');
    assert.equal(fenceLanguageFor('a.csproj'), 'xml');
  });

  it('extensionLabel names the bucket, or (no extension)', () => {
    assert.equal(extensionLabel('a/b.PNG'), 'png');
    assert.equal(extensionLabel('LICENSEX'), '(no extension)');
    assert.equal(extensionLabel('.env'), '(no extension)');
  });
});

describe('classifyFileCoverage — profiled vs model-only', () => {
  it('every registered profile language is `profiled`, and only those', () => {
    const profileIds = new Set(Object.keys(getAllProfiles()));
    for (const l of LANGUAGES) {
      const cls = classifyFileCoverage(`x${l.extensions[0]}`).class;
      assert.equal(cls, profileIds.has(l.id) ? 'profiled' : 'model-only', l.id);
    }
  });

  it('cs is profiled; go is model-only; csproj declarative; png non-code; xyz uncovered', () => {
    assert.equal(classifyFileCoverage('a.cs').class, 'profiled');
    assert.equal(classifyFileCoverage('a.go').class, 'model-only');
    assert.equal(classifyFileCoverage('a.csproj').class, 'declarative');
    assert.equal(classifyFileCoverage('a.png').class, 'non-code');
    assert.equal(classifyFileCoverage('a.xyz').class, 'uncovered');
  });

  it('a profile cannot claim an extension the taxonomy does not know', () => {
    for (const p of Object.values(getAllProfiles())) {
      for (const e of p.extensions) assert.ok(languageForExtension(e), `${p.id} claims ${e}`);
    }
  });
});

describe('admission oracle agrees with the taxonomy (the storyline defect)', () => {
  it('a .cs file is admitted; a generated .g.cs and a lockfile are not', () => {
    assert.equal(resolveReferenceExtension('services/Renderer/Layout.cs'), 'cs');
    assert.equal(resolveReferenceExtension('Obj.g.cs'), null);
    assert.equal(resolveReferenceExtension('package-lock.json'), null);
  });

  it('extensions the profiles claim are admitted (cjs / mts / cts / pyi were dropped before)', () => {
    for (const f of ['a.cjs', 'a.mts', 'a.cts', 'a.pyi']) assert.notEqual(resolveReferenceExtension(f), null, f);
  });

  it('admitted iff the taxonomy says source or declarative — for the whole matrix', () => {
    for (const [p, kind] of MATRIX) {
      assert.equal(resolveReferenceExtension(p) !== null, kind === 'source' || kind === 'declarative', p);
    }
  });
});
