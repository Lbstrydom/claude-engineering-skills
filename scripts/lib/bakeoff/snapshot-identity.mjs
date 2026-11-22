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

const OID = /^[0-9a-f]{40,64}$/;

/**
 * PURE. The identity recorded by the newest round that carries one.
 * @param {object|null|undefined} transcript parsed transcript JSON
 * @returns {{auditedSha: string|null, auditedTree: string|null, source: 'snapshot'|'absent'}}
 */
export function identityFromTranscript(transcript) {
  const rounds = Array.isArray(transcript?.rounds) ? transcript.rounds : [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    const sha = OID.test(rounds[i]?._auditedSha ?? '') ? rounds[i]._auditedSha : null;
    const tree = OID.test(rounds[i]?._auditedTree ?? '') ? rounds[i]._auditedTree : null;
    if (sha || tree) return { auditedSha: sha, auditedTree: tree, source: 'snapshot' };
  }
  return { auditedSha: null, auditedTree: null, source: 'absent' };
}

/**
 * Read a snapshot's identity from its transcript file. Never throws: an unreadable or malformed file is
 * `absent`, which the caller records as null.
 * @param {string} transcriptPath
 */
export function readSnapshotIdentity(transcriptPath) {
  try { return identityFromTranscript(JSON.parse(fs.readFileSync(transcriptPath, 'utf8'))); }
  catch { return { auditedSha: null, auditedTree: null, source: 'absent' }; }
}
