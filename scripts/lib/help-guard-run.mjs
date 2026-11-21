/**
 * @fileoverview Side-effect entry for `help-guard.mjs`: import this FIRST in a CLI
 * and `--help` prints that CLI's header usage and exits 0 before any other module
 * is evaluated. See `help-guard.mjs`.
 *
 * @module scripts/lib/help-guard-run
 */
import { helpGuardEntry } from './help-guard.mjs';

helpGuardEntry();
