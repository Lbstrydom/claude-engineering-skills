/**
 * @fileoverview The zod fields behind structured finding lines (docs/plans/structured-finding-lines.md), kept out of
 * `schemas.mjs` (an oversized file that may not grow).
 *
 * `lineQuote` — model-emitted, optional on the producer: ONE verbatim source line (up to 3 consecutive lines joined by
 * \n) the finding is about, copied exactly as it appears in the file after the change. Code resolves it to
 * `lineStart`/`lineEnd` (audit/finding-lines.mjs); the model never emits a line number, because the code it is shown
 * carries no line gutter. Nullable AND optional: a provider that forces every key into `required` (OpenAI strict) can
 * answer `null`, and every non-LLM constructor and pre-existing row stays valid. `lineStart`/`lineEnd` are DERIVED, so
 * they exist on the persisted shape only. None of the three enter `semanticId`/`generateTopicId`.
 *
 * @module scripts/lib/finding-line-fields
 */
import { z } from 'zod';

export const LineQuoteField = z.string().max(400).nullable().optional().describe(
  'OPTIONAL. The exact source line (up to 3 consecutive lines) this finding is about, copied verbatim from the file '
  + 'after the change, including its leading indentation. No diff markers, no line numbers. null if the finding is not '
  + 'about specific code or the relevant line is longer than 400 characters.',
);

/** Derived by the resolver, never model-emitted. */
export const LineBoundField = z.number().int().positive().nullable().optional();
