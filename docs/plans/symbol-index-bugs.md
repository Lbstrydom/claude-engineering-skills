# symbol-index bugs — patches for arch:refresh --force + arch:duplicates thin-delegate

- **Date drafted**: 2026-05-04 (originally in wine-cellar-app/docs/plans as a forwarding note)
- **Date moved here**: 2026-05-11 (after confirming both bugs still present at `scripts/symbol-index/{refresh.mjs:234-245, extract.mjs}`)
- **Status**: Draft — ready to apply in this repo
- **Scope**: Two bugs in `scripts/symbol-index/{extract.mjs, refresh.mjs}`. Both fixes were validated as local overrides in a consuming repo; both bugs verified still present here on 2026-05-11. Applying these patches here propagates the fixes to every consuming repo via the plugin sync.

---

## Bug 1 — `--force` flag is a no-op when a prior refresh is stuck "in flight"

### Symptom

```
$ npm run arch:refresh:full -- --force
  [refresh] loaded 46 domain rules from .audit-loop/domain-map.json
  [learning] Cloud store connected
refresh: fatal: Error: A refresh is already in flight for this repo. Pass --force to abort.
    at openRefreshRun (...learning-store.mjs:1568)
```

The error message tells the operator to "Pass `--force` to abort", but the
`--force` flag does nothing — the error is rethrown unconditionally.

### Root cause

`scripts/symbol-index/refresh.mjs:235–245` (current upstream):

```js
let refreshId, cancellationToken;
try {
  const opened = await openRefreshRun({ repoId, mode, walkStartCommit });
  refreshId = opened.refreshId;
  cancellationToken = opened.cancellationToken;
} catch (err) {
  if (err.code === 'REFRESH_IN_FLIGHT' && !args.force) {
    logErr(err.message);
    process.exit(2);
  }
  throw err;        // ← FALLS THROUGH UNCONDITIONALLY when --force is passed
}
```

`openRefreshRun` fails with code `REFRESH_IN_FLIGHT` because the
`refresh_runs` table has a partial-unique index on
`(repo_id, status='running')` — exactly one in-flight run per repo. When
`--force` is passed the `if` is false, so control falls through to
`throw err`, which means `--force` IS NEVER HANDLED. The flag exists in the
arg parser (`refresh.mjs:64 — args.force = true`) but the implementation is
missing.

The repository already exposes `abortRefreshRun({refreshId, reason})` in
`scripts/learning-store.mjs:1598` — it sets `status='aborted'`, clearing the
partial-unique constraint. The `--force` path just needs to call it before
retrying.

### Patch (drop-in replacement for refresh.mjs:234–246)

```js
let refreshId, cancellationToken;
try {
  const opened = await openRefreshRun({ repoId, mode, walkStartCommit });
  refreshId = opened.refreshId;
  cancellationToken = opened.cancellationToken;
} catch (err) {
  if (err.code === 'REFRESH_IN_FLIGHT' && !args.force) {
    logErr(err.message);
    process.exit(2);
  }
  if (err.code === 'REFRESH_IN_FLIGHT' && args.force) {
    // Abort the prior in-flight run, then retry openRefreshRun.
    // Heuristic: there can only be one row per (repo_id, status='running')
    // — the partial unique index that produced 23505 in the first place.
    logOk(`--force: aborting prior in-flight refresh for repo ${repoId}`);
    try {
      const r = await getReadClient();
      const { data: stale } = await r
        .from('refresh_runs')
        .select('id, last_heartbeat_at, started_at')
        .eq('repo_id', repoId)
        .eq('status', 'running')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!stale) {
        // Race: lock cleared between insert-attempt and lookup. Retry once.
        logOk(`--force: no in-flight row found, retrying openRefreshRun`);
      } else {
        await abortRefreshRun({ refreshId: stale.id, reason: 'aborted by --force' });
        logOk(`--force: aborted refresh_run ${stale.id}`);
      }
    } catch (abortErr) {
      logErr(`--force: failed to abort prior run: ${abortErr.message}`);
      process.exit(2);
    }
    // Retry openRefreshRun once after the abort.
    const opened = await openRefreshRun({ repoId, mode, walkStartCommit });
    refreshId = opened.refreshId;
    cancellationToken = opened.cancellationToken;
  } else {
    throw err;
  }
}
logOk(`opened refresh_run ${refreshId} (mode=${mode})`);
```

`getReadClient` is already imported in `refresh.mjs` (line 50). No new
imports needed.

### Risk

Aborting another worker's refresh run while it's actually running: the
worker's own heartbeat loop in `runWithHeartbeat` will see the
status≠'running' and exit (existing behaviour per
`learning-store.mjs:1607` comment). So this is a clean termination,
not a hang.

A more conservative variant would only abort runs whose `last_heartbeat_at`
is older than a stale-threshold (e.g. 5 min) — would prevent racing two
operators. Worth considering if multi-operator refreshes are common.

---

## Bug 2 — `arch:duplicates` flags thin-delegate facades as duplication

### Symptom

```
arch:duplicates: 20 cluster(s) — files share identical symbol bodies + signatures

1. [function] addListener  —  5 files
     • public/js/restaurantPairing.js
     • public/js/restaurantPairing/dishReview.js
     • public/js/restaurantPairing/quickPair.js
     • public/js/restaurantPairing/results.js
     • public/js/restaurantPairing/wineReview.js
```

These five `addListener` symbols each had byte-identical bodies:

```js
const addListener = (el, event, handler) => listenerRegistry.add(el, event, handler);
```

The `listenerRegistry` factory IS the SSoT — these per-module aliases are
deliberate thin facades pointing at the shared registry. arch:drift's
clustering correctly sees the bodies are identical, but the duplication
is **load-bearing in the facade pattern, not a code-smell**.

This false positive penalises any codebase that uses the
factory + per-module-alias pattern (which is one of the standard ways to
share state across module instances). Drift score stays elevated
indefinitely even after all "real" duplication is removed.

### Root cause

`scripts/symbol-index/extract.mjs` emits a symbol record for every function
or arrow-function variable declaration, regardless of body shape. Thin
delegates have nothing semantically distinguishing them from their target
— their entire purpose is to forward the call.

### Patch (additions to extract.mjs)

Add `isThinDelegate(bodyText)` near the top of the module:

```js
/**
 * Detect "thin delegate" functions — symbols whose entire body is a single
 * call into another symbol's method.
 *
 * Indexing thin delegates produces noise in arch:duplicates: every module
 * that wires into a shared factory (`createXyz()`) ends up with an
 * identical 1-line facade like
 *   const addListener = (el, e, h) => listenerRegistry.add(e, e, h);
 * which has identical body text across modules. The cluster analyser
 * rightly flags them as duplicates by signature, but the duplication is
 * deliberate and load-bearing — the facade IS the SSoT pattern.
 *
 * Skipping these at extraction time keeps arch:duplicates focused on real
 * structural duplication (multiple copies of independent logic).
 *
 * Heuristic: the body, after stripping comments + whitespace + trailing
 * `;`, must match one of:
 *   - `<expr>(<args>)`              — arrow expression body
 *   - `{ return <expr>(<args>); }`  — arrow/function block body, single return
 *   - `{ <expr>(<args>); }`         — arrow/function block body, single call
 * AND the called expression must be a member access (`obj.method`) — bare
 * function calls (`foo(x)`) are NOT classified as delegates because they
 * lack the target object that signals "wrapping a shared SSoT method".
 */
function isThinDelegate(bodyText) {
  if (!bodyText || typeof bodyText !== 'string') return false;
  let body = bodyText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  body = body.replace(/;\s*$/, '');
  const arrowIdx = body.search(/=>\s/);
  if (arrowIdx !== -1) {
    body = body.slice(arrowIdx + 2).trim();
  }
  if (body.startsWith('{') && body.endsWith('}')) {
    body = body.slice(1, -1).trim();
    body = body.replace(/^return\s+/, '').replace(/;\s*$/, '').trim();
  }
  body = body.replace(/^(await|return)\s+/, '').trim();
  // Member-access call: identifier(.identifier)+(args) where args is flat.
  const MEMBER_CALL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\s*\([^()]*\)$/;
  return MEMBER_CALL.test(body);
}
```

Then in `extractSymbols`, add to the per-candidate loop right after
`for (const c of candidates) {`:

```js
// Thin-delegate filter: skip 1-line facades like
//   const addListener = (...args) => target.method(...args);
// before they enter the cluster index. See isThinDelegate() above.
if (isThinDelegate(c.bodyText)) {
  stats.skippedDelegate++;
  continue;
}
```

And update the stats object init to include `skippedDelegate: 0`, and the
final `emitProgress` to log it:

```js
emitProgress(`done — symbols=${stats.symbolCount} ... skipped-delegate=${stats.skippedDelegate} ...`);
```

### Validation

11/11 unit cases pass on the heuristic — see `tests/unit/scripts/isThinDelegate.test.js`
in the wine-cellar-app override (or replicate from the patch above).

Positive cases (correctly classified as thin delegate):
- `const f = (a, b) => target.method(a, b)`
- `(a, b) => target.method(a, b)`
- `{ return target.method(a); }`
- `{ target.method(a); }`
- `{ return await store.write(payload); }`

Negative cases (correctly NOT classified):
- `{ const x = 1; return target.method(x); }` (multi-statement)
- `{ if (x) return target.method(x); }` (conditional)
- `{ return target.method(target.other(x)); }` (nested call — wrapped logic)
- `(x) => x + 1` (pure expression, no call)
- `{ return foo(x); }` (bare function call, no member access)
- `{ return this; }` (not a call)

### Trade-offs

**Pros**
- Arch:drift accounting reflects real structural duplication.
- Maintainability score reflects the SSoT pattern correctly.
- Self-documenting: the `skipped-delegate` count surfaces how often the
  pattern shows up across the indexed codebase.

**Cons**
- Symbol no longer appears in arch:render. For most callsite navigation
  this is fine (the target IS the symbol of interest), but operators
  searching for "where is `addListener` defined" lose the per-module hits.
  Mitigation: add an opt-in `--include-delegates` flag for arch tooling
  that wants the wider view.
- Heuristic-based — a sufficiently clever delegate (multi-line wrapper
  with logging or arg-massaging) is correctly NOT classified, but a
  conditional 1-liner like `(x) => store.set(x ?? defaultVal)` IS
  classified and skipped. That's the right call (conditional is part
  of "wrapping logic"), but operators should know the rule.

---

## Validation history

Both patches were running as local overrides in wine-cellar-app on 2026-05-04. Bug 2's heuristic was validated against 11/11 unit cases (positive + negative; see "Validation" section above). Both bugs re-confirmed present in this repo on 2026-05-11 (`refresh.mjs:234-245` byte-matches the buggy snippet; `extract.mjs` has no `isThinDelegate` / `skippedDelegate` markers). Apply the patches here; consuming repos pick up the fix via plugin sync.
