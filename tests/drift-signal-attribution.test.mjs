/**
 * @fileoverview A drift verdict must describe what it measured.
 *
 * INCIDENT (consumer report, 2026-09-04). A consumer wired `arch:*` into a
 * scheduled GitHub Actions workflow on a self-hosted runner. The first dispatch
 * that completed every step reported:
 *
 *     - **Status:** `GREEN`
 *     - **Drift score:** 0 / threshold 20
 *     - **Duplication pairs:** 0
 *
 * An hour earlier the same repo measured 14 pairs. Nothing was wrong with the
 * workflow — it had connected to a DIFFERENT DATABASE, and there was no way to
 * tell from the report. Their own duplication verifier exited 0 on that
 * snapshot: a policy gate passing over a near-empty store.
 *
 * The signal was not wrong. It was UNATTRIBUTABLE, which is worse, because it
 * reported a confident GREEN and every step passed. Two facts were missing and
 * both are a handful of lines:
 *
 *   - the CORPUS — a score of 0 over 1842 symbols and a score of 0 over 12
 *     rendered identically, and only the first is a statement about code;
 *   - the STORE — the only clue was an 8-hex fingerprint in a debug line
 *     thousands of lines away in a different CI step.
 *
 * These tests lock both onto every surface that emits a verdict, and lock the
 * `unknown` ≠ `0` distinction that is the whole point: "nobody looked" must not
 * be able to wear "looked, found nothing"'s clothes.
 *
 * The store descriptor is asserted to be fingerprint + database name and NOT a
 * hostname — the reporter asked for `host:port/database`, and that is the one
 * form it may not take (AGENTS.md: this repo is public, one consumer's store is
 * corporate).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import {
  storeDescriptor, storeFingerprint, dbIdentity, assertSafeDsn, assertDisposableDbUrl,
  effectiveDbTarget,
} from '../scripts/lib/db/client.mjs';
import { renderDriftIssue, renderHeader, renderArchitectureMap } from '../scripts/lib/arch-render.mjs';
import { renderText } from '../scripts/symbol-index/duplicates.mjs';

const DSN = 'postgresql://user:secret@db.example-host.internal:5432/audit_loop';

// A drift payload that would render as a clean GREEN — the shape the incident
// produced. Every test below asks what ELSE the report says about it.
const CLEAN_DRIFT = { score: 0, duplication_pairs: 0, layering_violations: 0 };

describe('storeDescriptor — the publishable identity of a store', () => {
  it('is fingerprint + database name', () => {
    const d = storeDescriptor(DSN);
    assert.equal(d.fingerprint, storeFingerprint(DSN), 'one oracle: the same digest announceStore prints');
    assert.equal(d.database, 'audit_loop');
    assert.equal(d.label, `${d.fingerprint} (db=audit_loop)`);
  });

  it('NEVER contains the hostname, the port, or the credential', () => {
    // The direction that must not fire. `dbIdentity` IS `host:port/database`
    // and stays internal; publishing it is the specific thing forbidden.
    const label = storeDescriptor(DSN).label;
    assert.ok(!label.includes('example-host'), `label leaked a hostname: ${label}`);
    assert.ok(!label.includes('5432'), `label leaked a port: ${label}`);
    assert.ok(!label.includes('secret'), `label leaked a credential: ${label}`);
    assert.ok(!label.includes('user'), `label leaked a username: ${label}`);
  });

  it('two DSNs naming different databases produce different labels', () => {
    // The entire question the incident could not answer.
    const a = storeDescriptor('postgresql://h/audit_loop').label;
    const b = storeDescriptor('postgresql://h/postgres').label;
    assert.notEqual(a, b);
  });

  it('returns null — not a fabricated label — for no DSN or an unparseable one', () => {
    assert.equal(storeDescriptor(null), null);
    assert.equal(storeDescriptor(''), null);
    assert.equal(storeDescriptor('not a dsn'), null);
  });

  it('activeStoreDescriptor names the store the POOL opened, not a re-read of config', () => {
    // Plan-audit R1 H2: a descriptor resolved apart from the client that ran the
    // query is a second answer to a question that must have one. The child below
    // opens a pool against one DSN, then changes the env underneath it — the
    // descriptor must still name the store the queries are going to.
    //
    // No real database is involved: `getPool()` resolves and records the DSN
    // before it connects, and the connection error (if any) is irrelevant to the
    // question. The DSN is a loopback address on a port nothing listens on.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-bind-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-bind-home-'));
    _tmp.push(cwd, home);
    const clientUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'client.mjs')).href;
    const env = { ...process.env, HOME: home, USERPROFILE: home, AUDIT_DB_URL: 'postgresql://127.0.0.1:59999/first_db' };
    for (const k of ['AUDIT_POSTGRES_URL', 'DOTENV_CONFIG_PATH', '_AUDIT_LOOP_SHARED_LOADED']) delete env[k];
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { getPool, activeStoreDescriptor } from ${JSON.stringify(clientUrl)};`
      + `try { await getPool(); } catch { /* connecting is not the point */ }`
      + `process.env.AUDIT_DB_URL = 'postgresql://127.0.0.1:59999/second_db';`
      + `process.stdout.write(JSON.stringify(activeStoreDescriptor()));`,
    ], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const desc = JSON.parse(r.stdout);
    assert.equal(desc.database, 'first_db',
      'the descriptor followed the env instead of the pool it was opened with');
  });
});

// ── A DSN's query string overrides where it connects (code-audit R1 H1) ─────
//
// `pg` parses connection strings with `pg-connection-string`, where `?host=`
// replaces the URL hostname and `?port=` replaces the port. Every guard and
// identity function here read `URL.hostname`/`URL.port` — the host the string
// DISPLAYS, not the host the driver DIALS. Verified against the installed
// parser, which is what makes these fixtures a repro rather than a theory:
//
//   postgresql://localhost:5432/db?host=prod.example.com  → host prod.example.com
//   postgresql://x.pooler.supabase.com:5432/db?port=6543  → port 6543
//
// Each case below passes against the pre-fix code, which is the whole point.

describe('effective connection target — guards read where a DSN DIALS', () => {
  it('the disposable-host allowlist fails CLOSED against a ?host= override', () => {
    // The serious one. `assertDisposableDbUrl` gates suites that run
    // `DROP SCHEMA public CASCADE`. Pre-fix, this DSN read as `localhost`,
    // cleared the loopback allowlist, and dropped the schema on prod.
    assert.throws(
      () => assertDisposableDbUrl('postgresql://localhost:5432/db?host=prod.example.com'),
      /not a recognised disposable|disposable/i,
      'a production host smuggled in via ?host= must not pass the loopback allowlist',
    );
  });

  it('a DUPLICATED ?host= resolves to the LAST one, like the driver does', () => {
    // Code-audit R2 H1/H2, and the sharper version of the case above: the fix
    // for `?host=` used `searchParams.get()`, which returns the FIRST
    // occurrence, while `pg-connection-string` keeps the LAST. Verified against
    // the installed parser — `?host=first&host=last` → the driver dials `last`.
    // So a loopback value in the first slot read as disposable while the
    // connection went to the second: the fix reproducing the class it fixed.
    assert.throws(
      () => assertDisposableDbUrl('postgresql://localhost/db?host=127.0.0.1&host=prod.example.com'),
      /disposable/i,
      'the LAST ?host= decides where this DSN dials, so it is what the guard must read',
    );
    assert.equal(
      dbIdentity('postgresql://x/db?host=a.example&host=b.example'),
      dbIdentity('postgresql://b.example/db'),
    );
    assert.equal(
      dbIdentity('postgresql://x:1/db?port=1111&port=2222'),
      dbIdentity('postgresql://x:2222/db'),
    );
  });

  it('an EMPTY final override means "no override" — the URL authority wins', () => {
    // Code-audit R3 H1/H2, and a correction to what R2's test asserted. Probed
    // against the installed parser rather than reasoned about, because the
    // previous two rounds of this were settled by guessing:
    //
    //   postgresql://decoy:1/db?host=real.example&host=  → driver dials decoy
    //   postgresql://decoy:1/db?port=2222&port=          → driver uses port 1
    //
    // An empty last value is NOT "fall back to the previous duplicate". The
    // R2 implementation scanned backwards for the last non-empty one and its
    // test asserted that — pinning the defect. It disagreed with the driver in
    // the FAIL-OPEN direction: `?host=127.0.0.1&host=` on a prod URL resolved
    // to the disposable loopback host while the connection went to prod.
    assert.equal(
      dbIdentity('postgresql://decoy:1/db?host=real.example&host='),
      dbIdentity('postgresql://decoy:1/db'),
      'a blank final ?host= must not resurrect an earlier duplicate',
    );
    assert.equal(
      dbIdentity('postgresql://decoy:1/db?port=2222&port='),
      dbIdentity('postgresql://decoy:1/db'),
    );
    assert.equal(dbIdentity('postgresql://decoy:1/db?host='), dbIdentity('postgresql://decoy:1/db'));
  });

  it('the guard is not fooled by a blank final ?host= either', () => {
    // The security-relevant direction of the case above, asserted separately so
    // it cannot be lost if the identity assertions are ever relaxed.
    assert.throws(
      () => assertDisposableDbUrl('postgresql://prod.example.com/db?host=127.0.0.1&host='),
      /disposable/i,
      'a loopback value in a non-final slot must not clear the allowlist',
    );
  });

  it('still ADMITS a genuinely disposable DSN (the direction it must not block)', () => {
    // Negative control: a guard that refuses everything also "passes" the test
    // above, and would break every DB-gated suite in the repo.
    assert.doesNotThrow(() => assertDisposableDbUrl('postgresql://127.0.0.1:5433/postgres'));
    assert.doesNotThrow(() => assertDisposableDbUrl('postgresql://localhost:5432/db?host=127.0.0.1'));
  });

  it('the transaction-pooler refusal reads the effective port', () => {
    // 6543 breaks prepared statements and the search_path pin. Pre-fix a
    // `?port=6543` override read as 5432 and sailed through.
    assert.throws(
      () => assertSafeDsn('postgresql://x.pooler.supabase.com:5432/db?port=6543'),
      /Transaction pooler/i,
    );
    assert.doesNotThrow(() => assertSafeDsn('postgresql://x.pooler.supabase.com:5432/db'),
      'the Session pooler on 5432 must still be accepted');
  });

  it('two DSNs that dial the SAME database share one identity and fingerprint', () => {
    // The half this plan's own change rides on: a fingerprint keyed on the
    // displayed authority is a confident label for a database nobody talked to.
    const viaQuery = 'postgresql://placeholder:1/db?host=real.example.com&port=5432';
    const direct = 'postgresql://real.example.com:5432/db';
    assert.equal(dbIdentity(viaQuery), dbIdentity(direct));
    assert.equal(storeFingerprint(viaQuery), storeFingerprint(direct));
  });

  it('two DSNs that dial DIFFERENT databases do not collide', () => {
    // The other direction — an over-eager normaliser that returned a constant
    // would satisfy the case above.
    assert.notEqual(
      storeFingerprint('postgresql://h:5432/db?host=a.example.com'),
      storeFingerprint('postgresql://h:5432/db?host=b.example.com'),
    );
  });

  it('getPool ACTUALLY announces the store — executed, not read from source', () => {
    // Code-audit R1 M9: the announcement lifecycle was asserted by matching
    // source text, which proves the call is written, not that it runs. It is
    // executable after all: `announceStore` fires after the Pool is constructed
    // but before any connection, so an unreachable DSN still produces the line.
    const clientUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'client.mjs')).href;
    const dsn = 'postgresql://127.0.0.1:59998/announce_probe';
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { getPool } from ${JSON.stringify(clientUrl)};`
      + `try { await getPool(); } catch { /* connecting is not the point */ }`,
    ], { encoding: 'utf8', env: { ...process.env, AUDIT_DB_URL: dsn, AUDIT_LOOP_DISABLE_SHARED: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`\\[db/client\\] store ${storeFingerprint(dsn)} \\(db=announce_probe\\)`),
      'getPool must emit the announcement for the store it resolved');
  });

  it('the fingerprint is stable ACROSS PROCESSES, which is the property it claims', () => {
    // Code-audit R1 M11: the existing stability test compares two calls in ONE
    // process and checks the hex shape. That cannot fail for a fingerprint
    // derived from process-local state (a random salt, a counter) — and
    // "two processes on the same store print the same 16 chars" is the entire
    // reason this value exists. So: actually start another process.
    const dsn = 'postgresql://u:p@some.host.example:5432/audit_loop';
    const clientUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'client.mjs')).href;
    const run = () => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { storeFingerprint } from ${JSON.stringify(clientUrl)};`
        + `process.stdout.write(storeFingerprint(${JSON.stringify(dsn)}) || '');`,
      ], { encoding: 'utf8', env: { ...process.env, AUDIT_DB_URL: '' } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const a = run();
    const b = run();
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, b, 'two separate processes must fingerprint one store identically');
    assert.equal(a, storeFingerprint(dsn), 'and agree with this process');
  });

  it('AGREES WITH THE DRIVER on every shape — differential, not case-by-case', async (t) => {
    // Three audit rounds argued about this resolver's edge cases, and every one
    // was settled by probing `pg-connection-string` — the parser `pg` actually
    // uses. So stop restating its answers as hand-written expectations and
    // compare against it directly: the contract is literally "resolve what the
    // driver would resolve", and a test that encodes my reading of that is a
    // test of my reading.
    //
    // RESOLVED THROUGH `pg`, never as a top-level import. The oracle is not
    // "some copy of pg-connection-string" — it is THE copy `pg` parses with. A
    // direct `import 'pg-connection-string'` resolves by this package's own
    // layout, so a declared version or a strict (pnpm-style) node_modules could
    // hand this test a DIFFERENT parser than the driver uses, and it would go on
    // passing while asserting against the wrong thing. That is the same
    // "resolved apart" shape the code under test exists to close.
    //
    // Declaring it in devDependencies — the first attempt, to satisfy
    // `knip:gate` — actively invited that skew, so the declaration was removed.
    let parse;
    let parserPath;
    try {
      const require_ = createRequire(import.meta.url);
      parserPath = createRequire(require_.resolve('pg')).resolve('pg-connection-string');
      const mod = await import(pathToFileURL(parserPath).href);
      // CJS reached by absolute path: the named export is only synthesised for
      // bare specifiers, so `parse` arrives on `.default` here. The guard below
      // caught exactly this — without it the whole comparison would have run
      // `undefined` against `undefined` and reported green.
      parse = mod.parse ?? mod.default?.parse;
    } catch (err) {
      t?.skip?.(`pg's own pg-connection-string not resolvable: ${err.message}`);
      return;
    }
    // Vacuous-pass guard: if this ever resolves something that is not a parser,
    // every assertion below would compare undefined to undefined and pass.
    assert.equal(typeof parse, 'function', `resolved ${parserPath} but it exports no parse()`);
    assert.deepEqual(
      { host: 'last.example', port: '2222' },
      (({ host, port }) => ({ host, port }))(parse('postgresql://d:1/db?host=first.example&host=last.example&port=1111&port=2222')),
      'the resolved parser does not behave like pg-connection-string — wrong oracle',
    );

    const cases = [
      'postgresql://h:5432/db',
      'postgresql://h/db',
      'postgresql://localhost:5432/db?host=prod.example.com',
      'postgresql://x.pooler.supabase.com:5432/db?port=6543',
      'postgresql://d:1/db?host=first.example&host=last.example',
      'postgresql://d:1/db?port=1111&port=2222',
      'postgresql://d:1/db?host=real.example&host=',
      'postgresql://d:1/db?port=2222&port=',
      'postgresql://d:1/db?host=',
      'postgresql://d:1/db?host=a&port=9&host=b&port=8',
      'postgresql://u:p@d:1/db?host=/var/run/postgresql',
      'postgresql://x.pooler.supabase.com:5432/db?port=06543',
      'postgresql://h/db?port=+6543',
      'postgresql://h:06543/db',
      'postgresql://h/db?port=6543abc',
      'postgresql://h/db?port=1e4',
      'postgresql://h:5432/?dbname=other',
    ];
    for (const dsn of cases) {
      const driver = parse(dsn);
      const mine = effectiveDbTarget(new URL(dsn));
      assert.equal(mine.host, driver.host, `host mismatch for ${dsn}`);
      // Ports compare NUMERICALLY, and the divergence is deliberate: the driver
      // passes `?port=06543` through verbatim while we canonicalise to '6543'.
      // Both reach the same socket, and a canonical form is required for the two
      // things built on this — a string comparison against '6543' in the pooler
      // guard, and one identity per database in the fingerprint. Asserting
      // string equality here would forbid the normalisation the guards need.
      // The driver leaves `port` empty when the DSN gives none; we default to
      // 5432, the same connection. Compare only where it committed.
      if (driver.port) {
        // `parseInt(v, 10)` is the driver's OWN coercion — pg does
        // `this.port = parseInt(val('port', config), 10)` in
        // connection-parameters.js — so comparing with `Number()` here would
        // assert against a rule pg does not use, which is the R6 defect
        // restated as a test.
        assert.equal(parseInt(mine.port, 10), parseInt(driver.port, 10), `port mismatch for ${dsn}`);
      }
      // `''` and `null` both mean "this DSN names no database" — the parser
      // says null, we say empty string. Normalise before comparing so the
      // pathless case is not a false mismatch.
      assert.equal(mine.database || null, driver.database ?? null, `database mismatch for ${dsn}`);
    }
  });

  it('a padded ?port= cannot smuggle past the transaction-pooler refusal', () => {
    // Code-audit R5. `?port=06543` connects to 6543 but compared unequal to the
    // '6543' literal the guard tests, so every zero-padded or space-padded form
    // sailed through the check that exists to refuse the Supabase transaction
    // pooler. `+` is the URL encoding of a space, which is why it appears here.
    // `6543abc` and `1e4` are the parseInt-vs-Number cases (code-audit R6):
    // pg does `parseInt(port, 10)`, so `6543abc` connects to 6543 while
    // `Number('6543abc')` is NaN — which left the value verbatim and let the
    // string comparison against '6543' pass it straight through.
    for (const padded of ['06543', '+6543', '6543%20', '%206543', '6543abc', '6543.9']) {
      assert.throws(
        () => assertSafeDsn(`postgresql://x.pooler.supabase.com:5432/db?port=${padded}`),
        /Transaction pooler/i,
        `?port=${padded} reaches 6543 and must be refused`,
      );
    }
    // The direction it must not fire: the Session pooler stays usable.
    assert.doesNotThrow(() => assertSafeDsn('postgresql://x.pooler.supabase.com:5432/db?port=05432'));
  });

  it('one database has ONE identity however its port is written', () => {
    // `new URL` normalises the authority (`:06543` → `6543`) but not the query
    // form, so without canonicalisation the same store fingerprinted two ways —
    // and a fingerprint that differs between two runs against one database is
    // exactly what this change exists to prevent.
    const canonical = dbIdentity('postgresql://h:6543/db');
    for (const variant of ['postgresql://h:06543/db', 'postgresql://h/db?port=06543', 'postgresql://h/db?port=6543']) {
      assert.equal(dbIdentity(variant), canonical, `${variant} must share one identity`);
    }
    assert.equal(storeFingerprint('postgresql://h/db?port=06543'), storeFingerprint('postgresql://h:6543/db'));
  });

  it('`?dbname=` is NOT treated as an override — challenged, then measured', () => {
    // The final gate claimed pg falls back to `config.dbname` when `database` is
    // empty. Measured against the real `ConnectionParameters`, it does not — it
    // falls back to the OS USERNAME (`this.database = this.user`):
    //
    //   postgresql://h:5432/real?dbname=other  → 'real'
    //   postgresql://h:5432/?dbname=other      → 'User', NOT 'other'
    //
    // So reading `dbname` here would invent a behaviour, and the pathless case
    // is deliberately named "no database" rather than mirroring a fallback that
    // would make this identity depend on who is running the process — two
    // machines would then fingerprint one DSN differently.
    assert.match(dbIdentity('postgresql://h:5432/real?dbname=other'), /\/real$/);
    assert.equal(
      dbIdentity('postgresql://h:5432/?dbname=other'),
      dbIdentity('postgresql://h:5432/'),
      'a pathless DSN must not adopt ?dbname=',
    );
  });
});

describe('renderDriftIssue — the verdict carries its corpus and its store', () => {
  const base = {
    drift: CLEAN_DRIFT, threshold: 20, status: 'GREEN',
    generatedAt: '2026-09-04T00:00:00Z', commitSha: 'abc1234', refreshId: 'r-1',
    repoName: 'owner/repo',
  };

  it('states the symbol count beside the score', () => {
    const { markdown } = renderDriftIssue({ ...base, symbolCount: 1842, store: storeDescriptor(DSN) });
    assert.match(markdown, /\*\*Corpus measured:\*\* 1842 symbols/);
  });

  it('states the store', () => {
    const { markdown } = renderDriftIssue({ ...base, symbolCount: 1842, store: storeDescriptor(DSN) });
    assert.match(markdown, new RegExp(`\\*\\*Store:\\*\\* \`${storeFingerprint(DSN)} \\(db=audit_loop\\)\``));
    assert.ok(!markdown.includes('example-host'), 'the report must not publish a hostname');
  });

  it('an UNKNOWN corpus says unknown — never 0, never an omitted line', () => {
    // The load-bearing case. A count that could not be read must not render as
    // an empty snapshot (0) nor vanish (which reads as a corpus nobody
    // questioned). Both readings are how a blind run passes for a clean one.
    const { markdown } = renderDriftIssue({ ...base, symbolCount: null, store: null });
    assert.match(markdown, /\*\*Corpus measured:\*\* unknown/);
    assert.ok(!/\*\*Corpus measured:\*\* 0 symbols/.test(markdown), 'unknown must not render as 0');
    assert.match(markdown, /\*\*Store:\*\* unknown/);
  });

  it('a zero corpus reads as zero, not as unknown (the other direction)', () => {
    // Negative control for the branch above: 0 is a real, measured answer and
    // must not be swallowed by the null path via a truthiness test.
    const { markdown } = renderDriftIssue({ ...base, symbolCount: 0, store: storeDescriptor(DSN) });
    assert.match(markdown, /\*\*Corpus measured:\*\* 0 symbols/);
  });

  it('omitting both arguments entirely still renders both lines', () => {
    // A caller that has not been updated must produce an honest report, not a
    // report missing the two lines that make it falsifiable.
    const { markdown } = renderDriftIssue(base);
    assert.match(markdown, /\*\*Corpus measured:\*\* unknown/);
    assert.match(markdown, /\*\*Store:\*\* unknown/);
  });
});

describe('renderHeader — architecture-map.md says which store it rendered from', () => {
  const base = {
    repoName: 'owner/repo', generatedAt: '2026-09-04T00:00:00Z', commitSha: 'abc1234',
    refreshId: 'r-1', drift: 0, threshold: 20, status: 'GREEN',
    domainCount: 3, symbolCount: 1842, violationCount: 0,
  };

  it('names the store beside the refresh id', () => {
    const md = renderHeader({ ...base, store: storeDescriptor(DSN) });
    assert.match(md, new RegExp(`- Store: \`${storeFingerprint(DSN)} \\(db=audit_loop\\)\``));
  });

  it('renders unknown when there is no store, rather than omitting the line', () => {
    assert.match(renderHeader(base), /- Store: unknown/);
  });

  it('renderArchitectureMap FORWARDS the store to the header', () => {
    // The pass-through, which is where a two-argument change quietly loses one.
    // `arch:render`'s call site is the only production caller and it cannot be
    // exercised without a live snapshot, so the seam is asserted here instead.
    const { markdown } = renderArchitectureMap({
      repoName: 'owner/repo', generatedAt: '2026-09-04T00:00:00Z', commitSha: 'abc1234',
      refreshId: 'r-1', drift: 0, threshold: 20, status: 'GREEN',
      symbols: [], violations: [], store: storeDescriptor(DSN),
    });
    assert.match(markdown, new RegExp(`- Store: \`${storeFingerprint(DSN)} \\(db=audit_loop\\)\``));
  });
});

describe('arch:duplicates renderText — a clean result names its corpus', () => {
  it('the ZERO-cluster sentence carries the snapshot size and store', () => {
    // This exact sentence is what the incident produced against the wrong
    // database. "No duplicates" and "nothing to have duplicates in" were one
    // string.
    const out = renderText([], 'owner/repo', {
      truncated: false, limit: 20, symbolCount: 1842, store: storeDescriptor(DSN),
    });
    assert.match(out, /no cross-file exact-duplicate clusters/);
    assert.match(out, /snapshot: 1842 symbols/);
    assert.match(out, /store: [0-9a-f]{16} \(db=audit_loop\)/);
  });

  it('an unknown corpus is stated LOUDLY in the zero-cluster branch', () => {
    const out = renderText([], 'owner/repo', { truncated: false, limit: 20 });
    assert.match(out, /an UNKNOWN number of symbols/);
    assert.match(out, /store: unknown/);
  });

  it('a non-empty result carries the same line', () => {
    const clusters = [{ kind: 'function', symbolNames: ['f'], fileCount: 2, filePaths: ['a.mjs', 'b.mjs'], examplePurpose: '' }];
    const out = renderText(clusters, 'owner/repo', {
      truncated: false, limit: 20, symbolCount: 12, store: storeDescriptor(DSN),
    });
    assert.match(out, /snapshot: 12 symbols/);
  });
});

// ── The advisories must not contaminate stdout (plan-audit R1 M2) ───────────
//
// Two repo invariants meet here: diagnostics go to stderr with a trailing
// newline, and stdout on a `--json` command carries exactly ONE JSON value. This
// change adds two new advisories — the empty-DSN notice and the ledger
// durability warning — and both fire on paths that ALSO have JSON output. An
// in-process assertion on the message text cannot see this: a `console.log`
// would pass that test and still break every scheduled CI consumer parsing
// stdout. So these run a real child process and parse its actual stdout.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const _tmp = [];
after(() => {
  for (const d of _tmp) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

describe('new advisories stay on stderr — stdout stays machine-readable', () => {
  it('the empty-DSN notice goes to stderr, and stdout receives nothing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-cwd-'));
    _tmp.push(home, cwd);
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=postgres://shared/db\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home, AUDIT_DB_URL: '' };
    for (const k of ['AUDIT_POSTGRES_URL', 'DOTENV_CONFIG_PATH', '_AUDIT_LOOP_SHARED_LOADED', 'AUDIT_LOOP_DISABLE_SHARED']) delete env[k];
    const clientUrl = pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'client.mjs')).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { resolveDbUrl } from ${JSON.stringify(clientUrl)};`
      + `resolveDbUrl();`
      + `process.stdout.write(JSON.stringify({ ok: true }) + '\\n');`,
    ], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /set but EMPTY/, 'the advisory must be on stderr');
    assert.deepEqual(JSON.parse(r.stdout), { ok: true }, 'stdout must parse as exactly one JSON value');
    assert.equal(r.stdout.split('\n').filter(Boolean).length, 1, 'stdout must carry exactly one line');
  });

  it('every new stderr advisory ends with exactly one newline', () => {
    // Not cosmetic: two advisories written without one concatenate into a single
    // unreadable line, and the repo's diagnostic contract requires the newline.
    // Asserted on the emitted templates, since a run only fires one at a time.
    let checked = 0;
    for (const rel of ['scripts/lib/load-shared-env.mjs', 'scripts/lib/debt-ledger.mjs']) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      for (const m of src.matchAll(/process\.stderr\.write\(\s*([\s\S]*?)\)\s*;/g)) {
        const body = m[1];
        checked++;
        assert.ok(/\\n['`]\s*,?\s*$/.test(body.trim()), `${rel}: a stderr write does not end in \\n: ${body.slice(-80)}`);
      }
    }
    // Vacuous-pass guard: a regex that stops matching turns this into a test
    // that asserts nothing and still reports green.
    assert.ok(checked >= 5, `expected to inspect at least 5 stderr writes, saw ${checked}`);
  });
});
