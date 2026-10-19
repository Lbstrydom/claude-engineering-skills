---
summary: Which hosts run /fleet and how: VS Code harnesses, subagents vs sessions, a manual recipe.
---

# Fleet on other hosts (VS Code harnesses) - as of 2026-10-19, VS Code 1.142

`node scripts/fleet.mjs` needs only node and git, so it runs on every host. What differs is how SESSIONS get started and
coordinated. Three things are easy to conflate; keep them apart:

1. **The portable CLI** - registry, `claim`/`next`/`touch`/`ready`, the machine lease, `propose`, `status`, `land`. Cooperative,
   host-neutral (liveness is a lease renewed by any fleet command, not a pid).
2. **A bounded subagent** - delegation inside ONE session: a request, a result, no follow-up. On the VS Code Local harness it is
   stateless and the Agents-window subagent chats are read-only. Never register a subagent as a fleet worker.
3. **An independent session** - a session the user starts (own worktree, own context, outlives the parent's turn). Only this is a
   fleet worker, and on VS Code the user starts it by hand: no documented tool lets an agent list, spawn or message sessions
   (only `code --agents`, which opens the window).

Choosing a model does NOT choose a harness. A Claude model inside the Copilot harness has Copilot's tools, not Claude Code's.
Enterprise policies on permissions or sandboxing can move Local chats to Copilot and make Claude, Codex and terminal chats
unavailable (1.142).

## Matrix

Cell prefix: **obs** = observed (a consumer session or this repo's code), **doc** = in the official VS Code docs, **untested** =
nobody has run it for fleet. "Not stated" means the docs are silent, which is not "no". The one observation behind the CLI row: a
consumer ran the portable CLI (claims, leases that held a 3.5-hour job's slot) in a VS Code session and did not record which
harness; treat every harness as untested until its smoke test below is recorded.

| | Local | Copilot | Claude | Codex |
|---|---|---|---|---|
| fleet CLI | untested per harness | untested per harness | untested per harness | untested per harness |
| Independent sessions + New Worktree | doc | doc | doc (Experimental) | doc (Experimental) |
| Survives closing the window | doc: no | doc: yes while the Agent Host runs | not stated | not stated |
| Subagents | doc: stateless, no follow-up | doc | doc: separate context | doc: provider-native |
| Agent-callable session list/spawn/message | none documented | none documented | none documented | none documented |
| Hooks | doc: 8 events; Claude-format files need `chat.useClaudeHooks`, matchers ignored | doc: Copilot SDK | doc: Claude SDK | doc: Codex runtime |
| Claude Code desktop tools (`start_session`, `SendMessage`, titles) | n/a | obs: not exposed | n/a | n/a |

Hook payloads, tool names and output decisions differ by harness: copying a Claude hook file does not give the same lifecycle
enforcement. Verify event delivery, cwd, session identity and blocking in the destination harness before relying on one, and
never treat a hook as new user authority.

## Recipe: persistent workers in VS Code

1. The user opens the Agents window and starts one session per worker with **New Worktree**. The worktree starts from the
   COMMITTED base only: ignored helpers, `.env` and dependencies are absent unless provisioned (`git.worktreeIncludeFiles`). Do
   not symlink mutable pinned tooling (`git.worktreeSymlinkFolders` shares writes with the original checkout).
2. Each worker gets the participant block (`references/participant-rules.md`) and a task and authority block, then runs
   `fleet claim` from inside its worktree, `next`/`touch` as it works, `ready` when done. Pass `--host-session` only with an id
   the host really exposes; never invent one from a title.
3. Heavy runs go through `fleet lease run`, so one machine runs one at a time:

   ```powershell
   Set-Location C:\work\app-feature-x
   node scripts/fleet.mjs claim --id feature-x --intent "add export" --paths "src/export/**"
   $npmCli = Join-Path (Split-Path (Get-Command node).Source) 'node_modules\npm\bin\npm-cli.js'
   node scripts/fleet.mjs lease run --kind gate --for 60 --wait 30 -- node $npmCli ci
   ```

   Run from the worktree you mean (a child inherits the cwd). The child is spawned without a shell, so on Windows a bare `npm`
   is a `.cmd` shim it cannot start (`spawn npm ENOENT`); naming node and npm's own entry point, as above, works on every bundle
   version. This assumes the standard Windows install, where npm sits beside `node.exe`; with nvm, volta or fnm, point `$npmCli`
   at that manager's `npm-cli.js` instead, and check `Test-Path $npmCli` is True first. A start failure prints the resolved
   executable and cwd.
4. Landing, shipping and any cleanup need the user's explicit approval in chat. Removing a worktree needs evidence that no open
   session uses it; fleet's check reads the Claude Code desktop session list, which other hosts do not have, so there ask the user
   to confirm in the Agents window and stop if they cannot. A subagent may help a worker with bounded research; it does not
   replace a worker.
5. Do not promise survival past quitting VS Code or a reboot, and do not scrape session state from the UI.

## Smoke test per host before relying on it

Two sessions on two worktrees: both appear in `fleet status`; overlapping `--paths` is refused; a second heavy job waits on the
lease; a job outlives the parent turn that started it; state survives a window reload; shipping needs the user's go-ahead.
Record what held on that host and harness version, and when.
