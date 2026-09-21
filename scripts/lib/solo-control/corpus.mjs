/**
 * @fileoverview Loader + schema for experiment 5's pre-registered corpus
 * (docs/experiments/audit-effectiveness/experiment-5-corpus.json). Strict
 * validation on load — a corpus entry with a missing or empty
 * `allowedTransports` must refuse to load at all, not silently become "no
 * restriction" once it reaches the runner.
 *
 * @module scripts/lib/solo-control/corpus
 */

import fs from 'node:fs';
import { z } from 'zod';
import { RECIPIENTS } from './recipient.mjs';
import { validateCorpusAgainstPolicy } from './policy.mjs';

const CorpusEntrySchema = z.object({
  id: z.string(),
  repo: z.string(),
  repoIdentity: z.string(),
  sha: z.string().regex(/^[0-9a-f]{40}$/i, 'sha must be a full 40-char git object id'),
  source: z.enum(['kd', 'draw']),
  stratum: z.object({ size: z.enum(['S', 'M', 'L']), kind: z.string() }),
  allowedTransports: z.array(z.enum(RECIPIENTS)).min(1, 'allowedTransports must be non-empty — absence must be expressed by leaving the repo out of the policy, never by an empty list here'),
}).passthrough(); // kdId/kdSeverity/changedLines/files/subject/date are informational, not load-bearing

export const CorpusSchema = z.object({
  version: z.number().int(),
  entries: z.array(CorpusEntrySchema).min(1),
}).passthrough();

/**
 * Load, schema-validate, and policy-cross-check the corpus. Throws on any
 * schema violation or policy mismatch — this is called once at preflight,
 * before any provider client is constructed, so a bad corpus never reaches
 * a live run.
 *
 * @param {string} corpusPath
 * @param {{repos: Record<string, string[]>}} policy already-loaded recipient policy
 */
export function loadCorpus(corpusPath, policy) {
  if (!fs.existsSync(corpusPath)) throw new Error(`loadCorpus: no corpus file at ${corpusPath}`);
  const raw = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const corpus = CorpusSchema.parse(raw);
  const violations = validateCorpusAgainstPolicy(corpus, policy);
  if (violations.length > 0) {
    const lines = violations.map((v) => `  ${v.id} (${v.repoIdentity}): recipient "${v.recipient}" not permitted by policy`);
    throw new Error(`loadCorpus: ${violations.length} corpus entr${violations.length === 1 ? 'y' : 'ies'} claim(s) a recipient the policy does not grant:\n${lines.join('\n')}`);
  }
  return corpus;
}

/** Ids of every entry a given arm may run on — those whose `allowedTransports`
 * includes the arm's required recipient. Never "route around" a missing
 * recipient; an entry that lacks it simply is not in this set. */
export function entriesEligibleForRecipient(corpus, recipient) {
  return corpus.entries.filter((e) => e.allowedTransports.includes(recipient)).map((e) => e.id);
}
