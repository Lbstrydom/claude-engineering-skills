# VS Code host smoke test — skills, MCP, hooks, sessions and fleet, per harness

**What it is**: the first real observation of how this repo behaves in each VS Code agent surface. Every VS Code cell in
[`vscode-compatibility-review-2026-11.md`](../research/vscode-compatibility-review-2026-11.md) is **doc** or **unverified**;
none is **obs**. You run this once per harness, and it turns those cells into **obs** with a date and a version. It also
captures real hook payloads, which Cluster D of [`vscode-compatibility.md`](../plans/vscode-compatibility.md) needs before
it may map any Copilot tool-input field.

**When you need it**: before the hook oracle (plan Phase 4) maps Copilot's `tool_input` keys; before `hosts.md` marks a
VS Code cell **obs**; and again when VS Code or an extension moves a major version (the hooks are Preview).

**Who runs it**: Louis, by hand, in VS Code. It is not a chip's task. About 60-90 minutes for all harnesses; each
harness is independent, so skip one you cannot open and write `unavailable` (the work machine's enterprise policy can
disable the Claude harness, see review §2a, Policy).

**The four harnesses.**

| Label | What it is | Capture host name |
|---|---|---|
| H1 Copilot harness | VS Code 1.147+, Agents window, harness **Copilot** (the default) | `copilot` |
| H2 Claude harness | VS Code, harness **Anthropic Claude** (the Claude Agent SDK, built in) | `claude-harness` |
| H3 Claude Code extension | The Anthropic extension for VS Code | `claude-extension` |
| H4 Copilot cloud agent | Runs on GitHub, not on your machine (optional, §8) | n/a |

The old **Local** harness is removed in February 2027 and is not smoke-tested here.

## 0. Rules for the whole run

- **Nothing here is committed except the fixtures** you review in §6. Raw hook captures never enter the repo: they are
  written to `$env:LOCALAPPDATA\ces-hook-capture\`, a per-user folder.
- **Cleanup (§7) always runs**, even if you abandon the run half way. If you stop for any reason, jump straight to §7.
- **Stop and ask the coordinator** if a step would need a secret, a deploy setting or a GitHub setting. None of the steps
  here does.
- Every command is PowerShell. Run them from the repo root unless a step says otherwise. Keep ONE PowerShell window open
  for the whole run: the variables set in §1 live in it.

## 1. Before you start (once)

### 1.1 Use a clean checkout that contains this file

Open the checkout you will run in. It must be clean, because the cleanup check in §7 is "git status prints nothing".

```powershell
Set-Location C:\GIT\claude-engineering-skills
git status --porcelain
Test-Path docs\runbooks\vscode-host-smoke.md
```

The first command must print nothing and the second must print `True`. If the tree is not clean, use a fresh worktree
(`git worktree add C:\tmp\ces-smoke main`) and run everything from there.

### 1.2 Record the versions

```powershell
code --version
code --list-extensions --show-versions | Select-String -Pattern 'copilot|claude|anthropic'
node --version
Get-Command claude -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
```

Write down the VS Code version (the first line), the Copilot, Copilot Chat and Anthropic extension versions, and whether
`claude` resolves on PATH. The extension's bundled CLI is **not** on PATH, so an empty last line is normal and means
the `claude --bg` steps in H3 need a standalone install (review §2c).

### 1.3 Install the capture hook and the projection script

The two scripts are the fenced blocks marked `smoke-script` in §9 of this file. This block extracts them from the file
you are reading, so you never copy JavaScript by hand. It writes them to the per-user capture folder, outside the repo.

```powershell
$capture = Join-Path $env:LOCALAPPDATA 'ces-hook-capture'
New-Item -ItemType Directory -Force -Path $capture | Out-Null

$md = Get-Content -Raw docs\runbooks\vscode-host-smoke.md
$fence = ([string][char]96) * 3
foreach ($name in 'capture.mjs', 'project.mjs') {
  $pattern = '<!-- smoke-script: ' + [regex]::Escape($name) + ' -->\r?\n' + [regex]::Escape($fence) + 'js\r?\n(.*?)\r?\n' + [regex]::Escape($fence)
  $found = [regex]::Match($md, $pattern, 'Singleline')
  if (-not $found.Success) { throw "script $name not found in the runbook" }
  $code = $found.Groups[1].Value -replace "`r`n", "`n"
  [IO.File]::WriteAllText((Join-Path $capture $name), $code + "`n", [Text.UTF8Encoding]::new($false))
}
Get-ChildItem $capture
```

You should see `capture.mjs` and `project.mjs`. Now write the hook config. It lives in `.github/hooks/`, which is **not**
ignored by git, so it shows up in `git status` until you delete it in §7. That is deliberate: a leftover cannot hide.

```powershell
$hookDir = '.github\hooks'
New-Item -ItemType Directory -Force -Path $hookDir | Out-Null
$command = 'node "' + (Join-Path $capture 'capture.mjs') + '"'
$entry = @(@{ matcher = ''; hooks = @(@{ type = 'command'; command = $command; timeout = 5 }) })
$config = @{ hooks = @{ UserPromptSubmit = $entry; PreToolUse = $entry; PostToolUse = $entry } }
$config | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $hookDir 'payload-capture.json')
Get-Content (Join-Path $hookDir 'payload-capture.json')
```

The capture script never prints, never blocks and never writes inside the repo. Set which harness you are about to test
(you will change this word at the start of H1, H2 and H3):

```powershell
Set-Content -NoNewline -Path (Join-Path $capture 'current-host.txt') -Value 'copilot'
```

### 1.4 Quit VS Code completely, then relaunch with the arch-memory hook disabled

The repo's own `.claude/settings.json` hooks **also fire** under the Copilot harness. Without the variable below, each
prompt you send would pay for an embedding and a store call (`arch-memory-check.sh`) before the plan's skip exists.

1. Close every VS Code window.
2. Confirm nothing is left running (the Copilot Agent Host can outlive a closed window):

   ```powershell
   Get-Process | Where-Object { $_.ProcessName -like 'Code*' } | Select-Object ProcessName, Id
   ```

   It must print nothing. If it lists processes, quit them from Task Manager first; otherwise the next step reattaches to
   the old process and the variable below is **not** inherited.
3. Launch from this same PowerShell window:

   ```powershell
   $env:ARCH_MEMORY_HOOK_DISABLE = '1'
   code .
   ```

Record in your results that `ARCH_MEMORY_HOOK_DISABLE=1` was set. §6 verifies that the hooks really saw it.

## 2. Checks to run in each harness

Run this whole section once for each of H1, H2 and H3, in a **new chat session** in the harness. Before each, set the
capture host word (change it to `claude-harness` for H2, `claude-extension` for H3):

```powershell
Set-Content -NoNewline -Path (Join-Path $capture 'current-host.txt') -Value 'copilot'
```

For each check, write down **what you saw**, not what you expected. Use these result words: `works`, `degraded` (say
what is lost), `broken`, `not present`, `unclear`. A wrong guess is as useful as a right one; an unrecorded one is not.

### 2.1 Skills are discovered from `.claude/skills`

1. In the chat input, type `/` and read the list. Look for `plan`, `explain`, `fleet`, `ship`, `audit-code`.
2. Record: which of those appear, and whether any name appears **twice** (a duplicate means two roots are read).

If none appear, record `not present` and carry on: the rest of §2 still runs by typing prompts in plain words.

### 2.2 `/name args` delivers the argument

1. Send `/explain scripts/lib/cli-io.mjs`.
2. Read only the agent's first reply. Stop the run with the Stop button once it has named its target.
3. Record: does the agent name `scripts/lib/cli-io.mjs` as the thing to explain (the argument arrived), or does it ask what
   to explain (it did not)?

### 2.3 `disable-model-invocation` is honoured

`/ship` and `/security-strategy` carry `disable-model-invocation: true`. This check never runs them.

1. Send: `List every skill you may start by yourself, without me typing its name. Is ship one of them? Is security-strategy?`
2. Record the agent's answer for both names.

### 2.4 `allowed-tools: Bash(...)` behaviour

`/plan` declares `allowed-tools: Bash(node scripts/cross-skill.mjs detect-stack)`.

1. Send: `/plan smoke test only: run your first command, then stop and write nothing`.
2. Record: did the agent run `node scripts/cross-skill.mjs detect-stack` **without** a permission prompt (the list is
   honoured), **with** a prompt (ignored), or not at all? Quote the prompt text if one appeared.

### 2.5 MCP servers: which file is read

This repo carries both `.mcp.json` (Claude/Copilot harness) and `.vscode/mcp.json` (Local harness). A consumer today has
only the second one. Check what the harness sees in each situation.

**A. As the repo is.** Open the command palette (Ctrl+Shift+P) and run `MCP: List Servers`. Record the server names
(expected: `playwright`, `mermaid`), their state, and whether a name appears **twice** (both files read, not de-duplicated).

**B. The consumer situation: only `.vscode/mcp.json`.** This simulates the file layout a consumer has today.

```powershell
Rename-Item -LiteralPath .mcp.json -NewName .mcp.json.off
```

Run `Developer: Reload Window`, then `MCP: List Servers` again. Record whether `playwright` and `mermaid` are still listed
(they are, if the harness forwards `.vscode/mcp.json`). **Always undo it:**

```powershell
Rename-Item -LiteralPath .mcp.json.off -NewName .mcp.json
git status --porcelain
```

`git status` must print nothing. Reload the window once more so the harness is back to the real layout.

### 2.6 Hooks fire, and what they are shown

The capture hook from §1.3 is already armed. The repo's own hooks also run. Send these four prompts **one at a time**, each
in the same chat, and let each finish. Approve any permission prompt for the exact action described.

1. `Run exactly this shell command and show me its output: rg --version`
   The repo hook `bash-grep-nudge.mjs` tries to **deny** a leading `rg`. Record: was the command blocked? What message
   did you see, if any? Was it allowed? (This shows whether Claude's nested deny shape is honoured.)
2. `Create the file scratch/smoke-a.mjs with exactly one line: export const x = 1;`
3. `In scratch/smoke-a.mjs change 1 to 2.`
4. `Create scratch/smoke-b.mjs containing the text: try { x() } catch {}`
   The repo hook `quickfix-scan.mjs` is meant to flag this shape. Record whether any hook message reached the chat.

For prompts 2-4 also record **which tool the agent used** (the chat usually shows the tool name: `create`, `edit`,
`str_replace_editor`, `apply_patch` or another). Tool names for Copilot are unpublished, so the exact word matters.

Now count what the capture hook caught (it does not print anything into VS Code itself):

```powershell
Get-ChildItem (Join-Path $capture (Get-Content (Join-Path $capture 'current-host.txt'))) -Filter *.json |
  Where-Object { $_.Name -notlike '*.meta.json' } | Measure-Object | Select-Object -ExpandProperty Count
```

A count of zero after four prompts means this harness did not run the capture hook. Record `hooks: no capture` and carry
on; that is a finding (it also means `.github/hooks` is not read there). Then check whether the repo's own
`.claude/settings.json` hooks left a trace: `Get-Content .audit\quickfix-hits.jsonl -ErrorAction SilentlyContinue`.
Record whether a new line mentioning `smoke-b.mjs` exists (that proves the quick-fix hook parsed that harness's payload).

Delete the scratch files at the end of §7, not now: a half-removed set confuses the check.

### 2.7 Agent sessions: create with a worktree, list, message

Send this to the agent (H1 and H2 use the VS Code session tools; for H3 see the second block):

```text
Start a new independent session in a new worktree. Its task is: reply with the word pong and stop.
Then list your sessions and tell me the new one's status.
Then send that session the follow-up: say ping again.
Finally tell me the EXACT name of the tool you used for each of the three actions (start, list, message).
```

Record: for each of start, list and message, `worked` or `no tool`, and the exact tool name given. Note whether the
new session shows in the Agents window with a worktree, and whether a rate-limit message appeared
(`chat.agentHost.agentOrchestrationLimits`). When you finish, archive the new session in the Agents window and remove its
worktree in §7.

**H3 only** (the Claude Code extension; `ListAgents` and `SendMessage` need Claude Code v2.1.224, v2.1.234 on native
Windows). Send: `Use ListAgents to list my sessions, then tell me what you saw. Then try to start one with claude --bg "reply pong".`
Record what `ListAgents` returned, whether `claude` was found, and whether a `--bg` session was created. If you ran
`claude --bg`, stop it afterwards with `claude agents` (it lists them; stop the one you made).

### 2.8 Titles

Record whether the agent exposes a way to **title** or **archive** a session (ask: `Can you rename or archive this
session yourself? Name the tool.`). The answer decides how `fleet` chips are told to set a title on VS Code.

## 3. Repeat for the other harnesses

At the start of H2 and H3 switch the capture word (§2, first block) and open a new chat in that harness. Run §2.1 to §2.8
again. Do not close VS Code between harnesses (the env variable from §1.4 must stay in force).

## 4. Fleet smoke test (hosts.md two-session test)

Once, in the harness you will actually use for fleet (note which). This is the test from `hosts.md` ("Smoke test per host
before relying on it"). You need two sessions on two worktrees: start two sessions in the Agents window with **New Worktree**
(call them A and B), and open a terminal in each. Run the commands in each session's own worktree.

In A:

```powershell
node scripts/fleet.mjs claim --id smoke-a --intent "smoke test" --paths "scratch/a/**"
```

In B:

```powershell
node scripts/fleet.mjs claim --id smoke-b --intent "smoke test" --paths "scratch/b/**"
node scripts/fleet.mjs status
```

Record: both `smoke-a` and `smoke-b` appear in `status`. (A warning that the claim id is not the branch name is
expected.) Now the overlap refusal, in B:

```powershell
node scripts/fleet.mjs claim --id smoke-c --intent "overlap" --paths "scratch/a/**"
$LASTEXITCODE
```

Record: the claim is **refused** with exit `3`, naming the other session.

The heavy-slot lease (minutes; if the lease reports peak hours, run it outside 14:00-20:00 on a weekday):

```powershell
node scripts/fleet.mjs lease run --kind gate --for 5 --wait 0 --timeout 4 -- node -e 'setTimeout(function(){}, 180000)'
```

Start that in A first, then in B within a minute:

```powershell
node scripts/fleet.mjs lease run --kind gate --for 5 --wait 1 --timeout 4 -- node -e 'setTimeout(function(){}, 1000)'
node scripts/fleet.mjs lease status
```

Record: B **waited and then gave up** (or queued) while A held the slot, and `lease status` names the holder.

Last three checks, in A, with the agent:

1. **A job outlives the turn.** Ask A's agent to start the 180-second `lease run` above in a background terminal and then
   end its turn. While no turn is active, run `node scripts/fleet.mjs lease status` from B. Record whether the holder is
   still A.
2. **State survives a reload.** Run `Developer: Reload Window`, then `node scripts/fleet.mjs status`. Record whether both
   claims are still listed.
3. **Shipping needs your go-ahead.** Tell A's agent: `Land this branch now.` Record that it **asks you** (and does not run
   `node scripts/fleet.mjs land` by itself).

Release when done (both worktrees):

```powershell
node scripts/fleet.mjs release --id smoke-a --abandoned
node scripts/fleet.mjs release --id smoke-b --abandoned
```

Then archive sessions A and B in the Agents window and remove their worktrees in §7.

## 5. Can the Copilot harness run the repo's `.sh` hook on Windows?

One more observation, free, while the capture runs. In H1, the repo's `arch-memory-check.sh` is configured with
`"shell": "bash"`. Whether Copilot on Windows *can* execute a `.sh` hook is unverified. Look
in the VS Code Output panel for the channel named for hooks (`Output: Focus on Output View`, then choose the Copilot or
hooks channel) and record any error mentioning `arch-memory-check.sh`, or `none seen`.

## 6. Turn the captures into fixtures

Raw captures contain your prompts and your paths. They are never committed. A fixture is made **only** by `project.mjs`,
a fail-closed projection. What it does, so you can review it:

- It walks the payload against an enumerated list of allowed keys. **Any key not on the list is dropped** and its name
  is printed to stderr for you to read. A nested object or array under a non-listed key is dropped whole.
- No original string survives, except the event name and the tool name, which are checked against a closed list.
  Everything else becomes a synthetic value: the timestamp becomes `2026-01-01T00:00:00.000Z`, `session_id` becomes
  `fixture-session`, a path becomes `src/fixture.mjs`, a prompt becomes `fix the fixture bug`, a command becomes
  `rg fixturePattern src`, and edited text becomes `try { x() } catch {}`.
- The **key names inside `tool_input` are kept** (that is the whole point: nobody has published them), one level deep. A
  key whose name is not a plain identifier, and any nested value under it, is dropped and reported.
- It refuses (exit 2, no output file) on an unsupported event or an unknown tool name.

### 6.1 Check the hooks really saw the disable flag

```powershell
Get-ChildItem $capture -Recurse -Filter *.meta.json |
  ForEach-Object { (Get-Content -Raw $_.FullName | ConvertFrom-Json).archMemoryHookDisable } |
  Group-Object | Select-Object Name, Count
```

Every row must be `1`. A row showing nothing or `null` means a hook child did **not** inherit the variable and the repo's
arch-memory hook may have paid for a query during that prompt: write that in your results and do not hide it.

### 6.2 Project each host's captures

Run once per host folder that holds captures (`copilot`, `claude-harness`, `claude-extension`). Change `$hostName` each time.

```powershell
$hostName = 'copilot'
$root = 'tests\fixtures\hook-payloads'
$raw = Get-ChildItem (Join-Path $capture $hostName) -Filter *.json | Where-Object { $_.Name -notlike '*.meta.json' }
$refused = 0
foreach ($file in $raw) {
  node (Join-Path $capture 'project.mjs') --host $hostName --root $root --in $file.FullName
  if ($LASTEXITCODE -ne 0) { $refused++ }
}
"projected: $(@($raw).Count - $refused) refused: $refused"
```

The script prints the fixture path it wrote, one line per payload, and skips one that already exists (a fixture is
named after the event and tool, for example `pretooluse.bash.json`). **Read stderr.** A line `dropped key: ...` names something the allowlist did not know. Do
not add it blindly: paste the names into your results, and the coordinator decides.

### 6.3 Review before anything is committed

```powershell
git status --short tests/fixtures/hook-payloads
Get-ChildItem tests\fixtures\hook-payloads -Recurse -File | ForEach-Object { "--- $($_.FullName)"; Get-Content $_.FullName }
Get-ChildItem tests\fixtures\hook-payloads -Recurse -File |
  Select-String -Pattern '[A-Za-z]:[\\/]', 'Users[\\/]', 'AppData', '/home/', $env:USERNAME
```

Read every fixture. The last command must print **nothing**; any line it prints is a leak, so delete that fixture and tell
the coordinator. The fixtures should hold only the synthetic values listed above.

### 6.4 Where the fixtures land (Cluster D reads them from here)

```text
tests/fixtures/hook-payloads/copilot/
tests/fixtures/hook-payloads/claude-harness/
tests/fixtures/hook-payloads/claude-extension/
```

Cluster D's Tier 2 (the quick-fix, syntax and grep hooks reading Copilot's tool input) needs, under `copilot/`:
`pretooluse.bash.json` or `pretooluse.powershell.json` (the shell command), `posttooluse.edit.json` or
`posttooluse.str_replace_editor.json` (an edit), `posttooluse.create.json` (a write) and `userpromptsubmit.json`. If those are missing when Cluster D starts, it
ships Tier 1 only and reports "Tier 2 deferred: no recorded fixtures". Commit only after §7 passes:

```powershell
git switch -c vscode-hook-fixtures
git add tests/fixtures/hook-payloads
git commit -m "test: recorded VS Code hook payload fixtures (projected, synthetic values)"
git push -u origin vscode-hook-fixtures
```

Do not push to `main`. Tell the CES coordinator the branch name; it lands the PR.

## 7. Cleanup — always run this, even if a step failed

It removes the capture hook, its scripts, the raw captures and everything the checks created, then **checks each removal**.

```powershell
$capture = Join-Path $env:LOCALAPPDATA 'ces-hook-capture'
Remove-Item -LiteralPath '.github\hooks\payload-capture.json' -Force -ErrorAction SilentlyContinue
if (Test-Path '.github\hooks') { if (-not (Get-ChildItem '.github\hooks' -Force)) { Remove-Item -LiteralPath '.github\hooks' -Force } }
Remove-Item -LiteralPath $capture -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath scratch -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path .mcp.json.off) { Rename-Item -LiteralPath .mcp.json.off -NewName .mcp.json }
Remove-Item Env:ARCH_MEMORY_HOOK_DISABLE -ErrorAction SilentlyContinue
git worktree list
```

`git worktree list` shows the worktrees the agent sessions created in §2.7 and §4. Remove each one you made with
`git worktree remove --force $path` (set `$path` to the one listed) after archiving its session, and only those.
Then the checks:

```powershell
Test-Path '.github\hooks\payload-capture.json'
Test-Path (Join-Path $capture 'capture.mjs')
Test-Path $capture
git status --porcelain --ignored -- .github/hooks
git status --porcelain -- scratch .mcp.json .mcp.json.off
```

The first three must each print `False`. The last two must print **nothing**.

**If any prints `True` or any text, cleanup failed: stop here, fix it, and run this section again before you paste anything back.** (Fixtures you generated in §6
show in `git status --short tests/fixtures`; that is expected and is not part of this check.)

Finally quit and relaunch VS Code normally, so the next session is not running with the disable flag.

## 8. Copilot cloud agent (H4) — optional, skip by default

It runs on GitHub and cannot be smoke-tested on your machine. It needs a GitHub write (an issue or task), and may use
premium requests, so it is your call, not the coordinator's. If you want one data point, assign it a one-line task
(for example "list the skills you can see") from a throwaway issue on a **non-production** repo, and paste back what it
reports about skill discovery. Do not add secrets or change the repo's Copilot environment for this. Write `skipped` if you
do not run it.

## 9. The two scripts

`capture.mjs` is the diagnostic hook: it stores each raw payload outside the repo and never blocks. `project.mjs` is the
fail-closed projection. Both are extracted by §1.3 from the fences below (the marker comment on the line before each
fence is what the extraction matches, so do not edit it). Their own tests are in
[`tests/vscode-host-smoke-scripts.test.mjs`](../../tests/vscode-host-smoke-scripts.test.mjs), which extracts the same fences.

<!-- smoke-script: capture.mjs -->
```js
// capture.mjs - diagnostic hook. Stores the raw hook payload OUTSIDE the repo. Never prints, never blocks (exit 0).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const base = process.env.CES_CAPTURE_DIR || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ces-hook-capture') : '');
if (!base || !isAbsolute(base)) {
  process.stderr.write('[capture] no absolute capture dir; nothing written\n');
  process.exit(0);
}
try {
  let host = 'unknown';
  try {
    const word = readFileSync(join(base, 'current-host.txt'), 'utf8').trim();
    if (/^[a-z-]{1,30}$/.test(word)) host = word;
  } catch { /* keep unknown */ }
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* empty stdin */ }
  const dir = join(base, host);
  mkdirSync(dir, { recursive: true });
  const stem = Date.now() + '-' + process.pid;
  let ext = '.json';
  try { JSON.parse(raw); } catch { ext = '.txt'; }
  writeFileSync(join(dir, stem + ext), raw);
  writeFileSync(join(dir, stem + '.meta.json'), JSON.stringify({
    archMemoryHookDisable: process.env.ARCH_MEMORY_HOOK_DISABLE ?? null,
    host,
    cwd: process.cwd(),
  }) + '\n');
} catch (err) {
  process.stderr.write('[capture] ' + String(err && err.message) + '\n');
}
process.exit(0);
```

<!-- smoke-script: project.mjs -->
```js
// project.mjs - fail-closed schema projection of ONE raw hook payload into a committable fixture.
// usage: node project.mjs --host copilot|claude-harness|claude-extension --root tests/fixtures/hook-payloads --in raw.json [--name slug]
// Exit 0 = wrote (or skipped an existing) fixture; exit 2 = refused, nothing written. Dropped key names go to stderr.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'userPromptSubmitted', 'preToolUse', 'postToolUse'];
const TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Grep', 'Glob', 'Agent', 'Task',
  'bash', 'powershell', 'edit', 'str_replace_editor', 'apply_patch', 'create', 'view', 'grep', 'glob', 'task'];
const HOSTS = ['copilot', 'claude-harness', 'claude-extension'];
const FIXED_TIME = '2026-01-01T00:00:00.000Z';
// Allowed envelope keys, each with the synthetic string that replaces its value. null = checked verbatim against a closed list.
const ENVELOPE = {
  hook_event_name: null, tool_name: null, timestamp: FIXED_TIME, session_id: 'fixture-session', cwd: '/fixture/repo',
  transcript_path: 'fixture-transcript.jsonl', permission_mode: 'default', prompt: 'fix the fixture bug', tool_use_id: 'fixture-tool-use',
};
const ROLES = [
  [/^(file_?path|path|file|file_?name|target_?file)$/i, 'src/fixture.mjs'],
  [/^(command|cmd|script|shell_?command)$/i, 'rg fixturePattern src'],
  [/^(old_?str(ing)?|old_?text)$/i, 'fixture old text'],
  [/^(new_?str(ing)?|content|file_?text|text|insert_?text|code|patch|input)$/i, 'try { x() } catch {}'],
];
const KEY_SHAPE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

function refuse(why) { process.stderr.write('[project] refused: ' + why + '\n'); process.exit(2); }
const dropped = [];
function drop(path) { dropped.push(path); process.stderr.write('dropped key: ' + path + '\n'); }
function scalar(value, text) {
  if (typeof value === 'string') return text;
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined; // object or array: caller drops it whole
}

const args = process.argv.slice(2);
const opt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const host = opt('--host');
const root = opt('--root');
const input = opt('--in');
let name = opt('--name');
if (!HOSTS.includes(host)) refuse('--host must be one of ' + HOSTS.join(', '));
if (!root || !input) refuse('--root and --in are required');
if (name !== undefined && !/^[a-z0-9][a-z0-9.-]{0,60}$/.test(name)) refuse('--name must match [a-z0-9][a-z0-9.-]*');

let payload;
try { payload = JSON.parse(readFileSync(input, 'utf8')); } catch { refuse('input is not valid JSON'); }
if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) refuse('payload is not an object');
if (!EVENTS.includes(payload.hook_event_name)) refuse('unsupported event ' + JSON.stringify(String(payload.hook_event_name).slice(0, 40)));
const isTool = /tooluse/i.test(payload.hook_event_name);
if (isTool && !TOOLS.includes(payload.tool_name)) refuse('unknown tool_name ' + JSON.stringify(String(payload.tool_name).slice(0, 40)));
if (!isTool && payload.tool_name !== undefined && !TOOLS.includes(payload.tool_name)) refuse('unknown tool_name ' + JSON.stringify(String(payload.tool_name).slice(0, 40)));

const out = {};
for (const [key, value] of Object.entries(payload)) {
  if (key === 'tool_input') continue;
  if (!(key in ENVELOPE)) { drop(key); continue; }
  if (ENVELOPE[key] === null) { out[key] = value; continue; } // event and tool names: validated above
  const kept = scalar(value, ENVELOPE[key]);
  if (kept === undefined) { drop(key); continue; }
  out[key] = key === 'timestamp' && typeof value === 'number' ? 1767225600000 : kept;
}
if ('tool_input' in payload) {
  const ti = payload.tool_input;
  if (ti === null || typeof ti !== 'object' || Array.isArray(ti)) refuse('tool_input is not an object');
  out.tool_input = {};
  for (const [key, value] of Object.entries(ti)) {
    if (!KEY_SHAPE.test(key)) { drop('tool_input.(unsafe key name)'); continue; }
    const role = ROLES.find(([re]) => re.test(key));
    const kept = scalar(value, role ? role[1] : 'fixture-value');
    if (kept === undefined) { drop('tool_input.' + key); continue; }
    out.tool_input[key] = kept;
  }
}

if (name === undefined) name = (payload.hook_event_name + (payload.tool_name ? '.' + payload.tool_name : '')).toLowerCase().replace(/[^a-z0-9.]+/g, '-');
const dir = join(root, host);
const file = join(dir, name + '.json');
if (existsSync(file) && opt('--name') === undefined) { process.stdout.write('exists, skipped ' + file + '\n'); process.exit(0); }
mkdirSync(dir, { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
process.stdout.write('wrote ' + file + '\n');
```

## 10. What to paste back

Paste this table, filled in, into the chat with the CES coordinator. One block per harness; use the result words from §2
and quote the exact tool names and message text you saw. Nothing in it should contain a prompt of yours, a path to your
home folder, or a secret.

```text
Run date:
VS Code version:            Copilot / Copilot Chat / Anthropic extension versions:
ARCH_MEMORY_HOOK_DISABLE=1 set before launch: yes/no     §6.1 result (all rows 1?):
Machine (home or work):     Enterprise policy limiting harnesses: yes/no/unknown

Harness: H1 Copilot / H2 Claude harness / H3 Claude extension (or unavailable)
2.1 skills listed from .claude/skills:            (which names; any duplicates)
2.2 /name args delivered:
2.3 disable-model-invocation honoured (ship, security-strategy):
2.4 allowed-tools Bash(...) behaviour:
2.5A MCP servers as the repo is:                  (names; duplicates)
2.5B MCP servers with only .vscode/mcp.json:      (still listed?)
2.6 hooks: capture count; rg command blocked? message text; quick-fix message seen? quickfix-hits line?
2.6 tool names used for create / edit:
2.7 session tools: start / list / message          (worked or no tool; exact tool names; rate-limit message?)
2.8 title / archive tool:
5   hook runner errors for arch-memory-check.sh:

Fleet (§4) harness used:
  both claims in status / overlap refused exit 3 / second heavy job waited / job outlived turn /
  state survived reload / shipping asked for go-ahead:
Dropped key names printed by project.mjs (§6.2):
Fixtures written (the file list from §6.4) and the §6.3 leak scan result:
Cleanup (§7): all three Test-Path False? last two commands printed nothing?
Anything that surprised you:
```

**What happens next.** Cluster D reads the fixtures to decide whether the Copilot tool-input fields can be mapped
(Tier 2) or stay deferred. Cluster E, or the coordinator, records your table into the `skills/fleet/references/hosts.md`
matrix, turning each cell from **doc** or **unverified** into **obs**, stamped with the harness version and the run date.
A cell you could not run stays as it is, and is never promoted without your observation.
