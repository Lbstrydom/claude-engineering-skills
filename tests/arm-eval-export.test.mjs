/**
 * Tier-1 tests for the committed session archive exporter. Pure functions —
 * no DB, no disk (buildSessionMarkdown + filenameFor are the seams).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionMarkdown, filenameFor } from '../scripts/lib/arm-eval/export.mjs';

const SESSION = {
  session_id: 'fe09b23d-42d7-4238-b28e-e6a18e8063fc',
  experiment_type: 'plan-authoring', phase: 'prospective',
  task_id: 'task-dad0c6fd', task_text: 'Add a --dry-run flag',
  seed: 10, config_version: '1', rubric_version: '1',
  repo_id: 'r-1', created_at: '2026-07-02T05:39:07.000Z',
};
const RUNS = [
  { run_id: 'r-gpt', arm: 'GPT', resolved_model: { models: ['latest-gpt'] }, output_hash: 'h1', output_ref: 'PLAN FROM GPT', producer_conformant: true },
  { run_id: 'r-glm', arm: 'OSS-GLM', resolved_model: { models: ['z-ai/glm-5.2'] }, output_hash: 'h2', output_ref: 'PLAN FROM GLM', producer_conformant: true },
];
const JUDGMENTS = [
  { run_id: 'r-gpt', judge_pass: 1, presentation_order: 2, scores: { correctness: 4 } },
  { run_id: 'r-glm', judge_pass: 1, presentation_order: 1, scores: { correctness: 5 } },
];

describe('filenameFor', () => {
  it('encodes UTC timestamp + experiment + phase + task-id + sid8 (chronological sort)', () => {
    assert.equal(
      filenameFor(SESSION),
      '20260702-053907Z__plan-authoring__prospective__task-dad0c6fd__fe09b23d.md',
    );
  });
});

describe('buildSessionMarkdown — blinding rule', () => {
  it('prospective + NO ranking → BLINDED: labels only, no arm names / models / scores', () => {
    const md = buildSessionMarkdown({ session: SESSION, runs: RUNS, judgments: JUDGMENTS, rankings: [] });
    assert.match(md, /BLINDED/);
    assert.match(md, /### output-1/);
    assert.match(md, /### output-2/);
    assert.match(md, /PLAN FROM GPT/);            // output text IS present
    assert.doesNotMatch(md, /OSS-GLM/, 'arm identity withheld');
    assert.doesNotMatch(md, /Arm GPT/, 'arm identity withheld');
    assert.doesNotMatch(md, /glm-5\.2/, 'model names withheld (would reveal the arm)');
    assert.doesNotMatch(md, /Judge scores/, 'scores withheld (rank inference)');
  });
  it('prospective + ranking recorded → FULL: attribution + judge scores + ranking', () => {
    const rankings = [{ ranked_labels: ['output-1', 'output-2'], reviewer: 'louis', created_at: '2026-07-02T08:00:00Z' }];
    const md = buildSessionMarkdown({ session: SESSION, runs: RUNS, judgments: JUDGMENTS, rankings });
    assert.match(md, /FULL/);
    assert.match(md, /### Arm GPT/);
    assert.match(md, /### Arm OSS-GLM/);
    assert.match(md, /Judge scores/);
    assert.match(md, /output-1 > output-2/);
    assert.match(md, /louis/);
  });
  it('calibration → FULL immediately (never part of the anchor pool)', () => {
    const md = buildSessionMarkdown({ session: { ...SESSION, phase: 'calibration' }, runs: RUNS, judgments: JUDGMENTS, rankings: [] });
    assert.match(md, /FULL/);
    assert.match(md, /### Arm OSS-GLM/);
  });
  it('blinded mode withholds an UNJUDGED run entirely (no label → position would reveal the arm)', () => {
    const md = buildSessionMarkdown({ session: SESSION, runs: RUNS, judgments: [JUDGMENTS[1]], rankings: [] });
    assert.match(md, /### output-1/);
    assert.doesNotMatch(md, /PLAN FROM GPT/, 'unlabeled output must not appear in arm order');
  });
  it('task text is included; pre-migration sessions degrade honestly', () => {
    const md = buildSessionMarkdown({ session: { ...SESSION, task_text: null }, runs: RUNS, judgments: JUDGMENTS, rankings: [] });
    assert.match(md, /task text not recorded/);
  });
});
