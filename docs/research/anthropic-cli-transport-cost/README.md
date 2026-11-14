# cli vs sdk transport cost — measurement harness

**What it is.** The four probes behind
[`docs/plans/anthropic-cli-faithfulness-routing.md`](../../plans/anthropic-cli-faithfulness-routing.md)
§6, committed so its figures can be re-measured and its revert triggers (§6.D)
can actually be falsified by someone other than their author.

**When you need it.** Before quoting any of those numbers; when a `claude` CLI
release might have changed the behaviour the routing rule rests on; or when
deciding whether the `cli` backend still earns its place.

> **It spends.** The sdk legs bill `ANTHROPIC_API_KEY`; the cli legs draw the
> Max 20x Agent SDK credit and self-report what they would have cost. A full
> pass of all four modes at `runs=3` cost **≈$0.08 on the API meter** and
> **≈$1.60 of credit** on 2026-11-14. Each run prints its own cost.

## Prerequisites

- Run from the **repo root** (the harness resolves `scripts/**` against `cwd`).
- `ANTHROPIC_API_KEY` for the sdk legs — via `.env` or `~/.audit-loop.env`.
- A signed-in `claude` CLI for the cli legs (`claude -p` must work).
- `summariser` mode shells out to `scripts/symbol-index/extract.mjs`; no network
  beyond the provider call.

## Modes

```bash
node docs/research/anthropic-cli-transport-cost/measure.mjs summariser 3
node docs/research/anthropic-cli-transport-cost/measure.mjs system 3
node docs/research/anthropic-cli-transport-cost/measure.mjs prefix 3
node docs/research/anthropic-cli-transport-cost/measure.mjs bare
```

| Mode | Shape | Plan §
|---|---|---|
| `summariser` | 10 real symbol records, no `system` — **serviceable** on cli | §6.A |
| `system` | `normalize-intent`'s own call, the real `NORMALIZE_PROMPT` | §6.B |
| `prefix` | a 6-token exchange, to expose the injected prefix | §2.4 |
| `bare` | does `--bare` keep the subscription credit? | §2.5 |

The `system` mode runs its **cli leg below the seam**, by spawning `claude -p`
with the exact argv `createCliAdapter` builds. That is deliberate and necessary:
the seam now refuses `system` on cli, so the live path can no longer produce
that leg. Confirm the refusal separately — an explicit `backend:'cli'` with a
`system` must throw ``cannot honour `system` ``.

## Figures from a clean run, 2026-11-14

Worktree `visual-audit-clipping-check-2de96f` @ `f48d9863`, model
`claude-haiku-5-5`, Windows 11, `claude` CLI as installed that day.

**`summariser`** — fixed 9,669-char prompt, n=5/backend:

| | sdk | cli |
|---|---|---|
| output tokens | 916 / 943 / 991 / 1146 / 1308 | 1266 / 1323 / 1386 / 1452 / 1582 |
| input tokens | 4285 every run | 2 |
| cache create / read | 0 / 0 | 168679/0, 174863/0 cold · 4063/164611 warm |
| latency | 4.4 / 4.9 / 5.0 / 5.5 s | 12.2 / 13.9 / 14.1 / 14.2 s |
| cost | ~$0.0098 computed | $0.1719 / $0.1785 cold · $0.0158 warm |
| obeyed "EXACTLY ONE LINE" | 10/10 every run | 10/10 every run |

**The output is not the mechanism** — +21-33% tokens, instruction obeyed on both.

**The 5th sample was taken last and changed a decision.** It returned 1308 sdk
output tokens, 14% over the previous maximum, so `TOKENS_PER_SYMBOL` in
`scripts/symbol-index/summarise.mjs` went from 192 to 256. Kept here as the
worked example of why a 4-sample range is not a bound.

**`system`** — sdk n=2 via the seam, cli n=3 below it:

| | sdk | cli |
|---|---|---|
| output tokens | 29, 43 | 2254, 2784, 2248 |
| latency | 1.07, 1.29 s | 25.5, 31.9, 31.4 s |
| cost | ~$0.0003 | $0.301, $0.201, $0.155 |
| lines | 1, 1 | 16, 38, 41 |

Every cli run opened *"I haven't changed anything"* / *"I couldn't make the
change"* and reported on its tool availability — it reads the normalize prompt
as a task to perform. **52–96× the output tokens, ~24× latency, ~500–1000× cost.**

**Variance note, and it matters.** A *shortened* 3-sentence replica of the same
instruction returned a correct one-line answer 3/3 — while still burning 466,
673 and 636 output tokens against sdk's 43. So whether cli honours a given
`system` is **not predictable from the instruction**, which is why the refusal
is mechanical on the param rather than a judgement at each call site.

**`prefix`** — `"Reply with exactly the word: pong"` → `"pong"`:

- cold: 163,589 cache-creation tokens, **$0.654** (default model), **$0.052** on Haiku
- warm: ~4,050 cache-create + 159,543 cache-read

**`bare`**: `"Not logged in · Please run /login"`, cost $0.

## What would change the conclusion

→ [plan §6.D](../../plans/anthropic-cli-faithfulness-routing.md#6d-what-would-make-me-revert).
In short: a cli run that honours `system` **both** in shape and in cost (output
tokens within ~2× of sdk), or a `claude -p` flag that strips the project-context
prefix **without** forcing API-key auth. A shape-only pass is not enough — §6.B
already found one and it still cost an order of magnitude more.
