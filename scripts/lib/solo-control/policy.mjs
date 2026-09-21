/**
 * @fileoverview The ONE pre-egress boundary experiment 5's corpus/recipient
 * design depends on. A repo absent from the policy file, or a recipient not
 * listed for it, is REFUSED — never routed around, never a silent skip. This
 * is deliberately the single source every entry path (`--corpus`, explicit
 * `--commits`, `discoverCommits`) is required to consult BEFORE any provider
 * client is constructed; see docs/plans/reviewer-cost-value-experiment.md §2
 * ("Egress authorization at the ONE pre-egress boundary", INC-001).
 *
 * @module scripts/lib/solo-control/policy
 */

import fs from 'node:fs';
import { RECIPIENTS, classifyRecipient } from './recipient.mjs';

/**
 * Load and validate `recipient-policy.json`. Throws on a malformed file
 * (missing `repos`, a repo with a non-array or empty value, or an unknown
 * recipient name) rather than silently coercing — a policy file this
 * experiment's egress guarantee rests on must fail loudly, not degrade.
 *
 * @param {string} filePath
 * @returns {{version: number, repos: Record<string, string[]>}}
 */
export function loadRecipientPolicy(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`loadRecipientPolicy: no policy file at ${filePath} — refusing rather than treating "no policy" as "no restriction"`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw || typeof raw !== 'object' || !raw.repos || typeof raw.repos !== 'object') {
    throw new Error(`loadRecipientPolicy: ${filePath} is missing a "repos" object`);
  }
  for (const [repoIdentity, recipients] of Object.entries(raw.repos)) {
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new Error(`loadRecipientPolicy: ${repoIdentity} has a missing or empty recipient list — absence must mean REFUSE via a missing key, never an empty array masquerading as "no recipients allowed yet"`);
    }
    for (const r of recipients) {
      if (!RECIPIENTS.includes(r)) throw new Error(`loadRecipientPolicy: ${repoIdentity} names unknown recipient "${r}" — known: ${RECIPIENTS.join(', ')}`);
    }
  }
  return raw;
}

/**
 * Fail-closed check: does `policy` permit `recipient` to receive content
 * from `repoIdentity`? Throws (never returns false) — every call site is a
 * point where a diff is about to leave the machine, so the caller should not
 * have to remember to check a boolean; forgetting to call this at all is the
 * only way to bypass it, which is the correct failure mode to eliminate via
 * code review, not via a returned value that can be ignored.
 *
 * @param {{repos: Record<string, string[]>}} policy
 * @param {string} repoIdentity
 * @param {string} recipient
 */
export function assertRecipientAllowed(policy, repoIdentity, recipient) {
  const allowed = policy.repos[repoIdentity];
  if (!allowed) {
    throw new Error(`[recipient-policy] REFUSED: "${repoIdentity}" has no entry in the recipient policy — absence means refuse, not "no restriction"`);
  }
  if (!allowed.includes(recipient)) {
    throw new Error(`[recipient-policy] REFUSED: "${repoIdentity}" does not permit recipient "${recipient}" (permits: ${allowed.join(', ')})`);
  }
}

/**
 * The gate every call site MUST run before constructing any provider
 * client — classify the resolved model, then check it against policy for
 * this repo. Pure and I/O-free, so a caller that calls this FIRST and only
 * constructs a client if it does not throw can never construct one for a
 * refused (repo, recipient) pair — the ordering contract is enforced by
 * this function doing no I/O of its own, not by caller discipline alone.
 *
 * @param {{model: string, repoIdentity: string, policy: {repos: Record<string,string[]>}}} args
 * @returns {string} the classified recipient, for logging/ledger use
 */
export function resolveAndAuthorize({ model, repoIdentity, policy }) {
  const recipient = classifyRecipient(model);
  assertRecipientAllowed(policy, repoIdentity, recipient);
  return recipient;
}

/**
 * Cross-check a loaded corpus's per-entry `allowedTransports` against the
 * policy that is supposed to bound it — every entry's list must be a
 * non-empty SUBSET of what the policy grants that repo. Returns the list of
 * violations (empty = clean) rather than throwing, so a caller building the
 * corpus can report every problem in one pass instead of one-at-a-time.
 *
 * @param {{entries: Array<{id:string, repoIdentity:string, allowedTransports:string[]}>}} corpus
 * @param {{repos: Record<string, string[]>}} policy
 * @returns {Array<{id:string, repoIdentity:string, recipient:string}>}
 */
export function validateCorpusAgainstPolicy(corpus, policy) {
  const problems = [];
  for (const e of corpus.entries) {
    if (!Array.isArray(e.allowedTransports) || e.allowedTransports.length === 0) {
      problems.push({ id: e.id, repoIdentity: e.repoIdentity, recipient: '(none)' });
      continue;
    }
    const permitted = policy.repos[e.repoIdentity] || [];
    for (const r of e.allowedTransports) {
      if (!permitted.includes(r)) problems.push({ id: e.id, repoIdentity: e.repoIdentity, recipient: r });
    }
  }
  return problems;
}
