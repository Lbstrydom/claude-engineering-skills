/**
 * @fileoverview `/ship` Step 0.5h read ONE store and reported `0 open` while a
 * consumer on a different store had eight genuinely open reports. These guard
 * the fan-out that replaced it.
 *
 * Two properties carry the weight, and both are about what must NOT happen:
 *
 *  - **A store nobody could reach must never render as an empty queue.** That
 *    equivalence IS the original defect; reproducing it inside the fix would be
 *    the whole point missed.
 *  - **The DSN must never reach an operator-facing string.** This output is
 *    printed at ship time and pasted into a public repo's status log, and one
 *    consumer's store is a corporate internal host.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  UNRESOLVED, parseStoreEnv, resolveRepoStore, discoverStores, describeStore, renderPolicyUnreachable,
} from '../scripts/lib/upstream/store-discovery.mjs';
import { collectQueues, renderQueues } from '../scripts/upstream-queues.mjs';
import { populationFromFanout } from '../scripts/lib/population.mjs';
import { storeFingerprint } from '../scripts/lib/db/client.mjs';

const NAS_DSN = 'postgres://u:pw@nas.example.invalid:5433/audit_loop';
const AZURE_DSN = 'postgres://audit_app:s3cret@corp-db.example.invalid:5432/audit_loop';
const NAS_FP = storeFingerprint(NAS_DSN);
const AZURE_FP = storeFingerprint(AZURE_DSN);

const stripAnsi = (t) => String(t).replace(/\[[0-9;]*m/g, '');

describe('parseStoreEnv', () => {
  test('reads the DSN and the SSL mode from the same file', () => {
    const r = parseStoreEnv(`FOO=1\nAUDIT_DB_URL=${AZURE_DSN}\nAUDIT_DB_SSL_MODE=require\n`);
    assert.equal(r.url, AZURE_DSN);
    assert.equal(r.sslMode, 'require');
  });

  test('accepts the OTHER DSN spelling', () => {
    // `AUDIT_POSTGRES_URL` is the second key `resolveDbUrl` reads. A consumer
    // using it would otherwise read as having no store at all.
    const r = parseStoreEnv(`AUDIT_POSTGRES_URL=${NAS_DSN}\nAUDIT_POSTGRES_SSL_MODE=no-verify\n`);
    assert.equal(r.url, NAS_DSN);
    assert.equal(r.sslMode, 'no-verify');
  });

  test('last wins within a file, as dotenv does', () => {
    const r = parseStoreEnv(`AUDIT_DB_URL=${NAS_DSN}\nAUDIT_DB_URL=${AZURE_DSN}\n`);
    assert.equal(r.url, AZURE_DSN);
  });

  test('strips quotes and whitespace', () => {
    assert.equal(parseStoreEnv(`AUDIT_DB_URL= "${NAS_DSN}" \n`).url, NAS_DSN);
  });

  test('no DSN ⇒ no SSL mode either — the bundle is not split', () => {
    // Pairing one layer's DSN with another's TLS setting is the cross-key
    // precedence hole load-shared-env documents.
    const r = parseStoreEnv('AUDIT_DB_SSL_MODE=require\n');
    assert.equal(r.url, null);
    assert.equal(r.sslMode, null);
  });
});

describe('resolveRepoStore — layering', () => {
  const shared = `AUDIT_DB_URL=${NAS_DSN}\nAUDIT_DB_SSL_MODE=no-verify\n`;

  test('the repo .env wins over the shared config', () => {
    const r = resolveRepoStore({
      repoEnvText: `AUDIT_DB_URL=${AZURE_DSN}\nAUDIT_DB_SSL_MODE=require\n`,
      sharedEnvText: shared,
    });
    assert.equal(r.url, AZURE_DSN);
    assert.equal(r.sslMode, 'require');
    assert.equal(r.layer, 'repo');
  });

  test('a repo with no DSN falls back to the shared config', () => {
    // Not optional polish: three of four real repos take this path, and a
    // discovery that read only .env declared them invisible while their own
    // tooling connects fine.
    const r = resolveRepoStore({ repoEnvText: 'OPENAI_API_KEY=x\n', sharedEnvText: shared });
    assert.equal(r.url, NAS_DSN);
    assert.equal(r.layer, 'shared');
  });

  test('a repo .env DSN never inherits the SHARED ssl mode', () => {
    const r = resolveRepoStore({
      repoEnvText: `AUDIT_DB_URL=${AZURE_DSN}\n`, sharedEnvText: shared,
    });
    assert.equal(r.url, AZURE_DSN);
    assert.equal(r.sslMode, null, 'took the shared TLS setting for a local DSN');
  });

  test('neither layer ⇒ nothing, and it says so by returning a null layer', () => {
    assert.deepEqual(resolveRepoStore({ repoEnvText: null, sharedEnvText: null }),
      { url: null, sslMode: null, layer: null });
  });
});

describe('discoverStores', () => {
  test('refuses without a fingerprint function rather than defaulting', () => {
    // Defaulting would make every store unresolvable — every consumer queue
    // silently invisible, arriving as a clean result. That is the failure this
    // module exists to end, so it must not be reachable by omission.
    assert.throws(
      () => discoverStores({ repos: [], readEnvText: () => null }),
      /fingerprintOf is required/,
    );
  });

  const repos = [
    { name: 'wine', path: '/w' },
    { name: 'organiser', path: '/o' },
    { name: 'storyline', path: '/s' },
  ];
  const envs = {
    '/w': 'NOTHING=1\n',
    '/o': 'NOTHING=1\n',
    '/s': `AUDIT_DB_URL=${AZURE_DSN}\nAUDIT_DB_SSL_MODE=require\n`,
  };
  const base = {
    repos,
    readEnvText: (p) => envs[p] ?? null,
    fingerprintOf: storeFingerprint,
    readSetupPointer: () => ({ present: false }),
    sharedEnvText: `AUDIT_DB_URL=${NAS_DSN}\n`,
    self: { name: 'this repo', url: NAS_DSN, sslMode: null },
  };

  test('dedupes by store, not by repo', () => {
    const { stores, unresolved } = discoverStores(base);
    assert.equal(stores.length, 2, 'four repos on two stores must yield two queries');
    assert.deepEqual(unresolved, []);
    const nas = stores.find((s) => s.fingerprint === NAS_FP);
    assert.deepEqual(nas.repos, ['this repo', 'wine', 'organiser']);
    assert.deepEqual(stores.find((s) => s.fingerprint === AZURE_FP).repos, ['storyline']);
  });

  test('the consumer on its OWN store is discovered — the whole point', () => {
    const { stores } = discoverStores(base);
    assert.ok(stores.some((s) => s.fingerprint === AZURE_FP && s.repos.includes('storyline')));
  });

  test('this repo is included, so the fan-out is a superset of the old read', () => {
    const { stores } = discoverStores(base);
    assert.ok(stores.some((s) => s.repos.includes('this repo')));
  });

  test('an absent repo directory is REPORTED, never dropped', () => {
    const { unresolved } = discoverStores({ ...base, repoExists: (p) => p !== '/s' });
    assert.deepEqual(unresolved, [{ repo: 'storyline', reason: UNRESOLVED.NO_REPO }]);
  });

  test('a repo with no resolvable DSN is REPORTED, never dropped', () => {
    const { stores, unresolved } = discoverStores({
      ...base, sharedEnvText: null,
    });
    // Two stores survive: storyline's own, and this repo's (passed as `self`,
    // which does not depend on the shared file). wine and organiser had only
    // the shared layer, so they now resolve to nothing — and must be NAMED.
    assert.equal(stores.length, 2);
    assert.deepEqual(unresolved.map((u) => u.repo).sort(), ['organiser', 'wine']);
    assert.ok(unresolved.every((u) => u.reason === UNRESOLVED.NO_DSN));
  });

  test('an unparseable DSN is reported, not silently treated as absent', () => {
    const { unresolved } = discoverStores({
      ...base, self: { name: 'this repo', url: 'not a dsn', sslMode: null },
    });
    assert.ok(unresolved.some((u) => u.repo === 'this repo' && u.reason === UNRESOLVED.BAD_DSN));
  });
});

describe('discoverStores — policy-private consumers (never queried, never counted)', () => {
  const repos = [
    { name: 'wine-cellar-app', alias: 'wine', path: '/w' },
    { name: 'orgx-tools', alias: 'orgx', path: '/p' },
  ];
  const PRIVATE_DSN = 'postgres://u:pw@private.example.invalid:5432/audit_loop';
  const PRIVATE_FP = storeFingerprint(PRIVATE_DSN);
  const envs = { '/w': `AUDIT_DB_URL=${NAS_DSN}\n`, '/p': `AUDIT_DB_URL=${PRIVATE_DSN}\n` };
  const DECLARED = { present: true, upstreamReachable: false, policy: 'private', problems: [] };
  const run = (pointers, extra = {}) => discoverStores({
    repos, readEnvText: (p) => envs[p] ?? null,
    fingerprintOf: storeFingerprint,
    readSetupPointer: (p) => pointers[p] ?? { present: false },
    ...extra,
  });

  test('a declared consumer is listed, absent from stores, and its fingerprint is never queried', () => {
    const { stores, policyUnreachable } = run({ '/p': DECLARED });
    assert.deepEqual(policyUnreachable, [{ repo: 'orgx-tools', alias: 'orgx', reason: 'unreachable-by-policy' }]);
    assert.deepEqual(stores.map((s) => s.fingerprint), [NAS_FP]);
    // The query spy: collectQueues asks only the stores discovery returned.
    const asked = [];
    const r = collectQueues({ stores, unresolved: [], policyUnreachable, query: (s) => { asked.push(s.fingerprint); return { ok: true, rows: [], reason: null }; } });
    assert.equal(asked.includes(PRIVATE_FP), false, 'the private store was queried');
    assert.equal(r.storesQueried, 1);
  });

  test('negative control: same fixture without the declaration is queried as today', () => {
    const { stores, policyUnreachable } = run({});
    assert.deepEqual(policyUnreachable, []);
    assert.ok(stores.some((s) => s.fingerprint === PRIVATE_FP));
    for (const pointer of [{ present: true, upstreamReachable: true, policy: 'reachable', problems: [] }, { present: true, upstreamReachable: null, policy: 'absent', problems: [] }]) {
      assert.ok(run({ '/p': pointer }).stores.some((s) => s.fingerprint === PRIVATE_FP));
    }
  });

  test('a malformed declaration fails closed as policy-undeterminable', () => {
    for (const problems of [
      ['"upstreamReachable" must be a boolean'],
      ['.audit-loop/store-setup.json is not valid JSON'],
      ['.audit-loop/store-setup.json could not be read (EACCES)'],
    ]) {
      const { stores, policyUnreachable } = run({ '/p': { present: true, upstreamReachable: null, policy: 'undeterminable', problems } });
      assert.deepEqual(policyUnreachable, [{ repo: 'orgx-tools', alias: 'orgx', reason: 'policy-undeterminable' }]);
      assert.equal(stores.some((s) => s.fingerprint === PRIVATE_FP), false);
    }
  });

  test('an unrelated pointer problem (a bad "check" field) is not a policy signal', () => {
    const { policyUnreachable, stores } = run({ '/p': { present: true, upstreamReachable: null, policy: 'absent', problems: ['"check" must be a non-empty string'] } });
    assert.deepEqual(policyUnreachable, []);
    assert.ok(stores.some((s) => s.fingerprint === PRIVATE_FP));
  });

  test('a reachable consumer on the SAME store is refused as shared-with-policy-consumer', () => {
    const sharedEnvs = { '/w': `AUDIT_DB_URL=${PRIVATE_DSN}\n`, '/p': `AUDIT_DB_URL=${PRIVATE_DSN}\n` };
    const { stores, policyUnreachable } = run({ '/p': DECLARED }, { readEnvText: (p) => sharedEnvs[p] ?? null });
    assert.deepEqual(stores, []);
    assert.deepEqual(policyUnreachable.map((x) => [x.alias, x.reason]).sort(),
      [['orgx', 'unreachable-by-policy'], ['wine', 'shared-with-policy-consumer']]);
  });

  test('a private consumer that falls through to the shared env layer still refuses the shared store', () => {
    const { stores, policyUnreachable } = run({ '/p': DECLARED }, {
      readEnvText: () => null, sharedEnvText: `AUDIT_DB_URL=${NAS_DSN}\n`,
      self: { name: 'this repo', url: NAS_DSN, sslMode: null },
    });
    assert.deepEqual(stores, []);
    // Labelled `self`, not null (final gate G1): the refused shared store still names this repo.
    assert.ok(policyUnreachable.some((x) => x.repo === 'this repo' && x.alias === 'self' && x.reason === 'shared-with-policy-consumer'));
    assert.ok(policyUnreachable.some((x) => x.alias === 'wine' && x.reason === 'shared-with-policy-consumer'));
  });

  test('a private consumer with no resolvable DSN is simply listed', () => {
    const { stores, policyUnreachable, unresolved } = run({ '/p': DECLARED }, { readEnvText: (p) => (p === '/w' ? envs['/w'] : null) });
    assert.deepEqual(policyUnreachable.map((x) => x.reason), ['unreachable-by-policy']);
    assert.equal(stores.length, 1);
    assert.deepEqual(unresolved, []);
  });

  test('the DSN is never returned or rendered for a private consumer', () => {
    const out = run({ '/p': DECLARED });
    const blob = JSON.stringify({ policy: out.policyUnreachable, unresolved: out.unresolved }) + out.policyUnreachable.map(renderPolicyUnreachable).join('\n');
    for (const secret of ['pw', 'private.example', 'postgres://', PRIVATE_FP]) assert.equal(blob.includes(secret), false, secret);
  });

  test('the decision reads the structured policy field, never the problem strings', () => {
    // A problem text that LOOKS like a policy signal, under policy 'absent', must not be read as one.
    const decoy = { present: true, upstreamReachable: null, policy: 'absent', problems: ['could not be read upstreamReachable not valid JSON'] };
    assert.deepEqual(run({ '/p': decoy }).policyUnreachable, []);
    // An unknown policy value fails CLOSED.
    const unknown = { present: true, upstreamReachable: null, policy: 'surprise', problems: [] };
    assert.equal(run({ '/p': unknown }).policyUnreachable[0].reason, 'policy-undeterminable');
  });

  test('the SELF repo is evaluated too: private or undeterminable self is listed, never added', () => {
    const selfRepo = { name: 'this repo', path: '/self', url: NAS_DSN, sslMode: null };
    const withSelf = (pointer) => run({ '/p': { present: false } }, {
      self: selfRepo, readSetupPointer: (p) => (p === '/self' ? pointer : { present: false, policy: 'absent' }),
    });
    const priv = withSelf(DECLARED);
    assert.ok(priv.policyUnreachable.some((x) => x.repo === 'this repo' && x.alias === null && x.reason === 'unreachable-by-policy'));
    assert.equal(priv.stores.some((s) => s.repos.includes('this repo')), false);
    // self shares NAS with wine: the shared store is refused too.
    assert.deepEqual(priv.stores.map((x) => x.fingerprint), [PRIVATE_FP], 'only the unrelated store survives');
    assert.ok(priv.policyUnreachable.some((x) => x.alias === 'wine' && x.reason === 'shared-with-policy-consumer'));
    const und = withSelf({ present: true, upstreamReachable: null, policy: 'undeterminable', problems: ['x'] });
    assert.ok(und.policyUnreachable.some((x) => x.repo === 'this repo' && x.reason === 'policy-undeterminable'));
    // negative control: a reachable self is added as today
    assert.ok(withSelf({ present: true, upstreamReachable: true, policy: 'reachable', problems: [] }).stores.some((s) => s.repos.includes('this repo')));
  });

  test('a private consumer whose DSN resolves nowhere is flagged identityUnknown, and other stores are NOT refused', () => {
    const { stores, policyUnreachable } = run({ '/p': DECLARED }, { readEnvText: (p) => (p === '/w' ? envs['/w'] : null) });
    assert.equal(policyUnreachable[0].identityUnknown, true);
    assert.match(renderPolicyUnreachable(policyUnreachable[0]), /its store identity is unknown, so a shared store cannot be ruled out$/);
    assert.equal(stores.length, 1, 'wine is still queried');
    // a resolvable DSN carries no such flag
    assert.equal('identityUnknown' in run({ '/p': DECLARED }).policyUnreachable[0], false);
  });

  test('repoExists: an absent directory is never read for a pointer or env', () => {
    const pointerReads = [];
    const { unresolved } = run({}, { repoExists: (p) => p !== '/p', readSetupPointer: (p) => { pointerReads.push(p); return { present: false, policy: 'absent' }; } });
    assert.deepEqual(unresolved, [{ repo: 'orgx-tools', reason: UNRESOLVED.NO_REPO }]);
    assert.deepEqual(pointerReads, ['/w']);
  });

  test('a missing readSetupPointer throws rather than disabling the privacy rule', () => {
    assert.throws(() => discoverStores({ repos, readEnvText: () => null, fingerprintOf: storeFingerprint }), /readSetupPointer is required/);
  });

  test('the SELF repo contributes "self" to its store aliases, beside the consumers on it', () => {
    const selfRepo = { name: 'this repo', path: '/self', url: NAS_DSN, sslMode: null };
    const { stores } = run({}, { self: selfRepo });
    assert.deepEqual(stores.find((s) => s.fingerprint === NAS_FP).aliases, ['self', 'wine']);
    // and a population over the answered shared store lists self beside the consumer alias
    const collected = collectQueues({ stores, unresolved: [], query: () => ({ ok: true, rows: [], reason: null }) });
    assert.deepEqual(populationFromFanout({ ...collected, registry: [] }).measured.find((m) => m.store === NAS_FP.slice(0, 8)).consumers, ['self', 'wine']);
  });

  test('stores carry the consumer aliases that map to them', () => {
    assert.deepEqual(run({}).stores.find((s) => s.fingerprint === NAS_FP).aliases, ['wine']);
  });

  test('the three operator lines name the alias, never a host', () => {
    assert.equal(renderPolicyUnreachable({ repo: 'r', alias: 'orgx', reason: 'unreachable-by-policy' }),
      'unreachable-by-policy orgx — declared private; never queried, NOT counted');
    assert.equal(renderPolicyUnreachable({ repo: 'r', alias: null, reason: 'shared-with-policy-consumer' }),
      'refused r — shares a store with a policy-private consumer; never queried, NOT counted');
    assert.equal(renderPolicyUnreachable({ repo: 'r', alias: 'orgx', reason: 'policy-undeterminable' }),
      'not queried orgx — .audit-loop/store-setup.json unreadable or malformed; treated as private');
  });
});

describe('collectQueues + renderQueues — a policy-private consumer is never a count', () => {
  const policy = [{ repo: 'orgx-tools', alias: 'orgx', reason: 'unreachable-by-policy' }];
  const store = (fp) => ({ fingerprint: fp, url: 'x', sslMode: null, repos: ['r'], aliases: [] });

  test('0 eligible stores + 1 policy consumer: NOTHING WAS CHECKED, plus the policy line', () => {
    const r = collectQueues({ stores: [], unresolved: [], policyUnreachable: policy, query: () => assert.fail('queried') });
    assert.equal(r.storesQueried, 0);
    assert.equal(r.storesUnqueried, 0, 'policy consumers are not "we tried"');
    const out = stripAnsi(renderQueues(r));
    assert.match(out, /NOTHING WAS CHECKED/);
    assert.match(out, /unreachable-by-policy orgx — declared private; never queried, NOT counted/);
    assert.equal(/0 open/.test(out), false);
  });

  test('negative control: 1 answered store keeps its count and still prints the policy line', () => {
    const r = collectQueues({ stores: [store(NAS_FP)], unresolved: [], policyUnreachable: policy, query: () => ({ ok: true, rows: [], reason: null }) });
    const out = stripAnsi(renderQueues(r));
    assert.match(out, /0 open/);
    assert.match(out, /unreachable-by-policy orgx/);
    assert.deepEqual(r.policyUnreachable, policy);
  });
});

describe('describeStore — never leaks the DSN', () => {
  test('renders a fingerprint plus who uses it, and no host or credential', () => {
    const out = describeStore({ fingerprint: AZURE_FP, repos: ['storyline'] });
    for (const secret of ['s3cret', 'audit_app', 'corp-db', 'example.invalid', 'postgres://']) {
      assert.equal(out.includes(secret), false, `describeStore leaked "${secret}"`);
    }
    assert.ok(out.includes(AZURE_FP) && out.includes('storyline'));
  });
});

describe('collectQueues + renderQueues — unqueried is never a clean queue', () => {
  const store = (fp, repos) => ({ fingerprint: fp, url: 'x', sslMode: null, repos });
  const rows = (n, sev = 'HIGH') => Array.from({ length: n }, (_, i) => ({
    id: `${'0'.repeat(7)}${i}-aaaa-bbbb-cccc-dddddddddddd`, severity: sev, title: `t${i}`, repo_name: 'r',
  }));

  test('a store that could not be reached does NOT count as zero open', () => {
    // The original defect, reproduced inside the fix: reporting "0 open" for a
    // question that was never asked.
    const r = collectQueues({
      stores: [store(AZURE_FP, ['storyline'])],
      unresolved: [],
      query: () => ({ ok: false, rows: [], reason: 'cloud-off' }),
    });
    assert.equal(r.storesQueried, 0);
    assert.equal(r.storesUnqueried, 1);
    const out = stripAnsi(renderQueues(r));
    assert.match(out, /NOTHING WAS CHECKED/);
    assert.match(out, /NOT an empty queue/);
    assert.equal(/0 open/.test(out), false, 'rendered an unasked question as a clean queue');
  });

  test('a genuinely empty queue says so, and says how many stores answered', () => {
    const r = collectQueues({
      stores: [store(NAS_FP, ['this repo'])], unresolved: [],
      query: () => ({ ok: true, rows: [], reason: null }),
    });
    const out = stripAnsi(renderQueues(r));
    assert.match(out, /0 open/);
    assert.match(out, /1 store/);
  });

  test('a partial failure is reported ALONGSIDE the good news, not instead of it', () => {
    // The dangerous middle: one store answers, another does not, and the count
    // looks authoritative.
    const r = collectQueues({
      stores: [store(NAS_FP, ['this repo']), store(AZURE_FP, ['storyline'])],
      unresolved: [],
      query: (s) => (s.fingerprint === NAS_FP
        ? { ok: true, rows: rows(2), reason: null }
        : { ok: false, rows: [], reason: 'timeout' }),
    });
    assert.equal(r.totalOpen, 2);
    const out = stripAnsi(renderQueues(r));
    assert.match(out, /unqueried/);
    assert.match(out, /were NOT counted above/);
    assert.ok(out.includes(AZURE_FP));
  });

  test('an unresolved consumer is surfaced even when every store answered clean', () => {
    // Silence here would be the same shape as the bug: a consumer whose queue
    // nobody can see, under a green headline.
    const r = collectQueues({
      stores: [store(NAS_FP, ['this repo'])],
      unresolved: [{ repo: 'storyline', reason: UNRESOLVED.NO_DSN }],
      query: () => ({ ok: true, rows: [], reason: null }),
    });
    const out = stripAnsi(renderQueues(r));
    assert.match(out, /0 open/);
    assert.match(out, /storyline/);
    assert.match(out, /queue is invisible/);
  });

  test('items are ordered most-severe first across stores', () => {
    const r = collectQueues({
      stores: [store(NAS_FP, ['a']), store(AZURE_FP, ['b'])],
      unresolved: [],
      query: (s) => ({
        ok: true,
        rows: s.fingerprint === NAS_FP ? rows(1, 'MEDIUM') : rows(1, 'BLOCKER'),
        reason: null,
      }),
    });
    assert.deepEqual(r.items.map((i) => i.severity), ['BLOCKER', 'MEDIUM']);
  });

  test('every rendered item carries the store it came from', () => {
    const r = collectQueues({
      stores: [store(AZURE_FP, ['storyline'])], unresolved: [],
      query: () => ({ ok: true, rows: rows(1), reason: null }),
    });
    assert.ok(r.items[0].store.includes(AZURE_FP));
    assert.ok(r.items[0].store.includes('storyline'));
  });
});
