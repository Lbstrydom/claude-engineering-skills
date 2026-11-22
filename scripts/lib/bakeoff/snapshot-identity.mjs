/**
 * @fileoverview The audited identity of a bake-off SNAPSHOT (docs/plans/own-model-full-capture.md, P0).
 *
 * A bake-off arm reviews the transcript of an audit that ran on a specific tree. The collector used to
 * stamp the arm's run with `captureTargetIdentity(process.cwd())`, i.e. whatever the collecting checkout
 * happened to be at collection time, which is a different tree whenever the collector runs after the
 * audited work moved on. The snapshot itself carries the truth: every round in the transcript records
 * `_auditedTree` / `_auditedSha` (stamped by the audit that produced it). This module reads it.
 *
 * No snapshot identity means NULL, never the working tree: a plausible wrong tree reads as verified.
 *
 * @module scripts/lib/bakeoff/snapshot-identity
 */
import fs from 'node:fs';

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * PURE. The identity recorded by the NEWEST round. An older round's identity is never borrowed: the arm reviews
 * the transcript as of its last round, and a tree from before that round's edits is a plausible wrong answer.
 * @param {object|null|undefined} transcript parsed transcript JSON
 * @returns {{auditedSha: string|null, auditedTree: string|null, source: 'snapshot'|'absent'}}
 */
export function identityFromTranscript(transcript) {
  const rounds = Array.isArray(transcript?.rounds) ? transcript.rounds : [];
  const last = rounds[rounds.length - 1];
  const sha = OID.test(last?._auditedSha ?? '') ? last._auditedSha : null;
  const tree = OID.test(last?._auditedTree ?? '') ? last._auditedTree : null;
  return sha || tree ? { auditedSha: sha, auditedTree: tree, source: 'snapshot' } : { auditedSha: null, auditedTree: null, source: 'absent' };
}

/**
 * Read a snapshot's identity from its transcript file. Never throws. A file that cannot be read or parsed is
 * `unreadable` (with the reason), a different state from a valid legacy transcript that simply carries no identity
 * (`absent`); the caller records null for both but says which.
 * @param {string} transcriptPath
 * @returns {{auditedSha: string|null, auditedTree: string|null, source: 'snapshot'|'absent'|'unreadable', error?: string}}
 */
export function readSnapshotIdentity(transcriptPath) {
  try { return identityFromTranscript(JSON.parse(fs.readFileSync(transcriptPath, 'utf8'))); }
  catch (err) { return { auditedSha: null, auditedTree: null, source: 'unreadable', error: String(err?.message ?? err).slice(0, 200) }; }
}
