# Plan: Census and gate the un-drained-exit class (`process.exit` after a stdout write)

- **Date**: 2026-09-04
- **Status**: Complete — implemented 2026-09-04; 3 GPT rounds + deliberation (H2 `compromise`) + 4 Gemini gate passes; §8 owns the follow-up
- **Author**: Claude + Louis
- **Scope**: backend (AST detector + drift gate + CLI fixes + one AGENTS.md invariant; no UI)

> **Target domain(s)**: `shared-lib`, `audit-orchestration`, `symbol-index`, `tests`
> - ⚠ **Cross-domain work** — one new `shared-lib` detector consumed by a new
>   top-level gate CLI, plus fixes in `symbol-index`. The detector is deliberately
>   a single oracle rather than per-domain copies (§3.1).

> **This plan was written AFTER the implementation**, as the spec `/audit-code`
> audits the diff against. It is a faithful description of what shipped, not a
> forecast — every claim below is checkable against the commit named in Status.
> Figures carry their command (§6) so a reader can re-measure rather than trust.

---

## 1. Context Summary

`scripts/lib/cli-io.mjs` exports `finishAndExit(code)` because on Windows a
redirected/piped `process.stdout` is **asynchronous** — and `npm run x`,
`x | tee`, and every CI capture are pipes — so `process.exit()` discards
whatever has not flushed. The docstring names this as an **observed** failure,
not a theoretical one.

An `/audit-code` round on 2026-09-04 (findings R2 M6, R2 L3) raised two
instances in `scripts/symbol-index/`. The question this plan answers is not
"are those two real" (they are) but **"how large is the class, and what stops
the next one?"**

The failure is silent in both directions that matter:

- it is invisible in review — `process.stdout.write(report); process.exit(0)`
  is the obvious shape and reads as correct;
- it is invisible at runtime on Linux and on a terminal. **Only a pipe
  truncates.**

Where the write is a **JSON envelope a caller parses**, truncation is worse
than lossy: a `SyntaxError` attributed to whatever the caller was doing, or —
when the cut lands on a complete-looking prefix — a silently short result that
never surfaces as an error at all.

---

## 2. Requirement

1. **Census, not spot-fix.** Enumerate the whole class across `scripts/`
   mechanically. An LLM enumerating by reading stops early (`/audit-code`
   Step 3.7); the tool must enumerate.
2. **Fix the family the census came from** (`scripts/symbol-index/`).
3. **Gate it** so a new instance cannot appear unnoticed.
4. **Two deliberate non-findings**, per the operator's instruction and
   AGENTS.md:
   - a **stderr** write before an exit — stderr is synchronous enough for the
     skip messages every symbol-index CLI has;
   - the `--selfcheck-relocation` smoke contract's
     `console.log('OK'); process.exit(0);` — that literal shape **is** the
     documented contract (AGENTS.md §"CLI smoke contract") and is asserted
     across `CLI_SMOKE_SET`. It changes as a contract, with every
     implementation, or not at all.

---

## 3. Design

### 3.1 Detector — `scripts/lib/find-stdout-exit-sites.mjs` (`shared-lib`)

AST (`@babel/parser` + `@babel/traverse`), **not** a grep. Three distinctions
are invisible to text:

- **stderr vs stdout** once the write and the exit are several lines apart —
  a line-proximity grep cannot separate the excluded case from the target one;
- a write in a **nested function** that lexically precedes the exit but has not
  necessarily run — "same function" is an AST fact;
- a **shadowed** `process` / `console`. Resolution goes through
  `scope.getBinding`, the repo's established primitive
  (`find-rmsync-sites.mjs`, `import-binding.mjs`).

**Indirect writers, one file deep.** `writeReport(); process.exit(0)` is the
same defect as an inline write. A fixed point over the file's own call graph
marks any function that reaches a direct stdout write as a writer, and a call to
one counts as a write at the call site. Added after round-1 audit H4/M13
measured the gap at **51 further sites across 16 files** — a ~28% undercount on
a census whose whole claim is to be one. Callees resolve via `scope.getBinding`,
so a same-named import or parameter does not match.

**Reachability, not source order.** "Same function, lexically earlier" is the
naive reading and it over-reports by 2.1x. The dominant false shape:

```js
if (argv.includes('--help')) { console.log(usage); process.exit(0); }
…600 lines…
process.exit(2);          // ← paired against the help print
```

That branch already exited, so nothing it wrote can still be buffered.
`pathTerminatesBefore` drops a write whose own path provably ends first
(`return` / `throw` / `process.exit` / `finishAndExit` after it at any block
level between the write and the nearest common ancestor). Mutually exclusive
`if` arms are likewise never paired.

It remains an over-approximation of "executed before" — a write in an earlier
`if` that **falls through** counts, because it really can run, and the fix is
correct either way. The alternative is a full CFG, which no current requirement
needs.

**Payload triage** (`envelope` = `JSON.stringify` body or `emit()`, else
`text`), mirroring `check-cli-flags.mjs`'s `classifyPolarity` and for the same
reason: a severity-flat census gets worked top-down, doing the low-value
entries first. **Report-only ordering** — the gate is triage-blind, because a
net-new site is drift whichever payload it carries.

**Soundness over recall.** A **recovered (partial)** Babel parse is a hard
failure, never a silently-smaller result. `parseSource`'s own docstring warns
that a consumer needing sound structural coverage reads a truncated tree as
clean — a detector for a silent-truncation class must not go green by
truncation.

### 3.2 Gate — `scripts/check-stdout-flush.mjs` + `.stdout-flush-baseline.json`

Drift-only, baselined, in `knip-gate`'s shape. **A three-figure population would be a
wall, not a ratchet**, and a cried-wolf gate gets `--no-verify`'d — the lesson
`check-cli-flags.mjs` records from its own 24→82 baseline. Growth **and**
unrecorded shrink both fail (`size:ratchet`'s rule: a baseline pinned at the
historical high-water mark lets the count grow back unchallenged).

**Identity sets, not counts** — fix one site and add another and a count-only
comparison moves not at all (the "swap" blind spot
`check-emit-exit-agreement.mjs` documents). Identity is
`file::fnName::writeHow->exit(code)#ordinal`, deliberately **without** the line
number:
a line-keyed baseline churns on every edit above a site, and a baseline that
churns for unrelated reasons is one people `--update` reflexively — which is
how a real drift gets waved through. The enclosing **function name** was added
after round-1 audit H5/M3: file+shape+ordinal alone could not tell a removed
site from a different one added elsewhere in the same file, and scoping the
ordinal to a function also stops one edit renumbering every id below it.

Baseline read **fails closed**: malformed or missing is treated as EMPTY, so
every current site reads as growth. Loud and fixable beats a gate that goes
green on a damaged input.

### 3.3 Why not fix all 221 in this change

`finishAndExit` is **async**. In a synchronous function it cannot be awaited,
and `void finishAndExit(code)` returns immediately, letting the rest of the
function run before the exit lands — a control-flow change requiring per-site
judgement. (Round-1 H3 caught this detector making exactly that mistake in its
own terminator analysis, so the trap is not hypothetical.)

**Measured over the baselined sites** (`--report`, 2026-09-04; 249 total):

| shape | sites | of which envelope |
|---|---|---|
| async fn, statement position — `await finishAndExit` is a drop-in | 102 | 57 |
| sync fn, or non-statement position — needs control-flow restructuring | 106 | 44 |
| module top-level | 34 | 20 |

**Most cannot take the drop-in.** The remedy for those is to restructure
so an async caller owns the exit — which is what this change did by hand for
`duplicates.mjs`'s `--help` path, and it required reasoning about what must not
run after the write. Doing ~140 of those in the commit that also introduces the
detector means a control-flow regression would be attributed to the gate.

The ratchet makes the population shrink-only instead, and §8 owns the paydown.

> **Figure-provenance note.** An earlier draft of this argument quoted
> **253 / 298 / 50**. Those counted *every* `process.exit` in the baselined
> FILES, not the 242 sites — a different population, presented next to the 242
> as if comparable. The round-2 adjudicator required the reconciliation and was
> right to; the table above is the correct measurement, taken at 242 sites and
> left as-is because the Gemini-gate fixes that took the census to 249 added
> only `text` sites. The final census is **221 (105 envelope)** — LOWER than the
> 242 the table was taken at, because the Gemini-gate round also removed three
> classes of FALSE POSITIVE (a write inside a `return`/`throw` expression, a
> write inside a call to a local exit-helper, and a sibling terminator at the
> common-ancestor block level that was never scanned). Roughly 36 sites in the
> earlier baselines were not real. The shape counts above should therefore be
> re-derived before scoping §8, not reused. The conclusion is
> unchanged, which is precisely why the error was easy to miss.

`scripts/symbol-index/duplicates.mjs` was fixed **independently on `main`**
(commit range `1a7a1555..1a4dedc2`) and is untouched here; its version is
strictly better than the one drafted in this branch and reached the same
`args.help` shape.

---

## 4. Files

| File | Change |
|---|---|
| `scripts/lib/find-stdout-exit-sites.mjs` | new — detector |
| `scripts/check-stdout-flush.mjs` | new — gate CLI (`--json` / `--report` / `--update`) |
| `.stdout-flush-baseline.json` | new — 221 site identities |
| `scripts/gate-contracts/stdout-flush-gate.json` | new — poison-pill contract |
| `tests/fixtures/poison/stdout-flush-baseline-understated.json` | new — pill fixture |
| `tests/stdout-flush-detector.test.mjs` | new — 61 detector controls |
| `scripts/symbol-index/refresh.mjs` | 3 sites → `await finishAndExit` |
| `scripts/symbol-index/summarise-domains.mjs` | 1 site |
| `scripts/symbol-index/prune.mjs` | 1 site |
| `AGENTS.md` | the invariant the gate contract's `statedIn` points at |
| `package.json` | `stdout:flush:{gate,report,baseline}`; `gate` added to `check` |
| `scripts/.cli-catalog.json` | 3 entries (enforced by `dashboard-cli.test.mjs`) |
| `tests/gate-poison-pills.test.mjs` | pill registered |

---

## 5. Acceptance Criteria

1. `npm run stdout:flush:gate` exits 0 at baseline, 1 on a net-new site, 1 on
   an unrecorded shrink, 2 on an unknown flag.
2. A stderr-then-exit pair is **not** reported.
3. The `--selfcheck-relocation` shape is **not** reported, exempted
   structurally (by the enclosing `if` test) rather than by a path allowlist,
   so a new CLI adopting the contract needs no edit to the detector.
4. `scripts/symbol-index/` reports **zero** sites.
5. The poison pill executes and the gate fails against it (`gates:poison`).
6. `npm test` green; the full pre-push `check` chain green.

---

## 6. Verification (measured 2026-09-04, commit `a3b3dfe0`)

| Figure | Value | Command |
|---|---|---|
| Reachable sites | 221 (105 envelope / 116 text) | `npm run stdout:flush:report` |
| Naive "same function" count | 401 | detector with `pathTerminatesBefore` disabled |
| Sites fixed | 7 | `git show a3b3dfe0 -- scripts/symbol-index/` |
| Detector controls | 61 pass | `node --test tests/stdout-flush-detector.test.mjs` |
| Poison-pill suite | 41 pass | `node --test tests/gate-poison-pills.test.mjs` |
| Full suite | 14,998 tests / 0 fail / 39 skipped | `npm test` |

**Both drift directions were observed red, then green** (Step 4.5): a probe
site appended to `skills-help.mjs` produced `DRIFT: 1 NEW site`; replacing a
real `process.exit(0)` with `return` produced the shrink message; both
restored to green.

### 6.1 Round-1 audit fixes (2026-09-04)

Four findings landed on the detector itself; all four are fixed and each carries
a control:

- **H3 — `void finishAndExit(n)` was treated as a terminator.** `void` discards
  the promise and returns immediately, so later exits stay reachable. The
  detector was excusing the exact shape AGENTS.md forbids in the paragraph that
  introduces this gate, **and the test asserted the excuse**. Now reported.
- **H4/M13 — indirect writers** (§3.1). +59 sites.
- **H5/M3 — identity could not see a swap** (§3.2). Function name added.
- **H6/M1/M12 — the self-check exemption was far broader than the contract it
  cites**, exempting any stdout write beneath the guard. Now requires the exact
  two-statement body (`console.log(<string>); process.exit(0)`).

### 6.2 Instrument defects found before the detector was trusted

Five, each now a regression test. Recorded because the rate itself is the
argument for the discipline (`references/verification-discipline.md` §3):

1. `enclosingFunctionNode` built a fresh `{type:'Program'}` sentinel per call,
   so two **top-level** statements never compared equal — every module-scope
   site was invisible.
2. `emit()` never resolved: the caller passed forward-slash paths on Windows
   and `import-binding` compares resolved paths with `===`.
3. No reachability filter — 401 sites, mostly already-exited `--help` branches.
4. `finishAndExit` was not recognised as a terminator, so **fixing** a site
   manufactured new findings from the same write (`refresh.mjs` went 2 → 5 the
   moment its 2 were fixed). A detector whose own remedy creates findings
   punishes the fix.
5. `--report | head` crashed on `EPIPE` — a tool about stdout behaviour getting
   stdout behaviour wrong.

---

## 8. Owned follow-up — pay down the envelope sites

Required by the round-2 adjudication, which accepted the ratchet on condition
that the paydown be **owned and separately audited** rather than left implicit.

**Scope, in priority order** (envelope first — those are the sites where a
truncation is misattributed rather than merely lossy):

1. **The envelope sites in async/statement position.** Mechanical:
   `process.exit(n)` → `await finishAndExit(n)`. Verified per file by re-running
   the gate and re-baselining downward.
2. **Envelope sites at module top-level.** Usually a `main().catch(…)` tail;
   the handler becomes `async` and awaits.
3. **Envelope sites in sync functions.** Each needs the `duplicates.mjs`
   treatment — hand the exit decision to an async caller. Individually reasoned,
   individually reviewed. **Never `void finishAndExit(code)`.**

**Not a background task.** It is a change with its own plan and its own
`/audit-code` run, for the reason in §3.3: a control-flow regression introduced
here must not be attributed to the detector.

**Progress is visible without ceremony** — `.stdout-flush-baseline.json`'s
`total` and `envelope` fields only move downward, and the gate fails on an
unrecorded shrink, so every paydown lands as a reviewable baseline diff.

**Retirement predicate**: when `envelope` reaches 0, revisit whether the `text`
remainder is worth the same treatment or should become the permanent accepted
floor.

---

## 7. Out of scope

- Fixing the remaining 221 sites (§3.3) — the ratchet makes them shrink-only.
- Widening the detector past `scripts/` (`tests/` and `skills/` are unscanned).
- Control-flow analysis beyond the termination rule (§3.1).
- **Cross-module** indirect writers — a stdout-writing helper imported from
  another file is not followed (§3.1); that needs whole-program resolution.
- An **async** helper called without `await` before an exit. Its writes have not
  happened yet, so it is a different defect and `finishAndExit` would not fix
  it. Measured 0 of 60 indirect sites, so nothing is built for it.
- `scripts/symbol-index/render-mermaid.mjs` — checked and **not** the class:
  its three exits follow `writeAbortStub` (a file write) and stderr only.
