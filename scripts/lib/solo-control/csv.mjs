/**
 * @fileoverview RFC 4180 CSV for the blind-adjudication sheets. Extracted from
 * scripts/solo-control-audit.mjs (an over-1000-line file that may not grow).
 *
 * The sheet is WRITTEN with `csvField` (quotes a field containing `"`, `,` or a
 * line break, doubling any `"`), so the reader must be its exact inverse. The
 * parsers that preceded this one toggled a quote flag and DROPPED every `"`
 * (`a "b" c` read back as `a b c`, `x,""` lost its empty quoted field's escape)
 * and split records on newlines before parsing, so a finding whose `detail`
 * held a line break — which `csvField` happily quotes — was torn into two
 * records. A judge that grades the altered text and a scorer that joins on
 * the torn rows both read corrupted data as the experiment's evidence.
 *
 * @module scripts/lib/solo-control/csv
 */

/** One field → its CSV spelling. `\r` is quoted too: an unquoted CR would be read back as a record break. */
export function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One record → one CSV line (no trailing newline). */
export const csvLine = (cells) => cells.map(csvField).join(',');

/**
 * Parse a whole CSV document into records of fields. Quoted fields may contain
 * `,`, `"` (as `""`) and line breaks. Blank lines between records are skipped,
 * as the writers' trailing `\n` and a hand-edited sheet's stray empty lines
 * are not records. An unterminated quote throws: a sheet the parser cannot
 * close is corrupt, and guessing where the field ended is how a torn row
 * reads as a valid one.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const records = [];
  let rec = [];
  let cur = '';
  let inQuotes = false;
  let touched = false; // anything (even an empty quoted field) seen on this record
  const endField = () => { rec.push(cur); cur = ''; };
  const endRecord = () => {
    endField();
    if (touched || rec.length > 1 || rec[0] !== '') records.push(rec);
    rec = []; touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else {
          inQuotes = false;
          const next = text[i + 1];
          // a closed quote must end the field: `"a"junk` is not "ajunk", it is a corrupt cell
          if (next !== undefined && next !== ',' && next !== String.fromCharCode(10) && next !== String.fromCharCode(13)) throw new Error(`parseCsv: text after a closing quote (${JSON.stringify(next)}) — the sheet is corrupt`);
        }
      } else cur += ch;
      continue;
    }
    if (ch === '"') {
      // RFC 4180: a quote may only OPEN a field. One inside an unquoted field is a corrupt cell, not a literal.
      if (cur !== '') throw new Error('parseCsv: a quote inside an unquoted field — the sheet is corrupt');
      inQuotes = true; touched = true;
    }
    else if (ch === ',') { touched = true; endField(); }
    else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRecord(); }
    else if (ch === '\n') endRecord();
    else cur += ch;
  }
  if (inQuotes) throw new Error('parseCsv: unterminated quoted field — the sheet is corrupt');
  if (cur !== '' || rec.length > 0 || touched) endRecord();
  return records;
}
