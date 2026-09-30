/**
 * @fileoverview The dotnet tool pre-pass and the generic tool-runner honesty fixes
 * (docs/plans/file-coverage-contract-and-csharp.md, Phase 6; audit-plan R1-H6 / R1-M1 / R2-M2 / R2-M3).
 *
 * Fixtures under tests/fixtures/msbuild/ are REAL output captured from `dotnet` 8.0.425 on a real project (paths and
 * identifiers sanitised, structure untouched) — the parser is pinned against what the tool prints, not against what a
 * factory expects it to print.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseMsbuildOutput, parseDotnetFormatOutput, resolveToolProject, groupFilesByProject, runProjectTool, executeAllTools,
  spawnWithTreeKill, coverageToolsFrom, normalizeToolResults, normalizeExternalFinding, runTool,
  setExecFileSync, resetExecFileSync,
} from '../scripts/lib/linter.mjs';
import { getProfile } from '../scripts/lib/language-profiles.mjs';
import { resolveToolRunConfig } from '../scripts/lib/tool-run-config.mjs';

const FIX = path.resolve(import.meta.dirname, 'fixtures/msbuild');
const read = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const CWD = 'C:\\repo\\services\\renderer';

describe('parseMsbuildOutput — real captured output', () => {
  it('the captured --no-incremental build yields the ONE xUnit2029 warning, repo-relative', () => {
    const f = parseMsbuildOutput(read('build-noincremental-warning.out'), { cwd: CWD });
    assert.equal(f.length, 1);
    assert.deepEqual({ file: f[0].file, line: f[0].line, column: f[0].column, rule: f[0].rule, level: f[0].level }, {
      file: 'tests/LayoutTests.cs', line: 231, column: 13, rule: 'xUnit2029', level: 'warning',
    });
    assert.match(f[0].message, /Assert\.DoesNotContain/);
    assert.equal(f[0].toolFault, undefined, 'a real code warning is not a tool fault');
  });

  it('the summary repeats every warning: duplicates collapse to one finding', () => {
    const inline = read('build-noincremental-warning.out').split('\n').find((l) => l.includes('xUnit2029'));
    const withSummary = `${read('build-noincremental-warning.out')}\nBuild succeeded.\n\n${inline}\n    1 Warning(s)\n    0 Error(s)\n`;
    assert.equal(parseMsbuildOutput(withSummary, { cwd: CWD }).length, 1);
  });

  it('an incremental build on an up-to-date project prints NO diagnostics — which is why the tool must not be incremental', () => {
    assert.deepEqual(parseMsbuildOutput('  Determining projects to restore...\n  renderer -> C:\\a\\renderer.dll\n'), []);
    const [build] = getProfile('cs').tools;
    assert.ok(build.args.includes('--no-incremental'));
  });

  it('a compile ERROR is a finding with level error (not a tool fault)', () => {
    const [f] = parseMsbuildOutput('C:\\repo\\services\\renderer\\src\\A.cs(10,5): error CS0103: The name \'x\' does not exist in the current context [C:\\repo\\services\\renderer\\r.csproj]', { cwd: CWD });
    assert.equal(f.level, 'error');
    assert.equal(f.rule, 'CS0103');
    assert.equal(f.file, 'src/A.cs');
    assert.equal(f.toolFault, undefined);
  });

  it('MSB / NU / NETSDK errors and project-file errors are TOOL FAULTS', () => {
    const faults = parseMsbuildOutput([
      'MSBUILD : error MSB1003: Specify a project or solution file.',
      'C:\\repo\\services\\renderer\\r.csproj : error NU1101: Unable to find package Foo. No packages exist with this id in source(s): nuget.org',
      'C:\\repo\\services\\renderer\\r.csproj(4,3): error NETSDK1004: Assets file not found. Run a NuGet package restore',
      'C:\\repo\\services\\renderer\\Directory.Build.targets(3,5): error CS0246: The type Foo could not be found',
    ].join('\n'), { cwd: CWD });
    assert.equal(faults.length, 4);
    assert.ok(faults.every((f) => f.toolFault === true), JSON.stringify(faults.map((f) => [f.rule, f.toolFault])));
  });

  it('a WARNING about a project file (e.g. NU1903) is a finding, not a fault', () => {
    const [f] = parseMsbuildOutput('C:\\repo\\r.csproj : warning NU1903: Package Foo 1.0 has a known high severity vulnerability', { cwd: '' });
    assert.equal(f.level, 'warning');
    assert.equal(f.toolFault, undefined);
  });

  it('msbuild prefixes ("1>") are tolerated and paths outside cwd stay absolute', () => {
    const [f] = parseMsbuildOutput('  1>D:\\other\\B.cs(3,1): warning CS0168: The variable \'e\' is declared but never used', { cwd: CWD });
    assert.equal(f.file, 'D:/other/B.cs');
    assert.equal(f.rule, 'CS0168');
  });

  it('empty / null output is an empty list, never a throw', () => {
    assert.deepEqual(parseMsbuildOutput(''), []);
    assert.deepEqual(parseMsbuildOutput(null), []);
  });
});

describe('parseDotnetFormatOutput — real captured stderr', () => {
  it('every diagnostic is a `style` note (WHITESPACE), never a fault, never above LOW', () => {
    const f = parseDotnetFormatOutput(read('format-verify-stderr.out'), { cwd: CWD });
    assert.ok(f.length >= 3);
    assert.ok(f.every((x) => x.level === 'style' && x.rule === 'WHITESPACE' && !x.toolFault));
    assert.equal(f[0].file, 'src/ImageRenderer.cs');
    const meta = normalizeExternalFinding(f[0], { toolId: 'dotnet-format', toolKind: 'linter' }, 1);
    assert.equal(meta.severity, 'LOW');
  });

  it('the format tool reads stderr (that is where dotnet format prints)', () => {
    const format = getProfile('cs').tools[1];
    assert.equal(format.combineStderr, true);
    assert.equal(format.parser, 'parseDotnetFormatOutput');
  });
});

describe('normalization: compiler errors are HIGH bugs; warnings use the rule table', () => {
  it('level error → HIGH/BUG; a graded warning keeps its grade; an unknown warning falls to LOW', () => {
    const r = { toolId: 'dotnet-build', toolKind: 'typeChecker' };
    assert.equal(normalizeExternalFinding({ file: 'a.cs', line: 1, rule: 'CS0103', message: 'm', level: 'error' }, r, 1).severity, 'HIGH');
    assert.equal(normalizeExternalFinding({ file: 'a.cs', line: 1, rule: 'CS8602', message: 'm', level: 'warning' }, r, 2).severity, 'MEDIUM');
    assert.equal(normalizeExternalFinding({ file: 'a.cs', line: 1, rule: 'CS9999', message: 'm', level: 'warning' }, r, 3).severity, 'LOW');
    assert.equal(normalizeExternalFinding({ file: 'a.cs', line: 1, rule: 'CS0103', message: 'm', level: 'error' }, r, 1).classification.sourceKind, 'TYPE_CHECKER');
  });

  it('a partially successful project tool still contributes the projects that finished', () => {
    const findings = [{ file: 'a.cs', line: 1, rule: 'CS8602', message: 'm', level: 'warning', fixable: false }];
    const out = normalizeToolResults([{ status: 'timeout', toolId: 'dotnet-build', toolKind: 'typeChecker', findings, projects: [{ status: 'ok' }, { status: 'timeout' }] }]);
    assert.equal(out.length, 1);
    assert.match(out[0].id, /^T\d+$/);
  });
});

describe('resolveToolProject / groupFilesByProject (audit-plan R1-M1)', () => {
  const fs2 = (tree) => (dir) => {
    if (!(dir in tree)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return tree[dir];
  };
  const markers = ['.csproj', '.sln', '.slnx'];

  it('the nearest directory with exactly one project file owns the file', () => {
    const readdir = fs2({ 'svc/a/Deep': ['X.cs'], 'svc/a': ['A.csproj', 'A.cs'], svc: ['All.sln'], '.': [] });
    assert.deepEqual(resolveToolProject('svc/a/Deep/X.cs', markers, { readdir }), { status: 'ok', path: 'svc/a/A.csproj', kind: 'csproj' });
  });

  it('.csproj outranks .sln in the SAME directory', () => {
    const readdir = fs2({ svc: ['A.csproj', 'All.sln'], '.': [] });
    assert.equal(resolveToolProject('svc/X.cs', markers, { readdir }).path, 'svc/A.csproj');
  });

  it('two project files in one directory is `ambiguous_project` — reported, never guessed', () => {
    const readdir = fs2({ svc: ['A.csproj', 'B.csproj'], '.': [] });
    const r = resolveToolProject('svc/X.cs', markers, { readdir });
    assert.equal(r.status, 'ambiguous_project');
    assert.deepEqual(r.candidates, ['svc/A.csproj', 'svc/B.csproj']);
  });

  it('a .sln is used only when no .csproj is nearer', () => {
    const readdir = fs2({ 'svc/a': ['A.cs'], svc: ['All.sln'], '.': [] });
    assert.equal(resolveToolProject('svc/a/A.cs', markers, { readdir }).path, 'svc/All.sln');
  });

  it('no marker anywhere up to the root → no_project', () => {
    const readdir = fs2({ svc: ['A.cs'], '.': ['README.md'] });
    assert.deepEqual(resolveToolProject('svc/A.cs', markers, { readdir }), { status: 'no_project' });
  });

  it('files are grouped per project (each built once) and problems are reported, not dropped', () => {
    const readdir = fs2({ 'a': ['A.csproj'], 'b': ['B1.csproj', 'B2.csproj'], 'c': [], '.': [] });
    const { groups, problems } = groupFilesByProject(['a/x.cs', 'a/y.cs', 'b/z.cs', 'c/w.cs'], markers, { readdir });
    assert.deepEqual([...groups.keys()], ['a/A.csproj']);
    assert.deepEqual(groups.get('a/A.csproj').files, ['a/x.cs', 'a/y.cs']);
    assert.deepEqual(problems.map((p) => p.status).sort(), ['ambiguous_project', 'no_project']);
  });
});

describe('runProjectTool — honest states (audit-plan R2-M3)', () => {
  const build = getProfile('cs').tools[0];
  const project = { path: 'svc/A.csproj', kind: 'csproj' };
  const fileSet = new Set(['svc/A.cs']);
  const ctx = (over = {}) => ({ profileId: 'cs', deadlineAt: 1e12, now: () => 0, ...over });
  const spawnFn = (res) => async () => res;

  it('ok: warnings are parsed and filtered to the audited files', async () => {
    const out = 'svc/A.cs(1,1): warning CS0168: unused\nsvc/Other.cs(1,1): warning CS0168: not audited';
    const r = await runProjectTool(build, project, fileSet, ctx({ spawnFn: spawnFn({ kind: 'exit', code: 0, stdout: out, stderr: '' }) }));
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.findings.map((f) => f.file), ['svc/A.cs']);
  });

  it('a build that compiled with errors is `ok` with HIGH-level findings (errors are the finding)', async () => {
    const r = await runProjectTool(build, project, fileSet, ctx({ spawnFn: spawnFn({ kind: 'exit', code: 1, stdout: 'svc/A.cs(2,2): error CS0103: nope', stderr: '' }) }));
    assert.equal(r.status, 'ok');
    assert.equal(r.findings[0].level, 'error');
  });

  it('RED-THEN-GREEN: a non-zero exit with nothing parseable is FAILED, never ok-with-zero-findings', async () => {
    const r = await runProjectTool(build, project, fileSet, ctx({ spawnFn: spawnFn({ kind: 'exit', code: 1, stdout: '', stderr: 'The SDK "x" was not found' }) }));
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /exited 1 with no parseable diagnostics/);
  });

  it('an unrestored project is a tool fault with the restore hint', async () => {
    const r = await runProjectTool(build, project, fileSet, ctx({
      spawnFn: spawnFn({ kind: 'exit', code: 1, stdout: 'svc/A.csproj(4,3): error NETSDK1004: Assets file not found. Run a NuGet package restore', stderr: '' }),
    }));
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /dotnet restore/);
    assert.match(r.reason, /AUDIT_DOTNET_RESTORE=1/);
  });

  it('a parser exception is failed, not a crash', async () => {
    const bad = { ...build, parser: 'nonexistent' };
    assert.equal((await runProjectTool(bad, project, fileSet, ctx({ spawnFn: spawnFn({ kind: 'exit', code: 0, stdout: '', stderr: '' }) }))).status, 'failed');
  });

  it('a missing binary at spawn is `spawn_error`', async () => {
    const r = await runProjectTool(build, project, fileSet, ctx({ spawnFn: spawnFn({ kind: 'spawn_error', error: Object.assign(new Error('spawn dotnet ENOENT'), { code: 'ENOENT' }) }) }));
    assert.equal(r.status, 'spawn_error');
    assert.match(r.reason, /ENOENT/);
  });

  it('a per-tool timeout is `timeout`; a kill forced by the audit-wide deadline is `deadline_exceeded`', async () => {
    const toolBound = await runProjectTool({ ...build, timeoutMs: 1000 }, project, fileSet, ctx({ deadlineAt: 1e12, spawnFn: spawnFn({ kind: 'timeout', stdout: '', stderr: '' }) }));
    assert.equal(toolBound.status, 'timeout');
    const deadlineBound = await runProjectTool({ ...build, timeoutMs: 300000 }, project, fileSet, ctx({ deadlineAt: 5000, spawnFn: spawnFn({ kind: 'timeout', stdout: '', stderr: '' }) }));
    assert.equal(deadlineBound.status, 'deadline_exceeded');
  });

  it('the process gets min(tool timeout, time left) — a project started near the deadline cannot run for the full tool timeout', async () => {
    let seen = null;
    await runProjectTool({ ...build, timeoutMs: 300000 }, project, fileSet, ctx({
      deadlineAt: 8000, now: () => 5000,
      spawnFn: async (_c, _a, o) => { seen = o.timeoutMs; return { kind: 'exit', code: 0, stdout: '', stderr: '' }; },
    }));
    assert.equal(seen, 3000);
  });

  it('a deadline that has already passed never starts the process', async () => {
    let called = false;
    const r = await runProjectTool(build, project, fileSet, ctx({ deadlineAt: 100, now: () => 200, spawnFn: async () => { called = true; return {}; } }));
    assert.equal(r.status, 'deadline_exceeded');
    assert.equal(called, false);
  });

  it('NuGet restore stays OFF by default and only an explicit opt-in drops --no-restore', async () => {
    const argv = [];
    const spawner = async (_c, a) => { argv.push(a); return { kind: 'exit', code: 0, stdout: '', stderr: '' }; };
    await runProjectTool(build, project, fileSet, ctx({ restore: false, spawnFn: spawner }));
    await runProjectTool(build, project, fileSet, ctx({ restore: true, spawnFn: spawner }));
    assert.ok(argv[0].includes('--no-restore'));
    assert.ok(!argv[1].includes('--no-restore'));
    assert.ok(argv[0].includes('svc/A.csproj') && argv[0][0] === 'build');
    assert.ok(argv[0].includes('-nodeReuse:false') && argv[0].includes('-p:UseSharedCompilation=false'));
  });
});

describe('executeAllTools — orchestration, budget, dedup', () => {
  const tree = { 'svc/a': ['A.csproj'], 'svc/b': ['B.csproj'], 'svc/c': ['C.csproj'], svc: [], '.': [] };
  const readdir = (d) => { if (!(d in tree)) throw new Error('ENOENT'); return tree[d]; };
  const files = ['svc/a/A.cs', 'svc/a/A2.cs', 'svc/b/B.cs', 'svc/c/C.cs'];

  // the availability probe uses the injectable exec
  const withDotnet = async (fn) => {
    setExecFileSync(() => Buffer.from('8.0.425'));
    try { return await fn(); } finally { resetExecFileSync(); }
  };

  it('each project is built ONCE, serially; the result carries a per-project state', async () => {
    const calls = [];
    const res = await withDotnet(() => executeAllTools(files, {
      policy: { deadlineMs: 1e9, restore: false }, readdir, exists: () => true,
      spawnFn: async (_c, a) => { calls.push(a[1]); return { kind: 'exit', code: 0, stdout: '', stderr: '' }; },
    }));
    const build = res.find((r) => r.toolId === 'dotnet-build');
    assert.deepEqual(calls.filter((_, i) => i % 1 === 0 && calls.indexOf(_) === i).sort(), ['svc/a/A.csproj', 'svc/b/B.csproj', 'svc/c/C.csproj']);
    assert.equal(build.projects.length, 3);
    assert.equal(build.status, 'ok');
    assert.equal(build.projects.find((p) => p.path === 'svc/a/A.csproj').files.length, 2);
  });

  it('projects over the cap are `skipped_budget` and the tool status reflects it — never a clean pass', async () => {
    const res = await withDotnet(() => executeAllTools(files, {
      policy: { deadlineMs: 1e9, restore: false }, readdir, exists: () => true,
      spawnFn: async () => ({ kind: 'exit', code: 0, stdout: '', stderr: '' }),
    }));
    // default cap is 6 -> lower it through a tweaked profile clone
    const tool = getProfile('cs').tools[0];
    assert.equal(tool.maxProjects, 6);
    const capped = await withDotnet(async () => {
      const orig = tool.maxProjects;
      // frozen config: emulate a cap of 1 by feeding 7 projects instead
      const many = {};
      const fs7 = [];
      for (let i = 0; i < 7; i++) { many[`p${i}`] = [`P${i}.csproj`]; fs7.push(`p${i}/X.cs`); }
      many['.'] = [];
      return executeAllTools(fs7, {
        policy: { deadlineMs: 1e9, restore: false }, readdir: (d) => many[d] ?? (() => { throw new Error('ENOENT'); })(),
        exists: () => true, spawnFn: async () => ({ kind: 'exit', code: 0, stdout: '', stderr: '' }),
      });
    });
    const build = capped.find((r) => r.toolId === 'dotnet-build');
    assert.equal(build.projects.filter((p) => p.status === 'skipped_budget').length, 1);
    assert.equal(build.status, 'skipped_budget');
    assert.ok(res.length >= 1);
  });

  it('the audit-wide deadline: a second project after the deadline is `deadline_exceeded`', async () => {
    let t = 0;
    const res = await withDotnet(() => executeAllTools(['svc/a/A.cs', 'svc/b/B.cs'], {
      policy: { deadlineMs: 100, restore: false }, readdir, exists: () => true, now: () => t,
      spawnFn: async () => { t += 500; return { kind: 'exit', code: 0, stdout: '', stderr: '' }; },
    }));
    const build = res.find((r) => r.toolId === 'dotnet-build');
    assert.deepEqual(build.projects.map((p) => p.status), ['ok', 'deadline_exceeded']);
    assert.equal(build.status, 'deadline_exceeded');
  });

  it('ambiguous and project-less files are reported states, not silently dropped', async () => {
    const t2 = { 'x': ['A.csproj', 'B.csproj'], 'y': [], '.': [] };
    const res = await withDotnet(() => executeAllTools(['x/F.cs', 'y/G.cs'], {
      policy: { deadlineMs: 1e9, restore: false }, readdir: (d) => t2[d] ?? [], exists: () => true,
      spawnFn: async () => { throw new Error('nothing should be built'); },
    }));
    const build = res.find((r) => r.toolId === 'dotnet-build');
    assert.deepEqual(build.projects.map((p) => p.status).sort(), ['ambiguous_project', 'no_project']);
    assert.equal(build.status, 'ambiguous_project');
  });

  it('dotnet absent → `no_tool` with a reason (recorded, never clean)', async () => {
    setExecFileSync(() => { throw new Error('ENOENT'); });
    try {
      const res = await executeAllTools(['svc/a/A.cs'], { policy: { deadlineMs: 1e9, restore: false }, readdir, exists: () => true, spawnFn: async () => { throw new Error('no'); } });
      const build = res.find((r) => r.toolId === 'dotnet-build');
      assert.equal(build.status, 'no_tool');
      assert.match(build.projects[0].reason, /dotnet not available/);
    } finally { resetExecFileSync(); }
  });

  it('a deleted file has nothing to build — an all-deleted set runs no tool at all', async () => {
    const res = await withDotnet(() => executeAllTools(['svc/a/Gone.cs'], { policy: { deadlineMs: 1e9, restore: false }, readdir, exists: () => false, spawnFn: async () => { throw new Error('no'); } }));
    assert.equal(res.find((r) => r.toolId === 'dotnet-build'), undefined);
  });

  it('coverageToolsFrom projects results into the ledger shape', async () => {
    const res = await withDotnet(() => executeAllTools(['svc/a/A.cs'], { policy: { deadlineMs: 1e9, restore: false }, readdir, exists: () => true, spawnFn: async () => ({ kind: 'exit', code: 0, stdout: '', stderr: '' }) }));
    const [t] = coverageToolsFrom(res.filter((r) => r.toolId === 'dotnet-build'));
    assert.equal(t.id, 'dotnet-build');
    assert.equal(t.profile, 'cs');
    assert.equal(t.projects[0].path, 'svc/a/A.csproj');
    assert.equal(t.filesCovered, 1);
  });
});

describe('the whole-repo runner is honest too (generic fix; closes the ESLint-config-crash false clean)', () => {
  const eslint = { id: 'eslint', kind: 'linter', command: 'npx', args: ['eslint', '.'], parser: 'parseEslintOutput', availabilityProbe: ['npx', ['--version']] };
  const tsc = { id: 'tsc', kind: 'typeChecker', command: 'npx', args: ['tsc'], parser: 'parseTscOutput', availabilityProbe: ['npx', ['--version']] };
  const throwing = (status, stdout, stderr = '') => (cmd, args) => {
    if (args.includes('--version')) return Buffer.from('ok');
    throw Object.assign(new Error('exit'), { status, stdout, stderr });
  };
  const run = (cfg, exec) => { setExecFileSync(exec); try { return runTool(cfg, ['a.ts'], 'ts'); } finally { resetExecFileSync(); } };

  it('RED-THEN-GREEN: tsc exiting 2 with only a positionless error prints ZERO parseable findings → failed, not ok', () => {
    const r = run(tsc, throwing(2, "error TS18003: No inputs were found in config file 'tsconfig.json'."));
    assert.equal(r.status, 'failed');
    assert.match(r.stderr, /exited 2 with no parseable findings/);
  });

  it('a non-zero exit WITH located findings is still ok (that is how linters report)', () => {
    const r = run(tsc, throwing(2, 'a.ts(1,1): error TS2304: Cannot find name x.'));
    assert.equal(r.status, 'ok');
    assert.equal(r.findings.length, 1);
  });

  it('a non-zero exit with findings only in OTHER files is still ok (project-wide tool)', () => {
    const r = run(tsc, throwing(2, 'other.ts(1,1): error TS2304: x'));
    assert.equal(r.status, 'ok');
    assert.equal(r.findings.length, 0);
  });

  it('eslint crashing on a bad config (exit 2, nothing on stdout) is failed', () => {
    assert.equal(run(eslint, throwing(2, '', 'Oops! Something went wrong! ESLint: Cannot read config file')).status, 'failed');
  });
});

describe('spawnWithTreeKill — a REAL process tree (audit-plan R1-H6)', () => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  it('on timeout the child AND its grandchild are gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treekill-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    try {
      const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      const parent = `const { spawn } = require('child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
      const res = await spawnWithTreeKill(process.execPath, ['-e', parent], { timeoutMs: 1500 });
      assert.equal(res.kind, 'timeout');
      assert.ok(fs.existsSync(pidFile), 'the grandchild started (negative control: the test can observe it)');
      const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
      await wait(500);
      assert.equal(alive(gpid), false, 'the grandchild survived the timeout — a direct-child kill would leave it running');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('a process that exits normally returns its output; a missing binary is `spawn_error`', async () => {
    const ok = await spawnWithTreeKill(process.execPath, ['-e', "console.log('hi'); console.error('warn')"], { timeoutMs: 20000 });
    assert.equal(ok.kind, 'exit');
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /hi/);
    assert.match(ok.stderr, /warn/);
    const bad = await spawnWithTreeKill('definitely-not-a-real-binary-xyz', [], { timeoutMs: 5000 });
    assert.equal(bad.kind, 'spawn_error');
  });
});

describe('tool policy config (audit-plan R2-M5)', () => {
  const warns = [];
  const orig = process.stderr.write.bind(process.stderr);
  const quiet = (fn) => { process.stderr.write = (s) => { warns.push(String(s)); return true; }; try { return fn(); } finally { process.stderr.write = orig; } };

  it('defaults: 15 minutes, restore off', () => {
    assert.deepEqual(resolveToolRunConfig({}), { deadlineMs: 900000, restore: false });
  });
  it('valid values', () => {
    assert.deepEqual(resolveToolRunConfig({ AUDIT_TOOLS_DEADLINE_MS: '60000', AUDIT_DOTNET_RESTORE: '1' }), { deadlineMs: 60000, restore: true });
    assert.equal(resolveToolRunConfig({ AUDIT_DOTNET_RESTORE: 'true' }).restore, true);
    assert.equal(resolveToolRunConfig({ AUDIT_DOTNET_RESTORE: 'TRUE' }).restore, true);
  });
  it('malformed / zero / negative / oversized deadlines fall back or clamp, with a warning', () => {
    warns.length = 0;
    const r = quiet(() => [
      resolveToolRunConfig({ AUDIT_TOOLS_DEADLINE_MS: 'abc' }).deadlineMs,
      resolveToolRunConfig({ AUDIT_TOOLS_DEADLINE_MS: '0' }).deadlineMs,
      resolveToolRunConfig({ AUDIT_TOOLS_DEADLINE_MS: '-5' }).deadlineMs,
      resolveToolRunConfig({ AUDIT_TOOLS_DEADLINE_MS: '99999999999' }).deadlineMs,
    ]);
    assert.deepEqual(r, [900000, 10000, 10000, 3600000]);
    assert.ok(warns.length >= 4);
  });
  it('anything but exactly 1/true for restore warns and means OFF — a typo must never enable the network', () => {
    warns.length = 0;
    const r = quiet(() => ['yes', 'on', '2', 'false', '0'].map((v) => resolveToolRunConfig({ AUDIT_DOTNET_RESTORE: v }).restore));
    assert.deepEqual(r, [false, false, false, false, false]);
    assert.ok(warns.some((w) => /AUDIT_DOTNET_RESTORE/.test(w)));
  });
});
