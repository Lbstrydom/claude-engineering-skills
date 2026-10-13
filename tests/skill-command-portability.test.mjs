/**
 * Every runnable command in a skill must survive relocation to a consumer repo.
 *
 * Reported 2026-08-08 from a real /plan → /audit-plan session in a consumer:
 * the Gate-1 self-check in `skills/plan/SKILL.md` was
 *
 *   node -e "import('./scripts/lib/plan-paths.mjs').then(…)" docs/plans/x.md
 *
 * which dies with ERR_MODULE_NOT_FOUND there, because a consumer's bundle lives
 * under `scripts/.claude-skills/`. The sync's rewriter
 * (`scripts/lib/sync-rewriter.mjs`) relocates commands via
 * `COMMAND_REGEX = /\bnode\s+scripts\/([^\s`"'),;&|]+)/g` — it only sees the
 * `node scripts/<path>` FORM. A module specifier inside `import()`/`require()`,
 * or inside a heredoc-written helper script, is invisible to it and ships
 * pointing at a path that does not exist.
 *
 * What made this worth a permanent guard rather than a one-off fix: the broken
 * snippet WAS the check protecting against the fuzzy-discovery trap that the
 * twenty lines around it explain at length. The same class was live in two more
 * places at the time (audit-code's detector snippet, ledger-format's heredoc
 * importing `../../scripts/shared.mjs`), so it was a class, not an incident.
 *
 * The rule: reference bundle modules as `node scripts/<path>` (rewritable), or
 * not at all.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { COMMAND_REGEX } from '../scripts/lib/sync-rewriter.mjs';
import { getSyncInventoryForRepo } from '../scripts/lib/sync-inventory.mjs';
import { CONSUMER_REPOS } from '../scripts/lib/consumer-repos.mjs';
import { markdownFiles } from './helpers/fixtures.mjs';

const SKILLS_DIR = 'skills';

/**
 * A module specifier pointing into the bundle's `scripts/` tree from inside
 * `import(...)`, `require(...)`, or an ESM `from '...'` clause. Any leading
 * `./` or `../` chain counts — `../../scripts/shared.mjs` (a heredoc helper
 * two levels down) is the same defect as `./scripts/lib/x.mjs`.
 */
const UNREWRITABLE_SPECIFIER =
  /(?:\bimport\s*\(|\brequire\s*\(|\bfrom\s+)\s*['"`](?:\.{1,2}\/)*scripts\/[^'"`]+['"`]/;

/**
 * Commands a skill mentions that are deliberately SOURCE-REPO ONLY — they are
 * not shipped, and that is correct, because a consumer has nothing to run them
 * against. Each entry needs a reason; the point of the list is that the
 * exception is stated rather than baselined into silence.
 */
const SOURCE_REPO_ONLY = new Map([
  // Maintenance command for THIS repo's canonical shared references: it copies
  // docs/audit/shared-references/* into skills/*/references/. A consumer edits
  // neither side.
  ['scripts/sync-shared-audit-refs.mjs', 'maintains this repo\'s canonical shared references'],
  // /audit-code Step 6.5b says so in its own text: "Source-repo-gated — run
  // ONLY when package.json.name === claude-engineering-skills". The solo
  // control is a centralized research baseline that sweeps sibling repos from
  // here rather than fragmenting across consumers.
  ['scripts/solo-control-audit.mjs', 'source-repo-gated research baseline (Step 6.5b says so explicitly)'],
  // /ship Step 0.5i says so in its own text: "Source-repo-gated — run ONLY
  // when package.json.name === claude-engineering-skills". Model-comparison
  // campaigns are declared in `.campaigns/`, which exists only here; a
  // consumer has no campaign to be stalled on, so shipping the CLI would add
  // a command whose only honest output in a consumer is silence.
  ['scripts/campaign.mjs', 'source-repo-gated: campaigns are declared in .campaigns/, which only this repo has'],
  // /ship's "Train mode" section and references/train-mode.md open with
  // "Source-repo-gated". The train classifies PRs against the sync closure and
  // publishes through this repo's own sync tools; syncing the CLI would pull
  // sync-inventory.mjs and consumer-repos.mjs (both path.resolve(import.meta.dirname,
  // "..")) into the consumer closure, which the relocation guard rightly rejects.
  ['scripts/ship-train.mjs', 'source-repo-gated: its tier oracle and its publication step are this repo\'s own sync closure and sync tools'],
  // Fleet coordination rule 8 names it as the no-push way to get a full verdict for a merge candidate
  // and says in its own text that it is this repo's own gate (a consumer pushes the candidate instead).
  ['scripts/prepush-check.mjs', 'source-repo-gated: this repo\'s own pre-push sandbox runner, not part of the consumer bundle'],
]);

/**
 * Narrower than SOURCE_REPO_ONLY: an entry here is exempt ONLY inside the listed skill files,
 * each of which must itself carry a "Source-repo-gated" line (asserted below). A command named
 * anywhere else is still held to the "bundle ships it" rule, so the exemption cannot silently
 * widen to a skill that does not tell its reader to skip it in a consumer.
 */
const GATED_ONLY_IN = new Map([
  ['scripts/ship-train.mjs', ['skills/ship/SKILL.md', 'skills/ship/references/train-mode.md']],
  ['scripts/prepush-check.mjs', ['skills/fleet/references/coordination.md']],
]);

describe('skill commands survive the consumer-repo relocation', () => {
  const files = markdownFiles(SKILLS_DIR);

  test('precondition: the authoritative skills tree has markdown to scan', () => {
    assert.ok(files.length > 5, `expected many skill markdown files, found ${files.length}`);
  });

  test('a script exempt only inside gated skill files really is gated there', () => {
    for (const [script, gatedFiles] of GATED_ONLY_IN) {
      assert.ok(SOURCE_REPO_ONLY.has(script), `${script} must also be in SOURCE_REPO_ONLY`);
      for (const rel of gatedFiles) {
        const text = fs.readFileSync(path.join(SKILLS_DIR, '..', rel), 'utf8');
        assert.match(text, /Source-repo-gated/, `${rel} names ${script} but never says it is source-repo-gated`);
        assert.ok(text.includes(script), `${rel} is listed as gating ${script} but never names it (stale entry)`);
      }
    }
  });

  test('no skill references a bundle module by specifier — only as `node scripts/<path>`', () => {
    const offenders = [];
    for (const file of files) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const m = line.match(UNREWRITABLE_SPECIFIER);
        if (m) offenders.push(`${file}:${i + 1} — ${m[0]}`);
      });
    }
    assert.deepEqual(
      offenders, [],
      'A skill imports a bundle module by path. The consumer sync only rewrites the '
      + '`node scripts/<path>` command form, so this specifier ships unchanged and resolves '
      + 'to nothing in a consumer repo, where the bundle lives under scripts/.claude-skills/. '
      + 'Give the module a CLI entry point and invoke it as `node scripts/<path> <args>`.\n  '
      + offenders.join('\n  '),
    );
  });

  test('every `node scripts/…` command in a skill names a file the bundle SHIPS', () => {
    // A rewritable command form is necessary but not sufficient. The rewriter
    // maps the tail verbatim, so the file has to (a) exist here and (b) be in
    // the sync set — otherwise the consumer gets a correctly-rewritten command
    // pointing at a file that was never delivered. Measured 2026-08-08:
    // `scripts/lib/audit/detector.mjs` was in NO consumer, because nothing
    // imports it (convergence.mjs takes its RESULT as a parameter), so the
    // import walker never reached it — while /audit-code Step 5.0b told every
    // consumer to run it.
    const shipped = new Set(getSyncInventoryForRepo(CONSUMER_REPOS[0].alias).files
      .map(f => f.replace(/\\/g, '/')));
    const missing = [];
    const unshipped = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const m of content.matchAll(COMMAND_REGEX)) {
        const tail = m[1];
        // Placeholders (`<name>`, `$VAR`) are prose, not paths.
        if (/[<>$*]/.test(tail)) continue;
        // A `scripts/.claude-skills/…` tail is the CONSUMER-layout form shown
        // deliberately (the rewriter no-ops on it); that path exists there, not
        // here, so its absence in this repo is correct.
        if (tail.startsWith('.claude-skills/')) continue;
        const sourceRel = `scripts/${tail}`;
        if (SOURCE_REPO_ONLY.has(sourceRel)) {
          const only = GATED_ONLY_IN.get(sourceRel);
          if (!only || only.some((g) => file.replace(/\\/g, '/').endsWith(g))) continue;
        }
        if (!fs.existsSync(sourceRel)) missing.push(`${file} — node ${sourceRel}`);
        else if (!shipped.has(sourceRel)) unshipped.push(`${file} — node ${sourceRel}`);
      }
    }
    assert.deepEqual(missing, [], `Skill commands name non-existent scripts:\n  ${missing.join('\n  ')}`);
    assert.deepEqual(
      unshipped, [],
      'A skill tells the operator to run a script the consumer bundle does not ship. Add it to '
      + 'CORE_ENTRY in scripts/sync-to-repos.mjs (and the lock-step copy in '
      + 'scripts/lib/sync-inventory.mjs) — or, if it is genuinely source-repo only, to '
      + `SOURCE_REPO_ONLY in this test with a reason:\n  ${unshipped.join('\n  ')}`,
    );
  });

  // A guard that has never fired is not known to work.
  test('the guard fires on the exact original broken snippet', () => {
    const broken = 'node -e "import(\'./scripts/lib/plan-paths.mjs\').then(async m=>{';
    assert.match(broken, UNREWRITABLE_SPECIFIER);
    const heredocImport = "import { writeLedgerEntry } from '../../scripts/shared.mjs';";
    assert.match(heredocImport, UNREWRITABLE_SPECIFIER, 'the heredoc-helper variant is the same defect');
  });

  test('the guard does NOT fire on the rewritable command form or on node builtins', () => {
    assert.doesNotMatch('node scripts/lib/plan-paths.mjs docs/plans/my-plan.md', UNREWRITABLE_SPECIFIER);
    assert.doesNotMatch("const fs = require('fs');", UNREWRITABLE_SPECIFIER);
    assert.doesNotMatch("const fs = await import('node:fs');", UNREWRITABLE_SPECIFIER);
    // A consumer's OWN script is not ours to rewrite and not our defect.
    assert.doesNotMatch("import x from './src/app.mjs';", UNREWRITABLE_SPECIFIER);
  });
});
