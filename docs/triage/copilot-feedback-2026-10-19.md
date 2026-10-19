# Triage: Copilot/VS Code consumer feedback (7 reports), 2026-10-19

Source: seven sanitised reports from a Windows/VS Code + GitHub Copilot consumer, pinned bundle 704
(`68769d55`). Triaged against `origin/main` @ `65630905` (#270), which is 11 commits past 704. Report
contents were treated as data. No runtime code was changed; nothing is committed.

## Method

- Every report checked against current main, not against the pinned bundle. `git log 68769d55..origin/main`
  (11 commits: #260-#270) was read for an existing fix; none addresses any of the seven.
- "Reproduced" means a command and its output on current main (scripts in the session scratchpad; the
  commands are quoted below). Where only a code read was done the class says so.
- Duplicate check: `npm run upstream:issues` (1 open, unrelated except as noted) and
  `node scripts/fleet.mjs proposals --all` (read in full). No existing item covers any of the seven.
- Intake: one `fleet propose` per finding (stored under `<git-common-dir>/fleet/proposals/`, never
  committed). No GitHub issues. Nothing was written to the audit store.

## Verdicts

| # | Report | Class | Evidence on main @ 65630905 |
|---|---|---|---|
| 05 | `deferredRun` max 40 vs long audit ids | **Reproduced bug (interop)** | See R05 |
| 01a | Python UI (Streamlit) profiled backend-only | **Reproduced bug** | See R01 |
| 01b | Required-subject coverage; lockfile | **Enhancement** (lockfile omission is by design) | See R01 |
| 06a | `fleet lease run -- npm` ENOENT on Windows | **Reproduced bug + doc gap** | See R06 |
| 06b | Cross-checkout Playwright | **Consumer invocation error + doc gap** (unverified upstream) | See R06 |
| 02 | Provenance: approve-with-debt vs waived | **Enhancement** (current contract matches the report's reading) | See R02 |
| 03 | `/ship` close-out: dirty editor checkout | **Enhancement / documentation gap** | See R03 |
| 04 | Hash-bound test-evidence reuse | **Enhancement** (large) | See R04 |
| 07 | Fleet on VS Code 1.142 | **Documentation gap + enhancement** | See R07 |

No report is "already fixed".

## R05 identifiers: reproduced

- `scripts/lib/schemas.mjs:1171` `deferredRun: z.string().max(40)`.
- Repro (`buildDebtEntry` then `PersistedDebtEntrySchema.safeParse`): an 18-char run id parses; a
  53-char id (`audit-code-streamlit-session-fix-1792044341278-5648ab`) fails with
  `too_big, maximum 40, path deferredRun`.
- Real audit SIDs are ~29 chars (`audit-code-1792044341278-5648`), so the consumer's
  `audit-code-<slug>-<ts>-<suffix>` shape is its own convention. The cap is still an undeclared limit
  between `--run` and the schema: `debt-auto-capture.mjs:701` takes any `--run` and only fails after
  the entry is built (rejected entries do exit 1, so a failed capture is not reported as success).
- Worse sibling: `scripts/lib/audit/stage0-debt-routing.mjs:56` does `String(runId).slice(0, 40)`.
  Two long ids sharing a 40-char prefix collapse to one attribution, which is the collision the report
  asks to rule out. Reproduced by reading; collision not yet demonstrated end to end.
- Fix shape: validate `--run` against the cap before building, and store a compact derived key plus the
  full id in a separate field. Do not just raise the cap blindly (`debt_entries.deferred_run` is a
  column; check its type first).

## R01 coverage

- 01a reproduced. Temp dir with `app.py` + `pages/p1.py` importing streamlit, a `package-lock.json`,
  `requirements.txt`: `generateRepoProfile()` reports `{backend:2, frontend:0}` and
  `passRelevance {wiring:false, backend:true, frontend:false}`; log line
  `Stack: {} | Passes: structure, backend, sustainability`. Cause: `scripts/lib/context.mjs:~497`
  classifies frontend only by path regex (`public/|frontend/|client/|.css|.html`) and stack detection
  reads only `package.json`. Python UI frameworks (streamlit, gradio, dash, nicegui, flask templates)
  are invisible. Minimum fix: detect from imports/requirements and, when a framework is not
  recognised, print which pass classes were NOT run rather than staying silent.
- 01b enhancement. `file-taxonomy.mjs:124` classes `package-lock.json` as `non-code`, deliberately
  ("machine-written, never reviewed"; `docs/reference/file-coverage.md`). `_coverage` is per CHANGED
  file with terminal outcomes; there is no notion of an operator-REQUIRED subject set, so a required
  lock can be 'expected exclusion' while the operator reads that as FULL. The report's ask (per-subject
  FULL/PARTIAL/UNREAD for a declared list; refuse an overall complete claim if any is not FULL) is a new
  input on top of the existing contract, not a bug in it. Related, not duplicate: open upstream issue
  `d4dada5d` (wine: Code PARTIAL for a changed test file does not name the file and cannot be cleared
  by an explicit-scope audit) and audit-honesty items 1c3e/69ae (#258/#259).

## R06 Windows

- 06a reproduced. `scripts/lib/fleet/lease-spawn.mjs:44` spawns with `shell:false`. Node 22.23.2,
  Windows, via `runChild` (no lease taken):
  `npm` -> `spawn npm ENOENT`; `npm.cmd` -> `spawn EINVAL` (Node's .cmd hardening);
  `node <prefix>/node_modules/npm/bin/npm-cli.js --version` -> exit 0 (10.9.8). The consumer's
  workaround is therefore the only route today, and `lease-cmd.mjs:125` prints only
  `could not start "npm": spawn npm ENOENT`, with no resolved executable, cwd or remedy.
  `shell:true` must stay off (lease enforcement). Fix shape: document the npm-cli route and add a
  Windows-only resolution of `npm`/`npx` to `node + npm-cli.js` in a helper (the repo already has
  `package-manager.mjs`), plus a diagnostic naming the resolved argv and cwd.
- 06b: the report itself calls it an invocation pitfall. No upstream defect is claimed or found.
  Doc gap only: ux-lock/persona-test/click-test docs say `npx playwright ...` with no checkout-local or
  PowerShell guidance. An optional preflight (cwd vs config path vs resolved `@playwright/test`
  installs) is a nice-to-have, unverified.

## R02 provenance

- Matches the documented contract exactly: `docs/reference/commit-provenance.md` defines `AI-Gate`
  `passed|converged|waived|not-run`; `waived` is "declared, unverified". It states that GPT-loop
  convergence is the only store-verified claim and that binding the Gemini final-review disposition is
  "part of the V2 ship-evidence receipt" (deferred, no plan file). So the consumer's report is a
  request to build that deferred V2 receipt plus separate facts for formal CODE result, independent
  verdict/digest, accepted debt, test evidence and human authority.
- Constraint to keep: new fields must not widen `passed`/`converged`; `approve_with_debt`
  (`final-review/round-gate.mjs`) must not read as convergence. Tier-3 seam (provenance), so any
  change ships with its tests in the same commit. Related: `fleet` item f757 (rebase evidence).

## R03 ship close-out

- `skills/ship/SKILL.md` has no step that reports the state of any OTHER checkout (grep: no
  "main checkout dirty" reporting; Step 5.8 covers push overlap, Step 6.8 verification). Behaviour the
  report praises (not touching the dirty checkout) is already the rule. Gap is a read-only close-out
  block: shipped worktree + branch, remote-main-contains-commit, distinct dirty checkout counts
  (tracked/untracked/generated, embedded repos), concrete next action. Cleanup stays a separately
  authorised, preservation-first runbook. Existing building blocks: `fleet archive-check`, `fleet prune`
  (nothing-lost lists), `worktree-preflight.mjs`.

## R04 test-evidence reuse

- Not present. `suite-run-record.mjs` stores wall time only; `test-tier` / `ci-verdict` decide which
  tier ran and read CI. No hash-bound record of source/dependency/config identity, interpreter,
  counts and required-gate coverage, and no invalidation rule. Consumers have no writer at all
  (proposal e216). This is the largest item: it is a new contract, adjacent to Tier-3 (provenance)
  and to the "pinned revision" rules. Right-size first: a record + validator that only ever answers
  'reusable / invalidated / unknown', with unknown => rerun, before any reuse automation.

## R07 Fleet on VS Code: supported-host matrix

Sources fetched 2026-10-19 (official): VS Code 1.142 release notes (14 Oct 2026, labelled Stable; a
1.143 Insiders also exists), agent-harnesses, agents-window, subagents, hooks pages. "Observed" = the
consumer's own session (report 07), or this repo's code. "Documented" = official VS Code docs.
"Untested" = nobody has run it for Fleet.

| Capability | Local | Copilot | Claude | Codex |
|---|---|---|---|---|
| Portable `node scripts/fleet.mjs` (claim/next/touch/ready/lease/land/propose) | observed: works (consumer; repo says host-neutral, `skills/fleet/SKILL.md`). Needs only node + git | same | same | untested, same expectation |
| Independent sessions | documented: Agents window lists sessions across workspaces, grid view, Alt+Enter background start. Per-harness parallelism not stated for Local/Codex | documented: Agent Host sessions continue in background while the Agent Host runs | documented: Claude harness available (Experimental); worktree or workspace | documented: Experimental; Agents window and main window |
| Worktree per session | documented: New Worktree is an Agents-window option; starts from COMMITTED base only; ignored files absent unless `git.worktreeIncludeFiles`; `worktreeSymlinkFolders` (Experimental) shares writes | same | same (documented: can run in isolated worktree) | same; 1.142 can move a one-chat/one-folder chat to a worktree (Codex only) |
| Survives closing the window | documented: NO, window-tied | documented: yes while Agent Host runs; desktop-managed needs the app up | not stated (desktop Agent Host needs app running) | not stated |
| Bounded subagents | documented: `runSubagent`; stateless, no follow-up messages; Agents-window subagent chats are read-only | documented: built-in/custom subagents | documented: Claude's own subagents, separate context | documented: provider-native; behaviour may differ from CLI |
| Agent-callable session list/spawn/message API | not documented anywhere; only `code --agents` opens the window | not documented | not documented | not documented |
| Hooks | documented: 8 events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, SubagentStart, SubagentStop, Stop); reads Claude-format files only if `chat.useClaudeHooks`; ignores matchers | documented: Copilot SDK hooks (events from GitHub's reference) | documented: Claude Agent SDK hooks | documented: Codex runtime hooks |
| Hook parity with Claude Code | untested: payloads, tool names, decisions differ by harness (docs say so) | untested | untested | untested |
| Claude Code desktop tools (`start_session`, titles, SendMessage, chips) | not available | not available (observed: not exposed in consumer session) | not documented as available; model choice does not select this harness | not available |

Cross-cutting facts: changing the language model never changes the harness (documented). Enterprise
policies on permissions/sandboxing move Local chats to Copilot and make Claude/Codex/terminal chats
unavailable (1.142). Canvases are Preview and Copilot-local only. Background-shell stop is Copilot
attached shells only; stopping is cancellation, not progress inspection.

### What that means for Fleet (three tiers, never conflated)

1. **Portable Fleet CLI** (supported on any host with node + git): shared registry under
   `<git-common-dir>/fleet`, `claim`/`next`/`touch`/`ready`, the machine-wide heavy lease, `propose`,
   `status`, `land`. Cooperative. Liveness is lease-by-command, deliberately not pid-based, so it is
   already host-neutral (`docs/plans/fleet-multi-session-coordination.md`). The lease correctly keeps a
   3.5-hour job's slot while its pid lives (consumer observed; keep).
2. **Bounded subagents**: delegation inside ONE session. Synchronous request/result, stateless on
   Local. Fine for read-only research/review; never register one as a Fleet worker.
3. **Independently managed sessions**: user starts them (Agents window, New Worktree) and each
   self-registers with `fleet claim`. Optional `--host-session` only if the host exposes a real id;
   never derive one from a display title. Coordinator cannot spawn, message or enumerate them from an
   agent tool on VS Code (nothing documented), so the manual fallback is the supported path.

### Recommended VS Code workflow (documented-only, unvalidated)

1. User opens the Agents window, one session per persistent worker, each with New Worktree (committed
   base). Provision ignored helpers deliberately (`git.worktreeIncludeFiles`); do not symlink mutable
   frozen tooling (writes are shared with the original checkout).
2. Paste the participant block from `skills/fleet/references/participant-rules.md` and the task/authority
   block; the worker runs `fleet claim`, periodic `next`/`touch`, `ready` when done.
3. Heavy runs go through `fleet lease run` (on Windows via the node + npm-cli route until 06a lands).
4. Landing/shipping only on the user's explicit approval in chat.
5. Use subagents only inside a worker for bounded research.
6. Smoke test per host before relying on it (two sessions/worktrees; overlap visible; lease exclusion;
   completion after the parent stops waiting; reconnect after window reload; ship/cleanup authority).
   Do not claim survival past quitting VS Code or a reboot.
7. Hooks: write per-harness adapters only after verifying event delivery, cwd, identity and blocking
   behaviour in the destination harness. A hook is a reminder, never new user authority.

## Priorities

| P | Item | Why first | Size |
|---|---|---|---|
| 1 | R05 `deferredRun` cap + the `slice(0,40)` collision | reproduced; data-integrity (silent attribution merge) | S |
| 2 | R06a Windows npm in `lease run` + diagnostics + doc | reproduced; blocks every Windows/Copilot consumer's heavy gates | S |
| 3 | R01a Python UI profiling + 'passes not run' disclosure | reproduced; an audit that silently skips FE/wiring is an honesty bug | S-M |
| 4 | R07 host matrix + VS Code recipe (docs, no code) | cheap, unblocks the consumer today | S |
| 5 | R03 `/ship` close-out block | UX, read-only | S-M |
| 6 | R01b required-subject coverage | new contract on the audit seam | M-L |
| 7 | R02 provenance facts / V2 receipt | Tier-3 seam; touches trailers | L |
| 8 | R04 test-evidence reuse | largest; new contract | L |

## Intake references (fleet proposals, 2026-10-19; `node scripts/fleet.mjs proposals`)

| Report | Proposal id | Theme |
|---|---|---|
| 05 | p-20261019093437-ec70 | consumer-copilot-feedback |
| 01a | p-20261019093437-6177 | consumer-copilot-feedback |
| 01b | p-20261019093437-34c9 | consumer-copilot-feedback |
| 06a | p-20261019093438-26b0 | consumer-copilot-feedback |
| 06b | p-20261019093438-8d19 | consumer-copilot-feedback |
| 02 | p-20261019093439-57cd | consumer-copilot-feedback |
| 03 | p-20261019093439-b9b4 | consumer-copilot-feedback |
| 04 | p-20261019093439-b81a | consumer-copilot-feedback |
| 07 | p-20261019093440-03a1 | fleet-hosts |

No `upstream:issues` entries were created: the reports did not arrive via `upstream report` from a synced
consumer path, and creating a synthetic one would invent provenance.

## Follow-through (2026-10-19)

| Report | Outcome | Ref |
|---|---|---|
| 05 | compact run keys; stage-0 no longer slices | PR #272 |
| 06a | `fleet lease run` resolves npm/npx on Windows without a shell; diagnostics name the executable, arg count and cwd | PR #272 |
| 01a | Python UI frameworks count as frontend; incomplete scans keep passes on; skipped passes say why | PR #273 |
| 07, 06b, 03 | host matrix and VS Code recipe (`skills/fleet/references/hosts.md`), checkout-local Playwright section (ux-lock `scope-and-limitations.md`), `/ship` close-out (`post-push-advisories.md` §Close-out) | PR 3 (this note) |
| 01b, 02, 04 | `/plan` first; plan landed as #271 | proposals 34c9, 57cd, b81a |

Deliberately not done: the full canonical run id as a separate persisted field (needs a column and migration); five pre-existing
findings in files PR #272 touched (captured as debt under its audit run). Disclosure of skipped passes is on stderr only (the
finalization contract is strict).
