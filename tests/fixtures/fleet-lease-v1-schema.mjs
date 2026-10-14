/**
 * @fileoverview The lease schema EXACTLY as shipped in #243 (`126efc14`): what an OLDER checkout sharing
 * `~/.claude-fleet/lease.json` parses with. Frozen on purpose - never edit it to match the live schema. Every lease
 * the current code writes must still parse here (plan docs/plans/fleet-lease-turns-and-journal.md D1), or an older
 * checkout would call the shared file corrupt and its `release --force` would wipe it.
 */
import { z } from 'zod';

const LEASE_SCHEMA_VERSION = 1;
const KINDS = Object.freeze(['gate', 'test', 'timing', 'maintenance']);
const WINDOW_KINDS = Object.freeze(['quiet', 'ci']);
const EVENT_KINDS = Object.freeze(['forced-release', 'taken-over', 'corrupt-recovered', 'window-cleared']);
const LIMITS = Object.freeze({ noteMax: 200 });

const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
const note = z.string().max(LIMITS.noteMax).regex(NO_CONTROL, 'must not contain control characters');
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'must be an ISO UTC time ending in Z')
  .refine((s) => Number.isFinite(Date.parse(s)), 'must be a real time');
const hex = (n) => z.string().regex(new RegExp(`^[0-9a-f]{${n}}$`), `must be ${n} lowercase hex characters`);
const name = z.string().min(1).max(200).regex(NO_CONTROL, 'must not contain control characters');
/** A holder or repo label: at most 80, so `holder@repo` (161) always fits an event's 200-character `by`. */
const label = z.string().min(1).max(80).regex(NO_CONTROL, 'must not contain control characters');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

// `.passthrough()` everywhere: an additive field from a newer checkout must not make this one call the file corrupt.
const HeavySchema = z.object({
  holder: label, repoKey: hex(12), repo: label, kind: z.enum(KINDS), note: note.optional(),
  scope: name, pid: z.number().int().positive().optional(), token: hex(16), startedAt: iso, expiresAt: iso,
}).passthrough().refine((h) => Date.parse(h.startedAt) <= Date.parse(h.expiresAt), { message: 'startedAt is after expiresAt' });
const WindowSchema = z.object({
  id: z.string().regex(/^w-\d{14}-[0-9a-f]{4}$/), repoKey: hex(12), repo: label, kind: z.enum(WINDOW_KINDS),
  from: iso, until: iso, note: note.optional(),
}).passthrough().refine((w) => Date.parse(w.from) < Date.parse(w.until), { message: 'from is not before until' });
const PeakSchema = z.object({ from: hhmm, to: hhmm }).passthrough();
const EventSchema = z.object({ at: iso, kind: z.enum(EVENT_KINDS), by: name, reason: note }).passthrough();
export const LeaseSchemaV1 = z.object({
  schemaVersion: z.literal(LEASE_SCHEMA_VERSION),
  heavy: HeavySchema.nullable(), windows: z.array(WindowSchema), peakHours: z.array(PeakSchema), events: z.array(EventSchema),
}).passthrough();

