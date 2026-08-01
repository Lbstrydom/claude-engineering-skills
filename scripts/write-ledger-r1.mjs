import { writeLedgerEntry, generateTopicId, populateFindingMetadata } from './shared.mjs';
import { scratchPath } from './lib/temp-paths.mjs';

const SID = 'audit-1776354886';
// Repo-local: the ledger is written for a LATER reader, and a literal '/tmp/'
// names a different directory under git-bash, Node-on-Windows and Linux.
const ledgerPath = scratchPath('ledger', `${SID}-ledger.json`);

function addEntry(finding, outcome, remState, severity, origSeverity, ruling, rationale, resolvedRound) {
  populateFindingMetadata(finding, finding._pass);
  writeLedgerEntry(ledgerPath, {
    topicId: generateTopicId(finding),
    semanticHash: finding._hash,
    adjudicationOutcome: outcome,
    remediationState: remState,
    severity,
    originalSeverity: origSeverity,
    category: finding.category,
    section: finding.section,
    detailSnapshot: finding.detail || finding.category,
    affectedFiles: finding.files || [],
    affectedPrinciples: [finding.principle],
    ruling,
    rulingRationale: rationale,
    resolvedRound,
    pass: finding._pass
  });
}

addEntry({ section: 'audit-tooling', category: 'Context artifact - cross-repo scope error H', principle: 'scope', _pass: 'sustainability', _hash: 'h1-context-artifact-001', files: [] }, 'dismissed', 'pending', 'HIGH', 'HIGH', 'overrule', 'Cross-repo audit targeted claude-audit-loop diff, not ai-organiser. Finding cites out-of-scope files.', 1);
addEntry({ section: 'audit-tooling', category: 'Context artifact - cross-repo scope MEDIUM', principle: 'scope', _pass: 'sustainability', _hash: 'm1-context-artifact-001', files: [] }, 'dismissed', 'pending', 'MEDIUM', 'MEDIUM', 'overrule', 'Same cross-repo scope error as H1.', 1);
addEntry({ section: 'audit-tooling', category: 'Context artifact - cross-repo scope LOW', principle: 'scope', _pass: 'sustainability', _hash: 'l1-context-artifact-001', files: [] }, 'dismissed', 'pending', 'LOW', 'LOW', 'overrule', 'Same cross-repo scope error as H1.', 1);
addEntry({ section: 'src/utils/htmlToMarkdown.ts', category: 'Pre-existing architecture concern in htmlToMarkdown', principle: 'SRP', _pass: 'backend', _hash: 'h2-htmltomarkdown-arch-001', files: ['src/utils/htmlToMarkdown.ts'], detail: 'Pre-existing design debt not introduced by this PR' }, 'dismissed', 'pending', 'HIGH', 'HIGH', 'defer', 'Pre-existing concern not introduced by this PR. Tracked as future debt.', 1);
addEntry({ section: 'src/utils/htmlToMarkdown.ts', category: 'Entity sanitization edge-case risk for non-Latin content', principle: 'robustness', _pass: 'backend', _hash: 'm2-entity-sanitization-001', files: ['src/utils/htmlToMarkdown.ts'], detail: 'Entity-only line stripping mostly safe but has non-Latin edge cases' }, 'severity_adjusted', 'pending', 'LOW', 'MEDIUM', 'defer', 'GPT compromise: downgraded MEDIUM to LOW. Implementation is general. Edge-case tests recommended but not blocking.', 1);
addEntry({ section: 'src/utils/htmlToMarkdown.ts', category: 'MIN_CONTENT_LINE_CHARS=60 calibrated heuristic', principle: 'robustness', _pass: 'backend', _hash: 'm3-short-line-heuristic-001', files: ['src/utils/htmlToMarkdown.ts'], detail: '60-char threshold named constant with yield-ratio fallback safety net' }, 'severity_adjusted', 'pending', 'LOW', 'MEDIUM', 'defer', 'GPT compromise: downgraded MEDIUM to LOW. Named constant with yield fallback preventing silent loss.', 1);
addEntry({ section: 'src/services/newsletter/newsletterService.ts', category: 'Pre-existing design concern in newsletterService', principle: 'SRP', _pass: 'backend', _hash: 'm4-newsletter-service-001', files: ['src/services/newsletter/newsletterService.ts'], detail: 'Pre-existing design debt not introduced by this PR' }, 'dismissed', 'pending', 'MEDIUM', 'MEDIUM', 'defer', 'Out-of-scope: pre-existing design concern.', 1);
addEntry({ section: 'src/services/newsletter/newsletterService.ts', category: 'Unhandled promise rejection in retention pruning', principle: 'error-handling', _pass: 'backend', _hash: 'm5-pruning-promise-001', files: ['src/services/newsletter/newsletterService.ts'], detail: 'pruneOldNewsletters fire-and-forget missing catch handler' }, 'accepted', 'fixed', 'MEDIUM', 'MEDIUM', 'accept', 'Fixed: void promise.catch(e => logger.warn(...)) pattern.', 1);
addEntry({ section: 'src/commands/digitisationCommands.ts', category: 'Pre-existing UX concern in digitisationCommands', principle: 'UX', _pass: 'frontend', _hash: 'm6-digitisation-ux-001', files: ['src/commands/digitisationCommands.ts'], detail: 'Pre-existing concern not introduced by this PR' }, 'dismissed', 'pending', 'MEDIUM', 'MEDIUM', 'defer', 'Out-of-scope: pre-existing concern.', 1);
addEntry({ section: 'src/core/settings.ts', category: 'Pre-existing settings concern', principle: 'settings', _pass: 'backend', _hash: 'm7-settings-001', files: ['src/core/settings.ts'], detail: 'Pre-existing concern not introduced by this PR' }, 'dismissed', 'pending', 'MEDIUM', 'MEDIUM', 'defer', 'Out-of-scope: pre-existing concern.', 1);

console.log('Ledger written: 10 entries');
