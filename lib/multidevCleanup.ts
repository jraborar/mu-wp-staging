// Pure selection logic for the fast-track/scheduled multidev cleanup step, shared by
// lib/staging.ts (WP) and lib/drupal.ts (Drupal) — both carried the identical defect
// and get the identical fix. See memory bug_upstream_scan_wipes_scheduled_multidev.
//
// No `@/` imports on purpose: scripts/multidev-cleanup-check.ts loads this file
// directly via a relative path under plain `node` (types stripped, no path-alias
// resolution), the same way scripts/cadence-check.ts loads lib/cadence.ts.
const STANDARD_MU = /^mu-\d{6}$/

// Every existing multidev matching mu-YYMMDD except the job's own target. This used to
// be `findByPrefix()`, which returned only the FIRST match in Pantheon's list order —
// once two or more stale envs existed, whichever one "lost" that arbitrary pick
// survived and piled up (confirmed live: an 11-month-old env got deleted instead of
// last week's, and doomed deploy bookings stacked up against the survivors).
// Non-conforming names (e.g. `mu-241025a`, hand-staged envs) never match and are
// always left untouched.
export function selectStaleMultidevs(currentMultidevs: string[], target: string): string[] {
  if (!STANDARD_MU.test(target)) return []
  return currentMultidevs.filter((m) => m !== target && STANDARD_MU.test(m))
}
