/**
 * @fileoverview Human adjudication worksheet renderer — the shared, PURE
 * markdown emitter behind the `--worksheet` flag of `model-ab-adjudicate` and
 * `final-review-stats`.
 *
 * WHY THIS EXISTS (recurrence guard): operator-facing review queues used to be
 * raw-JSON CLI dumps documented with `<angle-bracket>` placeholder commands —
 * unreadable for a human, and the placeholders parse-error in PowerShell (`<`
 * is reserved). That failed the operator twice (final-review shadow queue,
 * then the model-ab blinded queue), each time patched with a throwaway
 * session-generated worksheet. This module makes the worksheet a first-class,
 * tested output: every command it emits is paste-ready — REAL ids, real
 * fingerprints, no placeholders of any kind.
 *
 * Invariants (tested in tests/adjudication-worksheet.test.mjs):
 *   - output NEVER contains `<`-style placeholder tokens in command lines;
 *   - items are sorted by (primary_file, category) so likely-duplicates sit
 *     adjacent for the human to cluster;
 *   - an empty queue renders an explicit "queue is empty" note, never a blank
 *     file that could read as "nothing to review" by accident;
 *   - the renderer is pure (no I/O, no clock) — callers stamp any timestamp.
 *
 * @module scripts/lib/adjudication-worksheet
 */

/**
 * @typedef {object} WorksheetItem
 * @property {string} runId
 * @property {string} fingerprint
 * @property {string} [severity]
 * @property {string} [stage]      - pipeline stage (model-ab) — NOT an arm identity
 * @property {string} [category]
 * @property {string} [file]       - primary file / section anchor
 * @property {string} [detail]     - snippet shown as the quoted summary
 */

/** One squashed-whitespace, length-capped line. */
function line(s, cap = 220) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
}

/**
 * Render a paste-ready adjudication worksheet.
 *
 * @param {object} args
 * @param {string} args.title - worksheet H1
 * @param {string[]} [args.introLines] - context paragraphs (already-safe text)
 * @param {WorksheetItem[]} args.items
 * @param {(item: WorksheetItem, action: string) => string} args.commandFor -
 *   returns the FULL shell command for ruling `item` with `action`. Must embed
 *   real values (the renderer refuses placeholder-looking output).
 * @param {string[]} args.actions - valid actions, first one is pre-filled in
 *   the per-item block (the human edits the word to disagree)
 * @param {{action: string, canonicalHint: string}|null} [args.duplicateHowTo] -
 *   when the queue supports duplicate-clustering, a how-to block is emitted
 *   (e.g. {action:'duplicate', canonicalHint:'--canonical ROOT_FINGERPRINT'})
 * @param {string} [args.generatedAt] - caller-supplied timestamp (renderer is pure)
 * @returns {string} markdown
 */
export function renderAdjudicationWorksheet({ title, introLines = [], items, commandFor, actions, duplicateHowTo = null, generatedAt = '' }) {
  const md = [];
  md.push(`# ${line(title, 120)}`, '');
  if (generatedAt) md.push(`Generated: ${line(generatedAt, 60)}.`, '');
  md.push(
    `Actions: ${actions.join(' | ')}. Each block below is **paste-ready for PowerShell** (real ids,`,
    'no placeholders) — read the finding, edit the action word if you disagree, paste the command.',
    '',
  );
  for (const l of introLines) md.push(line(l, 400), '');
  if (duplicateHowTo) {
    md.push(
      '## Duplicates (drives the canonical clustering)',
      '',
      'When several findings describe the SAME underlying issue in different words: rule ONE of them',
      `(the root) with a normal action, then rule each other one \`${duplicateHowTo.action}\` and append`,
      `\`${duplicateHowTo.canonicalHint}\` (the root's fingerprint). Items are sorted by file+category so`,
      'likely-duplicates sit next to each other.',
      '',
    );
  }
  if (!items || items.length === 0) {
    md.push('## Queue is EMPTY', '', 'Nothing is pending adjudication right now — nothing was silently omitted.', '');
    return md.join('\n');
  }

  const sorted = [...items].sort((a, b) =>
    (a.file ?? '').localeCompare(b.file ?? '') || (a.category ?? '').localeCompare(b.category ?? '') || (a.fingerprint ?? '').localeCompare(b.fingerprint ?? ''));

  md.push(`## Pending findings (${sorted.length})`, '');
  const defaultAction = actions[0];
  for (const it of sorted) {
    const tags = [it.severity, it.stage].filter(Boolean).join('/');
    md.push(`### \`${it.fingerprint}\`${tags ? ` [${tags}]` : ''} ${line(it.category ?? '', 90)}`);
    if (it.file) md.push(`*${line(it.file, 120)}*`);
    md.push(`> ${line(it.detail, 300)}`, '');
    const cmd = commandFor(it, defaultAction);
    if (/<[A-Za-z_-]+>/.test(cmd)) {
      // Fail loud at render time — a placeholder here defeats the module's entire purpose.
      throw new Error(`adjudication-worksheet: commandFor emitted a placeholder-looking command: ${cmd}`);
    }
    md.push('```powershell', cmd, '```', '');
  }
  return md.join('\n');
}
