/**
 * @fileoverview CES's own checklist, as a pure function of committed source (verification-lessons Phase 5, Category B).
 *
 * `.audit-loop/checklist.json` is GENERATED from this file plus the gate contracts it binds to: each migrated gate's `stated`
 * sentence and contract file are read from `scripts/gate-contracts/*.json` and `skills/*\/gate-contract.json`, never restated
 * here, so the entry and the contract cannot drift. Regenerate with `npm run checklist:gen`; `npm run checklist:gen:check`
 * (in `check:static`) fails on any byte of difference, so the file is never hand-edited.
 *
 * Source-repo-only: this is CES's own incident history. A consumer receives the matcher and an absent file, never these entries.
 *
 * @module scripts/lib/checklist/gen
 */
import fs from 'node:fs';
import path from 'node:path';

/** Every gate of every contract, with the file it lives in. */
function loadGates(repoRoot) {
  const out = [];
  const add = (file) => {
    const j = JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
    for (const g of j.gates ?? []) out.push({ file, id: g.id, stated: g.stated });
  };
  const dir = path.join(repoRoot, 'scripts', 'gate-contracts');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_')).sort()) add(`scripts/gate-contracts/${f}`);
  for (const d of fs.readdirSync(path.join(repoRoot, 'skills')).sort()) {
    const f = `skills/${d}/gate-contract.json`;
    if (fs.existsSync(path.join(repoRoot, f))) add(f);
  }
  return out;
}

/** The skill markdown files the size ratchet already pins (over the limit), sorted: the files that may not grow. An empty
 *  list is valid (every file shrank under the limit); the baseline and the ratchet stay in the trigger either way. */
function oversizedSkillFiles(repoRoot) {
  const j = JSON.parse(fs.readFileSync(path.join(repoRoot, '.skill-size-baseline.json'), 'utf8'));
  return Object.keys(j.files ?? {}).sort();
}

/** @param {string} repoRoot @returns {string} the exact text of `.audit-loop/checklist.json` */
export function buildChecklistText(repoRoot) {
  const census = loadGates(repoRoot);
  // Spelled in two pieces so this generator's own SOURCE is not read by the entry-guard census as a hand-written entry guard: the text it
  // emits (the checklist) is unchanged.
  const ARGV1 = 'process.argv' + '[1]';
  const NEG = 'scripts/lib/vcs.mjs';
  const entries = [];
  function gated(id, prefix, { trigger, lead, context, incident, control, negativePath = NEG }) {
    const row = census.filter((c) => c.id.startsWith(prefix));
    if (row.length !== 1) throw new Error(`checklist gen: prefix ${prefix} matches ${row.length} gates`);
    const g = row[0];
    const check = `${lead} ${context.replace('@@', g.stated)}`;
    if (!check.includes(g.stated)) throw new Error(`checklist gen: stated not in check ${id}`);
    entries.push({ id, trigger, check, incident, control: { ...control, negativePath }, gateContract: `${g.file}#${g.id}`, stated: g.stated });
  }
  function plain(id, { trigger, check, incident, control, negativePath = NEG }) {
    entries.push({ id, trigger, check, incident, control: { ...control, negativePath } });
  }
  const NOINC = (gate) => `No dated incident is recorded in AGENTS.md for this rule; it is backed by the ${gate} gate, which fails the push on the mistake.`;

gated('anthropic-pin-unserviceable-param', 'anthropic-pin-gate', {
  trigger: { paths: ['scripts/lib/anthropic-client.mjs', 'scripts/lib/anthropic-cli-faithfulness.mjs', '.anthropic-pin-census.json'], symbols: ['createAnthropicClient', 'unserviceableCliParams'], patterns: ['\\btool_choice\\s*:'] },
  lead: "A call passing system, tools or tool_choice needs an explicit {backend:'sdk'} pin, or the cli backend throws where CI (the sdk default) never does.",
  context: "AGENTS.md: \"The fix is a declared `{backend:'sdk'}` pin gated on **`isClaudeAvailableFor('sdk')`**, and since the throw cannot fire in CI (which runs the `sdk` default) @@ is the guard.\"",
  incident: '2026-07-14: forced tool_choice on the cli backend returned a plain text block with no error, so the tiered-recall discovery generator fell back to legacy in 20 of 20 runs, a whole shadow window; fixed by #360 (3dabb3f3). Control line is a real call-site line from scripts/campaign.mjs.',
  control: { path: 'scripts/campaign.mjs', text: "        tool_choice: { type: 'auto' }," } });
gated('generated-artifact-bundle-deps', 'bundle-deps-check', {
  trigger: { paths: ['scripts/lib/bundle-deps.json', 'scripts/generate-bundle-deps.mjs', 'scripts/lib/sync-entry-lists.mjs'] },
  lead: 'scripts/lib/bundle-deps.json is a Category B generated file: regenerate it, never hand-edit it.',
  context: 'AGENTS.md (Generated-artifact policy): "Regeneration must be byte-identical ... `scripts/lib/bundle-deps.json` (@@)." Run it after changing the sync entry lists or any import the synced bundle reaches.',
  incident: NOINC('bundle:deps:check'),
  control: { path: 'scripts/lib/bundle-deps.json', text: '    "left-pad": "1.3.0"' } });
gated('context-check-agents-md-size', 'context-check', {
  trigger: { paths: ['AGENTS.md', 'CLAUDE.md', '.claude-context-allowlist.json', 'scripts/check-context-drift.mjs'] },
  lead: 'AGENTS.md is loaded every session, so its size is a cost: condense, do not raise the cap.',
  context: 'AGENTS.md (preamble): "**Enforced since 2026-07-13**: @@ the pre-push hook and `/ship` Step 4) fails on `ctx/oversized-agents-md` above **79000 characters** ... condense a dossier section to a stub + `docs/<topic>.md` rather than raising the cap." Also: 26 sentences in AGENTS.md are quoted by gate contracts, so list them (gate-honesty.md) before rewording one.',
  incident: NOINC('context:check'),
  control: { path: 'AGENTS.md', text: '> A new paragraph that adds to the always-loaded context.' } });
gated('db-suite-two-edit-enrolment', 'db-enrolment-gate', {
  trigger: { paths: ['scripts/lib/db-test-container.mjs', '.github/workflows/postgres-parity.yml', 'scripts/check-db-suite-enrolment.mjs'], patterns: ['AUDIT_DB_TEST_URL'] },
  lead: 'A DB-gated test suite no runner names has never run: node reports a never-run suite as a clean pass.',
  context: 'AGENTS.md: "**Adding a DB-gated suite is two edits, never one**; @@ iterates the FILESYSTEM, the only side that can see a file no list mentions." Enrol it in db-test-container.mjs\'s *_SUITE_FILES AND postgres-parity.yml.',
  incident: '2026-08-11 census: 15 DB-gated suites were enrolled nowhere and had never run.',
  control: { path: 'tests/new-store-feature.test.mjs', text: 'const URL = process.env.AUDIT_DB_TEST_URL; // skips itself when unset' } });
gated('architecture-intent-domain-roster', 'architecture-intent-check', {
  trigger: { paths: ['.audit-loop/domain-map.json', 'docs/architecture-intent.md'] },
  lead: 'Every domain declared in the domain map needs a heading in docs/architecture-intent.md.',
  context: 'AGENTS.md: "[`docs/architecture-intent.md`] documents each domain as a `### <domain>` heading; **@@** that the two agree." `npm run docs:architecture-intent:check` fails when the map declares a domain the doc never documents.',
  incident: NOINC('docs:architecture-intent:check'),
  control: { path: '.audit-loop/domain-map.json', text: '      "domain": "checklist-new-domain"' } });
gated('synced-markdown-relative-links', 'docs-synced-links-gate', {
  trigger: { paths: ['scripts/check-synced-doc-links.mjs'], patterns: ['\\]\\(\\.\\.?/[^)\\s]+\\.md'] },
  lead: 'A relative link in synced markdown resolves where the file LANDS in a consumer, not where you wrote it.',
  context: 'AGENTS.md (seven shapes): "a **relative link** in synced markdown, whose href resolves where the file LANDS (@@)". Name synced tooling by path; link docs only by a path the sync also ships.',
  incident: 'Consumer-reported shape (6) of the seven: a relative href in synced markdown resolved to a path the consumer never received.',
  control: { path: 'skills/ship/references/example.md', text: 'See [the runbook](../../docs/runbooks/gate-cost.md) for the cost.' } });
gated('emit-softfail-opt-out', 'emit-exit-gate', {
  trigger: { paths: ['scripts/lib/cli-io.mjs', 'scripts/check-emit-exit-agreement.mjs'], symbols: ['softFail'], patterns: ['\\bsoftFail\\s*:'] },
  lead: 'emit({ok:false}) sets a non-zero exit; opting out needs a stated reason and a re-baseline.',
  context: 'AGENTS.md: "Opt out only with `emit(env, {softFail:true, reason})` — the reason is **required** — and `@@` ratchets the opt-out population, failing on growth AND on an unrecorded reduction."',
  incident: 'Without the coupling a CLI reports a failure in its envelope and exits 0, which every caller checking $? reads as success (cross-skill-command-registry plan, 2b F4).',
  control: { path: 'scripts/some-cli.mjs', text: "emit(env, { softFail: true, reason: 'advisory' });" } });
gated('gitignore-rule-declares-why', 'gitignore-policy', {
  trigger: { paths: ['.gitignore', '.gitignore-policy-baseline.json'] },
  lead: 'A new .gitignore rule must sit under a comment block declaring its Category (A, B or P).',
  context: 'AGENTS.md: "**@@, and a private one declares where it durably lives.**" Category P (private and load-bearing) owes a `Durable home:`.',
  incident: 'Skipping the durable-home question left 37 tech-debt entries on exactly one disk (AGENTS.md, gitignore policy).',
  control: { path: '.gitignore', text: '.audit-loop/new-private-state.json' } });
gated('cli-help-is-a-pure-read', 'help-readonly-gate', {
  trigger: { paths: ['scripts/*.mjs', 'scripts/lib/help-guard-run.mjs', 'scripts/check-help-readonly.mjs'] },
  lead: "A CLI that ignores --help simply RUNS. Make `import './lib/help-guard-run.mjs'` the first import and keep a --help / unknown-flag contract.",
  context: 'AGENTS.md: "**`--help` is a pure read on every CLI.** @@ runs each one with `--help` under a preload that blocks writes, network and mutating spawns (a CLI that ignores the flag simply RUNS: `prepush-check --help` created a worktree)."',
  incident: '`prepush-check --help` created a worktree (AGENTS.md).',
  control: { path: 'scripts/brand-new-cli.mjs', text: 'const target = process.argv[2];' } });
gated('mcp-config-mirrored', 'mcp-parity', {
  trigger: { paths: ['.mcp.json', '.vscode/mcp.json', 'scripts/check-mcp-parity.mjs'] },
  lead: 'Adding or changing an MCP server means editing BOTH config files.',
  context: 'AGENTS.md: "VS Code Copilot reads @@" Claude Code and the default VS Code Copilot harness read .mcp.json; .vscode/mcp.json is only forwarded on the default harness; the parity gate checks both shapes (a Windows `npx` server needs its `-y`).',
  incident: 'The two files had to stay mirrored and nothing enforced it until the parity gate (tests/mcp-parity.test.mjs header).',
  control: { path: '.mcp.json', text: '    "new-server": { "command": "npx", "args": ["new-server"] }' } });
gated('own-model-capture-column-coverage', 'own-model-coverage-gate', {
  trigger: { paths: ['.own-model-coverage.json', 'scripts/own-model-coverage.mjs', 'tests/fixtures/expected-schema.json'], patterns: ['ADD COLUMN|add column'] },
  lead: 'A new nullable own-model telemetry column needs a coverage entry (or a reasoned exemption) in .own-model-coverage.json.',
  context: 'AGENTS.md: "**@@**" `.own-model-coverage.json` tracks the own-model telemetry columns with hand-set floors; `npm run own-model:coverage:gate` fails when an entry names a column the schema fixture lacks, or a nullable column a covered migration added has no entry.',
  incident: NOINC('own-model:coverage:gate'),
  control: { path: 'supabase/migrations/20261122000000_example.sql', text: 'ALTER TABLE audit_runs ADD COLUMN example_capture_ms integer;' } });
gated('migrations-schema-portable', 'parity-coupling', {
  trigger: { paths: ['supabase/migrations/**', 'scripts/postgres-parity/check-non-core-references.mjs'] },
  lead: 'Migrations stay schema-portable: no schema qualification, no non-core reference.',
  context: 'AGENTS.md: "**Migrations stay schema-portable**: @@ qualification or non-core reference outside the recorded baseline." Read the LIVE migration definition (migrations are cumulative) and never use the Supabase dashboard as the migration path.',
  incident: NOINC('parity:check-coupling'),
  control: { path: 'supabase/migrations/20261122000000_example.sql', text: 'CREATE TABLE public.example (id uuid);' } });
gated('generated-artifact-plans-index', 'plans-index-check', {
  trigger: { paths: ['docs/plans/README.md', 'docs/plans/*.md', 'scripts/generate-plans-index.mjs'] },
  lead: "docs/plans/README.md is the generated plans index (Category B): a plan's status change needs `npm run plans:index`.",
  context: 'AGENTS.md (Generated-artifact policy): "Regeneration must be byte-identical ... `docs/plans/README.md`, the @@, ..." The index reads TRACKED plans only.',
  incident: NOINC('plans:index:check'),
  control: { path: 'docs/plans/verification-lessons.md', text: '**Status**: shipped' } });
gated('generated-artifact-requirements-map', 'requirements-map-check', {
  trigger: { paths: ['docs/requirements-map.md', '.requirements/ledger.json', 'scripts/requirements.mjs'] },
  lead: 'docs/requirements-map.md is generated from .requirements/ledger.json (Category B): regenerate it after a ledger change.',
  context: 'AGENTS.md (Generated-artifact policy): "... `docs/requirements-map.md` (@@) ..." Hand-editing it fails requirements:map:check.',
  incident: NOINC('requirements:map:check'),
  control: { path: '.requirements/ledger.json', text: '      "status": "active",' } });
gated('generated-skills-copy-never-hand-edited', 'skills-check-detects-hand-edited', {
  // v4: the mistake is a copy changed WITHOUT its source. A regenerated copy (the right move) ships beside its source edit and
  // used to fire this on every skill PR.
  trigger: { paths: ['scripts/regenerate-skill-copies.mjs'], unpairedPaths: [{ path: '.claude/skills/', source: 'skills/' }] },
  lead: '.claude/skills/ is generated from skills/: edit skills/<name>/, then regenerate.',
  context: 'AGENTS.md: "`.claude/skills/<name>/` is the @@ and **never hand-edit it**."',
  incident: NOINC('skills:check'),
  control: { path: '.claude/skills/ship/SKILL.md', text: 'Hand-edited line in the generated copy.' } });
gated('skill-reference-summary-byte-match', 'skills-check-detects-shared-reference-drift', {
  // v4: a body edit of a shared reference cannot break the byte-match; a changed `summary:` line or index row can (the patterns).
  trigger: { paths: ['scripts/sync-shared-audit-refs.mjs'], patterns: ['^summary:', '^\\| `references/'] },
  lead: "A reference file's `summary:` frontmatter must byte-match its parent SKILL.md reference-index row; edit the canonical shared reference, never a synced copy.",
  context: 'AGENTS.md: "@@ the parent SKILL.md\'s reference-index row, enforced by `npm run skills:check`".',
  incident: NOINC('skills:check'),
  control: { path: 'skills/audit-code/references/round-recipes.md', text: 'summary: a reworded summary that no longer matches the index row' } });
gated('skill-frontmatter-description-budget', 'skills-check-detects-over-budget', {
  trigger: { paths: ['scripts/check-skill-descriptions.mjs'], patterns: ['^(name|description):'] },
  lead: "A skill's description is required and capped; a bad `name` is a silent skip.",
  context: 'AGENTS.md: "**(3) Frontmatter is a contract** (enforced by `skills:check`), and its sharpest trap is silence: a bad `name` is a **silent skip**; @@; every optional key sits at **column 0**".',
  incident: 'A bad `name` is a silent skip: the skill vanishes from discovery with no error (AGENTS.md, skill surfaces invariant 3).',
  control: { path: 'skills/ship/SKILL.md', text: 'description: a description edited without re-measuring its length' } });
gated('skill-frontmatter-indented-key-inert', 'skills-check-detects-indented', {
  trigger: { paths: ['scripts/check-skill-frontmatter.mjs'], patterns: ['^\\s+(argument-hint|allowed-tools|user-invocable|disable-model-invocation|model|summary):'] },
  lead: 'An optional frontmatter key indented under `description: |` is description text, not a key.',
  context: 'AGENTS.md: "every optional key sits at **column 0** — @@ valid and **inert**."',
  incident: 'An indented key parsed, validated and did nothing: description TEXT, inert (AGENTS.md, skill surfaces invariant 3).',
  control: { path: 'skills/ship/SKILL.md', text: '  argument-hint: <indented under description, so inert>' } });
gated('synced-skill-content-reachable-refs', 'skills-consumer-refs-gate', {
  trigger: { paths: ['.skill-consumer-refs-baseline.json'], patterns: ['npm run [a-z][\\w:.-]*', 'docs/[\\w./-]+\\.md'] },
  lead: 'Synced skill content must name tooling BY PATH and may not name an `npm run` alias or an out-of-closure docs/ file a consumer cannot reach.',
  context: 'AGENTS.md (seven shapes): "*(5)* synced content naming an `npm run` alias or an out-of-closure `docs/` file — **name synced tooling BY PATH** and the sync rewrites it (@@)".',
  incident: 'Consumer-reported shape (5): synced skill text named an npm alias or docs/ file that did not exist in the consumer.',
  control: { path: 'skills/ship/SKILL.md', text: 'Run `npm run some:repo-only:alias` first.' } });
gated('skill-markdown-size-ratchet', 'skills-size-ratchet', {
  // v4: only a file already over the limit can grow past its baseline, so the trigger is the baseline's own file list (read
  // from the committed baseline, never restated), plus the baseline and the ratchet.
  trigger: { paths: [...oversizedSkillFiles(repoRoot), '.skill-size-baseline.json', 'scripts/skill-size-ratchet.mjs'] },
  lead: 'Skill markdown over 12,000 chars may not grow; move detail to references/.',
  context: 'AGENTS.md: "**@@.** `npm run skills:size:gate` ratchets every `skills/**/*.md` (and the canonical shared references, never the generated copies) in characters against `.skill-size-baseline.json`."',
  incident: NOINC('skills:size:gate'),
  control: { path: 'skills/ship/SKILL.md', text: 'An added paragraph in an oversized SKILL.md.' } });
gated('exit-after-stdout-must-drain', 'stdout-flush-gate', {
  trigger: { paths: ['scripts/lib/cli-io.mjs', 'scripts/check-stdout-flush.mjs'], patterns: ['\\bprocess\\.exit\\('] },
  lead: 'After writing to stdout, exit through `await finishAndExit(code)`, never `process.exit()`.',
  context: 'AGENTS.md: "**@@.** On Windows a piped `process.stdout` is asynchronous — `npm run x`, `x | tee` and every CI capture are pipes — so `process.exit()` **discards whatever has not flushed**, and a truncated JSON envelope reads to its caller as a parse error blamed on the wrong thing."',
  incident: '2026-08-13: azure:routes hung and truncated output because its only exit was a process.exit() (9c104381).',
  control: { path: 'scripts/some-cli.mjs', text: '  process.exit(1);' } });
gated('upstream-report-disposition-resolves', 'upstream-coverage-gate', {
  trigger: { paths: ['scripts/upstream-dispositions.json', 'scripts/lib/doctor/registry.mjs', 'scripts/lib/doctor/probes.mjs', 'scripts/lib/upstream/**'] },
  lead: 'Every TERMINAL upstream report needs a disposition that resolves: a doctor probe id, a tracked regression test, or a written exemption.',
  context: 'AGENTS.md: "**Adopting these skills in a new consumer repo** — the migration recipe and `doctor` (one command over every adoption-friction class, ratcheted by `@@`): consumer-adoption.md §Diagnostics."',
  incident: NOINC('upstream:coverage:gate'),
  control: { path: 'scripts/upstream-dispositions.json', text: '    "deadbeef": { "disposition": "probe", "probe": "no-such-probe" },' } });
gated('visual-contract-doc-example-drift', 'visual-contract-doc-drift', {
  trigger: { paths: ['skills/visual-audit/references/contract-and-bootstrap.md', 'scripts/check-visual-contract-doc-drift.mjs', 'scripts/lib/visual/**'] },
  lead: 'The annotated JSONC example in contract-and-bootstrap.md must match the real VisualContractSchema key set, in both directions.',
  context: 'AGENTS.md: "**A hand-written annotated example in a reference doc is the same seam, one hop over** — `contract-and-bootstrap.md`\'s JSONC example drifted from `VisualContractSchema` @@ both sides\' `z.toJSONSchema(...)` key sets".',
  incident: "The example drifted from VisualContractSchema silently until the doc gate compared both sides' emitted key sets (AGENTS.md, prose-code seam).",
  control: { path: 'skills/visual-audit/references/contract-and-bootstrap.md', text: '  "newKey": "documented but not in the schema",' } });
gated('windowed-view-declares-its-window', 'windowed-views-gate', {
  trigger: { paths: ['.windowed-views.json', 'scripts/check-windowed-views.mjs'], patterns: ['CREATE (OR REPLACE )?VIEW|create (or replace )?view'] },
  lead: 'A store view whose result depends on now() must declare its window in .windowed-views.json.',
  context: 'AGENTS.md: "**@@** `unremediated_acceptances` is a 7-30 day window on `audit_runs.created_at`, so its 116 -> 47 fall over five weeks was rows **aging out**"; every such view declares its window, gated drift-only by `npm run windowed-views:gate`.',
  incident: 'unremediated_acceptances fell 116 to 47 over five weeks purely because rows aged out of a 7-30 day window; the two windows shared 0 rows and 110 of the 116 were still open.',
  control: { path: 'supabase/migrations/20261122000001_view.sql', text: "CREATE OR REPLACE VIEW recent_runs AS SELECT * FROM audit_runs WHERE created_at > now() - interval '7 days';" } });
gated('worktree-documented-command-reachable', 'worktree-preflight', {
  trigger: { paths: ['scripts/check-worktree-preflight.mjs'], patterns: ['scripts/\\.claude-skills/'] },
  lead: 'A skill documenting a command into scripts/.claude-skills/ must warn that the tree is absent in a linked git worktree.',
  context: 'AGENTS.md (seven shapes): "*(4)* a documented command whose tooling cannot reach a linked worktree (@@)".',
  incident: 'Consumer-reported shape (4): a documented command whose tooling is gitignored and so absent in every linked worktree.',
  control: { path: 'skills/ship/SKILL.md', text: 'Run `node scripts/.claude-skills/cross-skill.mjs report` from the repo root.' } });
gated('tiered-shadow-window-epoch-gated', 'tiered-shadow-window-honesty', {
  trigger: { symbols: ['TIERED_SHADOW_CONTRACT_EPOCH', 'comparedRuns'], paths: ['scripts/lib/tiered-shadow*.mjs', 'scripts/lib/tiered-recall/**'] },
  lead: '"Window met" counts only rows stamped with the CURRENT contract epoch; bump the epoch on a meaning-changing fix and re-collect, never backfill.',
  context: 'AGENTS.md: "- **"Window met" is epoch-gated, not eyeballed** (2026-07-26, after the 5th false\n  green): @@; pre-stamp rows are ineligible and the\n  window restarts — re-collect, never backfill."',
  incident: '2026-07-26: the 5th false "window met" read, after which the collector stamps contractEpoch and unstamped rows are ineligible (a584540c).',
  control: { path: 'scripts/lib/tiered-shadow-collector.mjs', text: 'const eligible = rows.filter((r) => r.comparedRuns > 0);' } });

plain('cli-entry-guard-is-isinvokedasscript', {
  trigger: { paths: ['scripts/lib/cli-entry.mjs', 'tests/cli-entry-guards.test.mjs'], patterns: ['import\\.meta\\.url\\s*===\\s*pathToFileURL\\(\\s*process\\.argv', 'process\\.argv\\[1\\]\\s*(===|==|!==)'] },
  check: 'The CLI entry guard is `if (isInvokedAsScript(import.meta.url))` — never a hand comparison of ' + ARGV1 + ' with import.meta.url. Node realpaths one side and not the other, so through a symlink or junction the hand guard is false and the CLI exits 0 having run nothing.',
  incident: '2026-10-13: 16 of 26 CLIs exited 0 through a symlink having run nothing (#236, 82b63557). Control line is the real pre-fix guard from scripts/check-gate-contracts.mjs.',
  control: { path: 'scripts/check-gate-contracts.mjs', text: 'if (import.meta.url === pathToFileURL(' + ARGV1 + " ?? '').href) {" } });
plain('disposable-db-allowlist', {
  trigger: { symbols: ['assertDisposableDbUrl', 'isDisposableDbHost'], paths: ['scripts/lib/db/client.mjs', 'scripts/lib/db-test-container.mjs'], patterns: ['DROP SCHEMA public CASCADE'] },
  check: '"Disposable" is an ALLOWLIST of loopback hosts and fails CLOSED (isDisposableDbHost / assertDisposableDbUrl). Never re-express it as "not $VENDOR", never point a test DSN at a shared database, and regenerate the schema fixture only from a fresh replay.',
  incident: '2026-07-14: an integration suite swapped AUDIT_DB_URL to AUDIT_DB_TEST_URL and ran DROP SCHEMA public CASCADE against production (0e7c63be). Control line is the destructive statement from that incident.',
  control: { path: 'tests/new-db-integration.test.mjs', text: "await pool.query('DROP SCHEMA public CASCADE');" } });
plain('canonicalize-eol-before-hashing', {
  trigger: { symbols: ['canonicalizeEol'], paths: ['scripts/lib/file-io.mjs', 'scripts/regenerate-skill-copies.mjs'], patterns: ['\\bsha\\(\\w*[bB]uf\\w*\\)\\s*==='] },
  check: 'Hashing working-tree bytes is not hashing committed source: a generator hashing files for a COMMITTED artifact must canonicalise CRLF to LF with canonicalizeEol (lib/file-io.mjs). The tell: git says clean and your tool says changed; git is right.',
  incident: '2026-08-09: the skills sync check hashed raw bytes, so git and the gate disagreed on "same file" on Windows (97988499). Control line is the real pre-fix comparison from scripts/regenerate-skill-copies.mjs.',
  control: { path: 'scripts/regenerate-skill-copies.mjs', text: "  if (dstBuf && sha(srcBuf) === sha(dstBuf)) return 'unchanged';" } });
plain('jsonb-write-seam', {
  trigger: { symbols: ['serializeWriteParam', 'pgArray'], paths: ['scripts/lib/db/query.mjs'] },
  check: 'Do NOT hand-JSON.stringify a jsonb column: serializeWriteParam auto-serializes a plain array bound to ANY column on the write path. Pass jsonb values raw; a real text[]/int[] column opts OUT with pgArray(value).',
  incident: '2026-06-27: node-postgres bound a plain array as an ARRAY literal that jsonb rejected with 22P02 or silently stored as {} (48611728). Control line is from that fix.',
  control: { path: 'scripts/lib/db/query.mjs', text: '  const params = entries.map(([, v]) => serializeWriteParam(v));' } });
plain('durable-write-registration', {
  trigger: { symbols: ['durableWrite'], paths: ['scripts/lib/durable-write.mjs', 'scripts/lib/audit-store-writers.mjs', 'scripts/lib/store/**'] },
  check: "Every audit-store write in legacy-production-audit.mjs's cloud block goes through durableWrite and is registered in audit-store-writers.mjs; a new write-shaped export under scripts/lib/store/** must be registered or exempted with a reason. Outcomes written/spilled/lost/skipped are not interchangeable.",
  incident: '2026-08-12: four audit-store writes were fire-and-forget and failed silently (72e0a0ef, 1019d519).',
  control: { path: 'scripts/lib/store/new-writer.mjs', text: 'export async function writeNewThing(row) { return db.insert(row); }' } });
plain('sensitive-paths-single-oracle', {
  trigger: { symbols: ['resolveAndClassify', 'formatSkipLog'], paths: ['scripts/lib/sensitive-paths.mjs'] },
  check: 'scripts/lib/sensitive-paths.mjs is the single source of truth for sensitive-path classification: never add a fifth implementation, log skips through formatSkipLog (never basenames), and fail closed on a resolution error or a repo-escaping symlink.',
  incident: 'INC-001 in docs/security-strategy.md: a payload the redactor could not process must come back as [REDACTED:redaction-failed], never leak.',
  control: { path: 'scripts/lib/sensitive-paths.mjs', text: 'export function isSensitivePath(p) { return /\\.env$/.test(p); }' } });
plain('provider-route-not-env-var', {
  trigger: { symbols: ['isClaudeAvailable', 'createOpenAIClient'], paths: ['scripts/lib/provider-availability.mjs'], patterns: ['!\\s*process\\.env\\.(ANTHROPIC|OPENAI)_API_KEY'] },
  check: "An availability gate must ask whether a ROUTE exists, not whether a public env var is set: use isClaudeAvailable() / isClaudeAvailableFor('sdk') (lib/provider-availability.mjs), never ANTHROPIC_API_KEY or OPENAI_API_KEY. A raw env check is dead code on Azure and keyless-cli installs.",
  incident: '2026-11-14: scripts/symbol-index/summarise.mjs tested !ANTHROPIC_API_KEY and, under CLAUDE_BACKEND=cli, emitted null summaries for the whole symbol corpus (3dabb3f3). Control line is the real removed test.',
  control: { path: 'scripts/symbol-index/summarise.mjs', text: '  if (!azureConfig.active && !process.env.ANTHROPIC_API_KEY) {' } });
plain('npm-run-flag-swallowed', {
  trigger: { patterns: ['npm run [a-z][\\w:.-]*\\s+--[a-z]'] },
  check: 'A flag written straight after an npm script name is swallowed by npm: it never reaches the script. Put `--` between the script name and the flag, as in `npm run sync -- --target <name>`; without it the sync writes into EVERY consumer.',
  incident: '2026-07-20: the sync run with its target flag and no `--` was verified to write into every consumer instead of the named one.',
  // The control line is spelled with a TAB so this file does not itself trip the npm-args gate it is guarding against.
  control: { path: 'docs/runbooks/gate-cost.md', text: 'Run `npm run sync\t--target wine` to update wine.' } });
plain('prompt-seed-and-mechanical-wave', {
  trigger: { symbols: ['PASS_PROMPTS', 'MECHANICAL_WAVES'], paths: ['scripts/lib/prompt-seeds.mjs', 'scripts/lib/audit-shadow.mjs'] },
  check: "PASS_PROMPTS seed edits roll out GLOBALLY to every consumer. A new mechanical wave must be declared in MECHANICAL_WAVES (audit-shadow.mjs), or PASS_PROMPTS silently enrols it in the model-A/B/C shadow's PAID comparison.",
  incident: 'AGENTS.md "Four imperatives" (1); exp5 fixed four pre-spend blockers before a paid run (6dedaca0).',
  control: { path: 'scripts/lib/prompt-seeds.mjs', text: "  newwave: 'Review the diff for new-wave issues.'," } });
plain('sync-inventory-single-owner', {
  trigger: { symbols: ['sourceRelToDestRel', 'getSyncClosure'], paths: ['scripts/lib/sync-path-map.mjs', 'scripts/lib/sync-inventory.mjs', 'scripts/lib/sync-entry-lists.mjs'] },
  check: "The sync layout's single source of truth is sync-path-map.mjs, and the bundle inventory has ONE owner (sync-inventory.mjs + sync-entry-lists.mjs): never hand-compute a destination path or keep a second copy of an entry list.",
  incident: 'debt 3627c83a: the bundle inventory existed twice, kept in lock-step by a comment and a parity test, until it was unified in sync-inventory.mjs.',
  control: { path: 'scripts/lib/sync-entry-lists.mjs', text: "  'scripts/new-shipped-cli.mjs'," } });
plain('learning-repo-name-is-owner-slash-repo', {
  trigger: { patterns: ['LEARNING_REPO_NAME\\s*[=:]\\s*[\'"]?[^/\\s\'"]+[\'"]?\\s*,?$'] },
  check: 'LEARNING_REPO_NAME must be the `owner/repo` slug (it matches audit_repos.name). A bare repo name silently misses the lookup. install.mjs and setup.mjs derive it; do not hand-type it.',
  incident: 'A bare repo name left weekly-review broken for weeks in every consumer.',
  control: { path: '.env.example', text: 'LEARNING_REPO_NAME=claude-engineering-skills' } });
plain('schema-error-is-not-empty-result', {
  trigger: { symbols: ['isSchemaFaultSqlstate', 'describeSchemaFault'], paths: ['scripts/lib/db/errors.mjs'] },
  check: 'A SCHEMA ERROR IS NOT AN EMPTY RESULT: a bare `catch { return null }` around a query renders a broken query and an absent row as the same value. Use isSchemaFaultSqlstate / describeSchemaFault (db/errors.mjs) to degrade loudly, and put one assertion on a real Postgres, not only on the pure decision.',
  incident: '2026-09-05: the pure tests passed throughout the whole period a freshness cache was dead.',
  control: { path: 'scripts/lib/db/errors.mjs', text: "export function isSchemaFaultSqlstate(code) { return code === '42P01'; }" } });
plain('domain-retag-both-directions', {
  trigger: { paths: ['.audit-loop/domain-map.json'] },
  check: 'RETAGGING A MODULE CHANGES EVERY EDGE *INTO* IT: re-baseline BOTH directions. Moving a file to another domain changes the from-domain of everything it imports and the to-domain of everything that imports it. Do not verify by grep; tests/arm-vocabulary-layering.test.mjs re-derives the whole violation set.',
  incident: 'Three retags in four days forgot the inbound half (d5e66d35, a146bb7b). Control line is a real domain-map edit (47148350).',
  control: { path: '.audit-loop/domain-map.json', text: '      "pattern": "scripts/lib/gate-provenance/**",' } });

// v2: scope each entry's patterns to the files where the pattern means something (trigger.patternPaths).
const CODE = ['scripts/*.mjs', 'scripts/**/*.mjs'];
const SCOPES = {
  'anthropic-pin-unserviceable-param': CODE,
  'db-suite-two-edit-enrolment': ['tests/*.mjs', 'tests/**/*.mjs'],
  'synced-markdown-relative-links': ['skills/**/*.md', 'docs/reference/consistency-contract.md'],
  'emit-softfail-opt-out': CODE,
  'own-model-capture-column-coverage': ['supabase/migrations/**'],
  'synced-skill-content-reachable-refs': ['skills/**/*.md'],
  'skill-reference-summary-byte-match': ['skills/*/references/*.md', 'skills/*/SKILL.md', 'docs/audit/shared-references/*.md'],
  'skill-frontmatter-description-budget': ['skills/*/SKILL.md'],
  'skill-frontmatter-indented-key-inert': ['skills/*/SKILL.md'],
  'worktree-documented-command-reachable': ['skills/**/*.md'],
  'exit-after-stdout-must-drain': CODE,
  'windowed-view-declares-its-window': ['supabase/migrations/**'],
  'cli-entry-guard-is-isinvokedasscript': CODE,
  'disposable-db-allowlist': [...CODE, 'tests/*.mjs', 'tests/**/*.mjs'],
  'canonicalize-eol-before-hashing': CODE,
  'provider-route-not-env-var': CODE,
  'npm-run-flag-swallowed': ['**/*.md', '**/*.json', '**/*.yml'],
};
for (const e of entries) if (SCOPES[e.id]) e.trigger.patternPaths = SCOPES[e.id];
  return JSON.stringify({ version: 1, entries }, null, 2) + String.fromCharCode(10);
}
