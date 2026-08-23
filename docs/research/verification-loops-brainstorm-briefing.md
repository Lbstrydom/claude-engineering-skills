# Briefing — Verification-loop improvements: which, if any, and in what form?

**Prepared**: 2026-08-20, as the focal artifact for a `/brainstorm` round.
**Question for the panel**: three candidate improvements are on the table
(§4). Do all three, a subset, a different form of one of them, or something
not yet on the table? The decision criterion is not "more verification" —
it is **sustainably improving this skill bundle so that it serves software
developers effectively and efficiently** (§5 defines what sustainable means
here).

---

## 1. What this repo is (context for external reviewers)

`claude-engineering-skills` is a public bundle of 16 AI-pair-programming
skills (planning, plan audit, code audit, four browser-based UX lenses,
shipping, investigation, explanation, brainstorming) plus the Node CLI
tooling behind them. Skills are Markdown instruction files
(`skills/<name>/SKILL.md`) executed by AI coding agents — Claude Code,
GitHub Copilot, Cursor, Windsurf.

Two properties dominate every design decision:

- **Consumers we cannot observe.** The tooling syncs into private consumer
  repos (`scripts/.claude-skills/`, gitignored there). A silent failure in
  a consumer is invisible to us; a change that fails loudly here can fail
  silently there. Several past defects shipped to consumers and sat
  undetected for weeks.
- **Multi-host reality.** Claude Code supports hooks (shell commands fired
  on prompt-submit / pre-tool / post-tool events, configured in
  `.claude/settings.json`). Copilot, Cursor and Windsurf do not. The repo's
  standing rule: a hook is *Claude-Code-only acceleration, never
  cross-agent enforcement* — anything load-bearing must live in the
  SKILL.md prose, the CLI tooling, or the git pre-push gate, which all
  hosts share.

## 2. Trigger for this brainstorm

Anthropic published "Building verification loops in Claude Code with
skills" (claude.com/blog). Its thesis: don't stop at implementation —
encode your manual follow-up checks as skills so the agent closes its own
feedback loop before responding. It names four deployment patterns:

1. **Standalone** — invoke a check deliberately (security scan, a11y audit).
2. **Embedded** — the producing skill runs the check inline ("after
   creating the component, run eslint on it and fix errors").
3. **Chained** — skills trigger each other (/code-review → /simplify →
   /verify).
4. **PR-based** — the same checks run on every pull request as team
   infrastructure.

## 3. Honest current-state assessment

We already exceed the article on three of its four patterns:

| Pattern | Our state |
|---|---|
| Standalone | 5 disjoint audit lenses (audit-code, click-test, nav-audit, visual-audit, investigate), each with an explicit scope firewall so they don't overlap |
| Embedded | PostToolUse hook regex-scans every Edit/Write for ~12 quick-fix signatures (nudge, never blocks); /ship runs the full `npm run check` gate battery; /audit-code has an instrument-verification step (a check is not trusted until seen to fail) |
| Chained | /cycle orchestrates plan → audit-plan → human implementation → audit-code → persona-test → ux-lock → ship |
| PR-based | **Deliberately declined.** Local-first CI: ~23 checks + full test suite run in a git pre-push hook against a clean worktree of the commit being pushed. GitHub Actions are reserved for weekly maintenance. Cost + the ease of distributing the pre-push bundle to consumers drove this; it is a settled decision, not a gap. |

Beyond the article: a verification-discipline doctrine (instrument-first
debugging, red-then-green, negative controls, "a green that checked
nothing is not a green"), machine-checked gate contracts binding a
SKILL.md's *claimed* gate to the code+test that enforces it, and a
suppression ledger so repeated audit rounds don't churn findings.

**Known structural weaknesses** (from our own records, not the article):

- **Everything deterministic fires at push, nothing at edit time.** The
  repo has no linter and no typechecker (a deliberate lean choice — plain
  ESM JavaScript, `plans:lint` is the only lint-shaped script). The only
  edit-time signal is the regex quick-fix nudge. A syntax error in a
  `.mjs` file survives from the moment it's written until the pre-push
  suite runs — an internal memory note says exactly this: "SKILL.md gate
  claims fire only at push; `npm run check` on a dirty tree sees none of
  it."
- **Long feedback distance in the flagship chain.** /cycle pauses for
  human implementation, then audits. Fine. But between "Claude edited a
  file" and "anything deterministic looked at it" there can be an entire
  session.
- **`allowed-tools` frontmatter is used by zero of the 16 skills**, and
  our `skills:check` gate doesn't validate the field. Nothing constrains
  a read-only skill (explain, investigate, static nav-audit) from writing
  files or running arbitrary commands.

## 4. The three candidates on the table

### Candidate A — `allowed-tools` least-privilege for read-only skills

Add `allowed-tools` frontmatter to the genuinely read-only skills and a
`skills:check` rule validating it (a declared-but-unenforced field is a
claim nothing verifies — a defect class this repo has been bitten by
repeatedly).

- *For*: real least-privilege; the field is now cross-host (Copilot
  supports the same frontmatter since Dec 2025), so unlike hooks it
  travels to all consumers' hosts.
- *Against*: an over-tight list fails **silently on surfaces we can't
  observe** — precisely our worst failure class. Tool names may differ
  per host/version. Maintenance: every time a skill grows a step needing
  a new tool, someone must remember the frontmatter, and forgetting fails
  closed in a way that looks like the model being unhelpful.
- *Open question for the panel*: is the security/robustness win worth
  adding a per-skill capability list that can drift, given that skill
  *content* already tells the model what to do? Is there a subset (e.g.
  only `explain` + `investigate`) where the list is naturally stable?

### Candidate B — edit-time deterministic syntax check

Extend the existing PostToolUse hook: after any Edit/Write of a `.mjs`
file, run `node --check` (~10 ms, no dependency) and surface a parse error
immediately. Smallest possible closure of the edit→push gap; catches the
one class regex provably cannot.

- *For*: deterministic, near-free, no new surface (rides an existing
  hook), impossible to cry wolf (a parse error is never a false
  positive).
- *Against*: Claude-Code-only (hooks don't exist on other hosts), so it
  improves *this repo's* development loop more than the shipped product.
  Scope creep risk: today `node --check`, tomorrow someone proposes
  eslint, and the lean no-linter stance erodes without a decision ever
  being made.
- *Open question*: is the right form the hook (host-specific, automatic)
  or a line of SKILL.md prose in the producing skills ("after writing a
  .mjs file, run node --check on it") which is host-neutral but relies on
  the model remembering?

### Candidate C — a Stop-hook verification pass

Claude Code supports a `Stop` hook: a command that runs when the agent is
about to end its turn, able to send it back to work. The article's actual
thesis ("close the loop before responding") maps to this. Ours would run
a cheap deterministic subset of the gate battery **scoped to files
touched this session** before the agent yields.

- *For*: the purest expression of the verification-loop idea; catches
  broken intermediate states before the human ever reads "done".
- *Against (heavy)*: the working tree is **shared by concurrent
  sessions** here — an unscoped check fails on the *other* session's
  half-edited files, and a cried-wolf gate historically gets disabled
  within a week (this repo replaced a tree-checking pre-push hook with a
  clean-worktree design for exactly this reason). Session-scoping the
  file set is the entire difficulty. Latency on every turn end.
  Claude-Code-only, again.
- *Open question*: is there a design that is honest under a shared tree —
  e.g. only files this session's tool calls actually wrote — and is the
  residual value worth a new hook surface that consumers also have to
  receive, understand, and be able to disable?

## 5. What "sustainable" means here — the real decision criteria

The panel should weigh candidates (and alternatives) against these, which
come from this repo's accumulated failure history, not from taste:

1. **Serves consumers, not just this repo.** The product is the skill
   bundle. An improvement only to our own dev loop is worth less than one
   that ships. Hook-based improvements (B, C) do not reach Copilot/Cursor
   users at all.
2. **No silent failure on unobservable surfaces.** Anything that can fail
   quietly in a consumer repo we cannot see is presumptively wrong (A's
   main risk).
3. **Cried-wolf resistance.** A gate that false-positives gets
   `--no-verify`'d and then protects nothing. Deterministic-only checks at
   fast surfaces; judgment-shaped checks only where a ledger suppresses
   re-raises.
4. **Maintenance is a first-class cost.** Every new surface (a hook, a
   frontmatter field, a gate) is something that drifts, needs a
   freshness check, and shows up in the next audit. The repo's
   right-sizing rule: reject both the band-aid and the over-built
   version; build the smallest thing that is a true function of the
   problem.
5. **Nudge vs gate is a deliberate axis.** Blocking checks are reserved
   for push time against a clean checkout. Edit-time and turn-end
   surfaces are advisory by standing policy. A candidate that quietly
   converts an advisory surface into a blocking one needs to argue for
   that explicitly.

## 6. What the panel is asked to produce

1. A recommended disposition for each candidate: **do / do differently /
   decline** — with the failure mode you expect if we choose wrong.
2. Any option we're not seeing. Examples of the shape we mean: a
   host-neutral alternative to B (prose in the producing skills instead
   of a hook); making the verification-discipline doctrine itself a
   shipped, consumer-facing skill rather than internal reference prose;
   a "verify" lens that consumers invoke standalone; instrumentation to
   *measure* whether any of this changes outcomes (we have a learning
   store and telemetry pipeline that could carry before/after data).
3. A view on sequencing: if resources allow one thing this quarter, which
   single change most improves the experience of a developer *using*
   these skills — as opposed to the experience of the people maintaining
   them?
