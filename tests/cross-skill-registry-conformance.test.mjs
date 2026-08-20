/**
 * @fileoverview Registry conformance — universal assertions quantified over
 * REGISTRY + the frozen inventory (docs/plans/cross-skill-command-registry.md §9).
 *
 * These are the checks a per-command census cannot be: they hold for every
 * entry that exists and every entry that will ever be added, because they
 * iterate the registry and the inventory — the enumerable truths — not a
 * hand-kept list. A new command cannot be born outside them.
 *
 * The conservation law (audit R2-H1) is asserted against the RUNNING CLI
 * (`--inventory-json`), not source text: quantifying only over source
 * declarations proves nothing about a command that was deleted instead of
 * migrated, and a count-based ratchet would read that deletion as progress.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY, normalizeFlag, UNIVERSAL_FLAGS, payloadFlags } from '../scripts/lib/cross-skill/registry.mjs';

const CLI_PATH = fileURLToPath(new URL('../scripts/cross-skill.mjs', import.meta.url));
const INVENTORY = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('./fixtures/cross-skill-inventory.json', import.meta.url)), 'utf8',
)).commands;

const COMMANDS_DIR = fileURLToPath(new URL('../scripts/lib/cross-skill/commands', import.meta.url));

// Comments stripped before any source-text match — module docstrings NAME the
// banned identifiers while explaining the ban, and a raw-source regex then
// reads the explanation as a violation (the instrument defect that appeared
// twice in tests/cross-skill-cli-integrity.test.mjs). Reused from
// check-cli-flags.mjs rather than a local copy — the duplication wave flagged
// the copy at 0.85 similarity, and two comment-strippers that can disagree is
// the two-oracles defect.
import { stripComments } from '../scripts/check-cli-flags.mjs';

const SCOPES = new Set(['none', 'ambient-ok', 'explicit-required', 'global-optin']);
const KINDS = new Set(['read', 'write', 'local']);
const CLOUDS = new Set(['none', 'degrade-noop', 'require']);
const PAYLOADS = new Set(['json', 'flags', 'both', 'none']);
const FLAG_KINDS = new Set(['valued', 'boolean', 'repeatable']);

describe('registry entries — every policy tuple is valid', () => {
  it('names are unique and every field is from its closed set', () => {
    const seen = new Set();
    for (const e of REGISTRY) {
      assert.ok(!seen.has(e.name), `duplicate registry entry: ${e.name}`);
      seen.add(e.name);
      assert.ok(SCOPES.has(e.scope), `${e.name}: bad scope ${e.scope}`);
      assert.ok(KINDS.has(e.kind), `${e.name}: bad kind ${e.kind}`);
      assert.ok(CLOUDS.has(e.cloud), `${e.name}: bad cloud ${e.cloud}`);
      assert.ok(PAYLOADS.has(e.payload), `${e.name}: bad payload ${e.payload}`);
      assert.equal(typeof e.load, 'function', `${e.name}: load must be a lazy function`);
      for (const f of e.flags ?? []) {
        const d = normalizeFlag(f);
        assert.match(d.name, /^[a-z0-9-]+$/, `${e.name}: bad flag name ${d.name}`);
        assert.ok(FLAG_KINDS.has(d.kind), `${e.name}: flag --${d.name} has bad kind ${d.kind}`);
      }
      assert.ok(e.positionals === 'none' || Array.isArray(e.positionals?.verbs),
        `${e.name}: positionals must be 'none' or {verbs:[…]}`);
      if (e.forward) {
        assert.equal(typeof e.forward.to, 'string', `${e.name}: forward.to must name the target CLI`);
        assert.ok(!(e.flags ?? []).length,
          `${e.name}: forward entries delegate their grammar — they must not also declare flags`);
      }
      if (e.portExempt) {
        assert.ok(e.forward,
          `${e.name}: portExempt is only legal on forward/wrapper commands — a plain write cannot claim the exemption`);
      }
    }
  });

  it('scope global-optin ⇒ --all-repos is declared (the policy must be reachable)', () => {
    // Only the FORWARD direction is enforceable. The reverse ("declares
    // --all-repos ⇒ scope is global-optin") was too strict and rejected a real
    // shape: `arm-eval-decision`/`-stats`/`-export` pass the flag to a store
    // that REFUSES an unscoped read, so the flag is honoured — just not by the
    // dispatcher's scope policy. Declaring them global-optin would make the
    // dispatcher resolve ambient identity where legacy passed null, a
    // behaviour change disguised as a conformance fix.
    //
    // The reverse direction is not unguarded: an undeclared flag READ throws
    // (dispatch.mjs), so a declared --all-repos that nothing reads cannot go
    // unnoticed the way a KNOWN_FLAGS row could — which is the actual
    // inert-flag risk this rule was reaching for.
    for (const e of REGISTRY) {
      if (e.scope !== 'global-optin') continue;
      const hasAllRepos = (e.flags ?? []).map(normalizeFlag).some((d) => d.name === 'all-repos');
      assert.ok(hasAllRepos, `${e.name}: global-optin without --all-repos — the policy is unreachable`);
    }
  });

  it('every loader resolves to a function (no entry points at a missing module)', async () => {
    for (const e of REGISTRY) {
      const h = await e.load();
      assert.equal(typeof h, 'function', `${e.name}: loader did not resolve to a handler`);
    }
  });

  it('payload flags are DERIVED, never DOUBLE-declared (audit R1-H2)', () => {
    // The defect this guards is a command declaring a flag its `payload:`
    // already derives — two sources for one name. It is NOT "the string
    // --json may never appear": `model-ab-adjudicate` is `payload:'none'` and
    // uses `--json` as a MODE flag (raw queue vs the default human worksheet),
    // which derives nothing and must be declared to be readable at all.
    for (const e of REGISTRY) {
      const derived = new Set(payloadFlags(e.payload).map((f) => f.slice(2)));
      for (const f of e.flags ?? []) {
        const d = normalizeFlag(f);
        assert.ok(!derived.has(d.name),
          `${e.name}: --${d.name} is already derived from payload:'${e.payload}' — declaring it too is two sources for one flag`);
      }
    }
    assert.deepEqual(payloadFlags('none'), [], 'payload none admits no payload flags');
    assert.deepEqual(payloadFlags('json'), ['--json', '--stdin']);
  });

  it('UNIVERSAL_FLAGS stays the measured minimal set', () => {
    assert.deepEqual([...UNIVERSAL_FLAGS].sort(), ['--help', '--selfcheck-relocation'],
      'growing the universal set re-creates the accepted-but-inert class (audit R1-H2) — declare per-command instead');
  });

  it('every degrade-noop command has ≥1 golden cloud-off case (the policy is ENFORCED by coverage)', async () => {
    // `cloud:'degrade-noop'` is data; the handler applies it in its own legacy
    // order (byte-compat). What makes it a CONTRACT rather than a convention
    // each handler must remember (audit CA-r1) is this rule: the golden suite
    // exercises the command hermetically cloud-off, so a handler that forgets
    // its degrade path fails a fixture, not a code review.
    const { CASES } = await import('../scripts/dev/capture-cross-skill-envelopes.mjs');
    const covered = new Set(CASES.map((c) => c.args[0]));
    for (const e of REGISTRY) {
      if (e.cloud === 'degrade-noop') {
        assert.ok(covered.has(e.name),
          `${e.name}: cloud is degrade-noop but no capture case invokes it — add cases to `
          + 'scripts/dev/capture-cross-skill-envelopes.mjs BEFORE migrating the command');
      }
    }
  });

  it('every registry command has AT LEAST ONE golden capture case (audit finding 01b9bc56)', async () => {
    // The row above enforces coverage for the degrade-noop CONTRACT
    // specifically. This is the broader claim it does not make: nothing
    // previously derived "every MIGRATED command has golden coverage" from
    // REGISTRY itself — tests/cross-skill-golden-envelopes.test.mjs only
    // checks that CASES and the fixture file agree with EACH OTHER, so a
    // registry command with zero entries in CASES would never surface there
    // either. A command added to the registry without a matching capture
    // case would be silently uncovered by the whole golden suite — this is
    // the gate that makes that impossible, regardless of the command's
    // `cloud` policy.
    const { CASES } = await import('../scripts/dev/capture-cross-skill-envelopes.mjs');
    const covered = new Set(CASES.map((c) => c.args[0]));
    const uncovered = REGISTRY.filter((e) => !covered.has(e.name)).map((e) => e.name);
    assert.deepEqual(uncovered, [],
      'registry command(s) with NO capture case at all — add a row to '
      + 'scripts/dev/capture-cross-skill-envelopes.mjs\'s CASES for each, BEFORE (or as part of) migrating it');
  });

  it('every okless declaration carries a WRITTEN reason (same discipline as softFail)', () => {
    // `okless` exempts a command from the "envelope must carry ok:true" rule.
    // Like softFail it is a licence, so it is only legal with a stated reason —
    // otherwise a handler that simply FORGOT to return `ok` would inherit the
    // exemption meant for a deliberately state-shaped envelope.
    for (const e of REGISTRY) {
      if (e.okless === undefined) continue;
      assert.equal(typeof e.okless?.reason, 'string',
        `${e.name}: okless must be {reason} — a bare flag hides which envelopes are deliberately ok-less`);
      assert.ok(e.okless.reason.length > 40, `${e.name}: okless reason must explain the envelope's shape`);
    }
  });

  it('every softFail is verb-scoped or carries a WRITTEN reason — the debt is enumerable, not a bare flag', () => {
    // `softFail` exempts a command from the ok:true validator, i.e. it is a
    // licence to emit a failure at exit 0. A bare boolean makes that licence
    // invisible and unreviewable; requiring a reason turns the set into a
    // legible worklist (Cluster F owns the tightenings, and this is how it
    // finds them: REGISTRY.filter(e => e.softFail?.all)).
    for (const e of REGISTRY) {
      if (e.softFail === undefined) continue;
      const verbScoped = Array.isArray(e.softFail?.verbs);
      const allScoped = e.softFail?.all === true;
      assert.ok(verbScoped || allScoped,
        `${e.name}: softFail must be {verbs:[…]} or {all:true, reason}, never a bare boolean`);
      if (allScoped) {
        assert.equal(typeof e.softFail.reason, 'string',
          `${e.name}: a command-wide softFail must say WHY in a reason string`);
        assert.ok(e.softFail.reason.length > 40,
          `${e.name}: softFail reason must name the legacy shape and its owner, not just a label`);
      }
      if (verbScoped) {
        assert.ok(Array.isArray(e.positionals?.verbs), `${e.name}: verb-scoped softFail needs declared verbs`);
        for (const v of e.softFail.verbs) {
          assert.ok(e.positionals.verbs.includes(v), `${e.name}: softFail verb "${v}" is not a declared verb`);
        }
      }
    }
  });
});

describe('the conservation law — registry ∪ legacy = INVENTORY (audit R2-H1)', () => {
  it('holds on the RUNNING CLI, disjoint, no losses, no phantoms', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, '--inventory-json'], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
    const { registry, legacy } = JSON.parse(line);

    const overlap = registry.filter((n) => legacy.includes(n));
    assert.deepEqual(overlap, [], 'a command must live in exactly ONE dispatch surface');

    const union = [...registry, ...legacy].sort();
    assert.deepEqual(union, [...INVENTORY].sort(),
      'a command moved OUT of the inventory (deleted instead of migrated?) or appeared unaccounted — '
      + 'editing tests/fixtures/cross-skill-inventory.json in the same commit is the reviewed way to change the surface');
  });

  it('REGISTRY (source) agrees with the running registry surface', () => {
    const r = spawnSync(process.execPath, [CLI_PATH, '--inventory-json'], { encoding: 'utf8', timeout: 60_000 });
    const line = r.stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
    const { registry } = JSON.parse(line);
    assert.deepEqual(registry, REGISTRY.map((e) => e.name).sort());
  });
});

describe('import-graph bans — the port is the only way into the store (D5b)', () => {
  const files = fs.existsSync(COMMANDS_DIR)
    ? fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.mjs'))
    : [];

  it('commands/*.mjs never imports the store barrel or scripts/lib/store/**', () => {
    assert.ok(files.length > 0, 'no command modules found — wrong directory?');
    const offenders = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(path.join(COMMANDS_DIR, f), 'utf8'));
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2];
        if (/learning-store\.mjs$/.test(spec) || /\/store\//.test(spec)) {
          offenders.push(`${f} → ${spec}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'store access goes through ctx.deps (the composed port) — a direct import bypasses the store-call goldens');
  });

  it('commands/*.mjs never calls initLearningStore directly (shadow R1-M2)', () => {
    // whoami is the sanctioned exception: cloud:'none', it REPORTS cloud state
    // as data and owns its own init — via the PORT (ctx.deps), which is what
    // this ban is actually about; the regex below catches a bare call, not
    // the ctx.deps.initLearningStore() form.
    for (const f of files) {
      const src = stripComments(fs.readFileSync(path.join(COMMANDS_DIR, f), 'utf8'));
      assert.ok(!/(?<!deps\.)initLearningStore\s*\(/.test(src),
        `${f}: init belongs to the dispatcher (or ctx.deps for cloud:'none' self-reporters)`);
    }
  });

  it('path-consuming commands import the INC-001 oracle when they touch paths', () => {
    // Cluster A's trio consumes no repo paths; this asserts the rule is
    // ready for lock-with-test (Cluster B): any command module that mentions
    // realpathSync/containment must import path-validation.mjs. Vacuous-pass
    // guard: the assertion itself is exercised against a synthetic offender.
    const offender = `import { realpathSync } from 'node:fs';\nconst x = realpathSync('.');`;
    const checks = (src) => !/realpathSync|startsWith\(repoRoot/.test(src) || /path-validation\.mjs/.test(src);
    assert.equal(checks(offender), false, 'the tripwire must be able to fail');
    for (const f of files) {
      const src = stripComments(fs.readFileSync(path.join(COMMANDS_DIR, f), 'utf8'));
      assert.ok(checks(src), `${f}: home-rolled path containment — use classifyReadPath/classifyTestPath (INC-001)`);
    }
  });
  // ── D7 / Phase 8 — parent-scoped child writes ─────────────────────────────

  it('every `parent:` declaration names a table on the CLOSED ownership allowlist', async () => {
    // The registry's `parent:` metadata is for conformance; the SQL is the
    // enforcement. This is what keeps the two from drifting: a declaration
    // naming a table `ownership.mjs` does not know about would be a claim with
    // nothing behind it.
    const { PARENT_TABLES } = await import('../scripts/lib/store/ownership.mjs');
    const declared = REGISTRY.filter((e) => e.parent);
    assert.ok(declared.length >= 4,
      `expected >=4 parent-scoped commands, found ${declared.length} — if this dropped, the checks below are vacuous`);
    for (const e of declared) {
      assert.ok(e.parent.table in PARENT_TABLES,
        `${e.name}: parent table "${e.parent.table}" is not on the ownership allowlist (${Object.keys(PARENT_TABLES).join(', ')})`);
      assert.ok(typeof e.parent.idField === 'string' && e.parent.idField,
        `${e.name}: parent declaration needs the payload field that carries the parent id`);
    }
  });

  it('a parent-scoped write can RESOLVE a repo — scope:none would make the tenant predicate dead', () => {
    // The join relaxes its tenant predicate when repoId is null. A command
    // declared `scope:'none'` can never produce one, so the predicate would be
    // permanently relaxed and the declaration would assert nothing about
    // ownership — only about existence.
    for (const e of REGISTRY.filter((x) => x.parent)) {
      assert.notEqual(e.scope, 'none',
        `${e.name} declares a parent but scope:'none' — it could never thread a repoId, so the tenant half of the join would be permanently relaxed`);
    }
  });

  it('every parent-scoped handler THREADS the resolved repo into the writer', () => {
    // The declaration is inert unless the handler passes `{repoId}`. Asserted
    // on source because the threading is one argument at one call site, and a
    // dropped argument is silent: the writer defaults to null, which is a
    // legal (relaxed) mode rather than an error.
    const bodies = files.map((f) => stripComments(fs.readFileSync(path.join(COMMANDS_DIR, f), 'utf8'))).join('\n');
    assert.match(bodies, /\{ repoId \}/,
      'no handler passes { repoId } — the parent declarations would be inert');
    const threaded = (bodies.match(/\{ repoId \}/g) || []).length;
    assert.ok(threaded >= REGISTRY.filter((e) => e.parent).length,
      `${threaded} handler(s) thread { repoId } but ${REGISTRY.filter((e) => e.parent).length} commands declare a parent`);
  });
});
