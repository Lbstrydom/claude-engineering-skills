/**
 * @fileoverview The `openai-audit.mjs` usage text. Lives here so the entry point (an oversized file that may not
 * grow) does not carry thirteen lines of help, and so the round-cap flags have one place to be documented.
 *
 * @module scripts/lib/audit/openai-audit-usage
 */
import { AUDIT_ROUND_CAPS as CAPS } from './round-cap.mjs';

export const OPENAI_AUDIT_USAGE = [
  'Usage: node scripts/openai-audit.mjs <plan|code> <plan-file> [--json] [--out <file>] [--history <file>] [--passes <list>] [--files <list>]',
  '       node scripts/openai-audit.mjs code <plan-file> [--scope diff|plan|full] [--base <git-ref>]',
  '         --scope diff (default): auto-scope to git-changed files (dirty-aware base: HEAD if tree dirty, else HEAD~1; --base overrides)',
  '         --scope plan          : audit all plan-referenced files',
  '         --scope full          : audit entire repo (slowest, most comprehensive)',
  '       node scripts/openai-audit.mjs code <plan-file> --round 2 --ledger <ledger.json> --diff <diff.patch> --changed <file1,file2>',
  `         --round <n>           : whole positive number. Round cap (enforced): plan ${CAPS.plan.soft} / ${CAPS.plan.absolute}, code ${CAPS.code.soft} / ${CAPS.code.absolute} (soft / absolute).`,
  '                                 Past the soft cap a round exits 4 with the structural-or-stop card until --past-cap is given.',
  '         --past-cap "<reason>" : why a round past the soft cap will converge (15+ chars); needs the card for that round first.',
  '       node scripts/openai-audit.mjs rebuttal <plan-file> <rebuttal-file> [--json] [--out <file>]',
  '         --allow-infra-scope   : opt-in — audit this tool\'s OWN infra files (schemas.mjs, ledger.mjs, …)',
  '                                 as subject files. Only for META plans whose deliverable IS a change',
  '                                 to the audit tool itself; leave off for normal (consumer-code) audits.',
].join('\n');
