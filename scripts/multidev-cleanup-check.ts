// Checks for selectStaleMultidevs() in lib/multidevCleanup.ts — the fast-track/scheduled
// staging cleanup step (lib/staging.ts + lib/drupal.ts) uses this to decide which
// mu-YYMMDD multidevs to reap before creating today's. No test runner:
// `npm run check:multidev-cleanup` (Node strips the types).
//
// The regression this guards: the old findByPrefix() returned only the FIRST env
// matching mu-YYMMDD in Pantheon's list order. Once two or more stale envs existed
// (a daily fast-track site accumulates one per day), the arbitrary "loser" survived —
// confirmed live on bowside-capital, which had mu-260820, mu-260917 AND mu-260918 all
// alive at once, and one run deleted an 11-month-old mu-241026 instead of last week's.
// Worse: nothing checked whether the reaped env still had a pending live-deploy
// booking against it in mu-deployment's scheduled_deployments (source = that multidev),
// so the deploy failed later with "Multidev does not exist on site X". See memory
// bug_upstream_scan_wipes_scheduled_multidev — confirmed daily failures 2026-09-22
// through 2026-09-28 on claybuck, spire-ri, bowside-capital, lgla-merge,
// apexorderpickup, cccu-globaled.
//
// selectStaleMultidevs() only covers the *selection* half (fix item 1: sweep ALL stale
// envs, not just one). The *cancellation* half (fix item 2: cancel any pending booking
// for each env before deleting it) is lib/schedule.ts's cancelStaleBooking(), called
// immediately before every `terminus multidev:delete` in staging.ts / drupal.ts — it
// isn't asserted here because it talks to the shared mu-deployment HTTP API, and these
// check scripts stay pure-function-only (no mocked fetch, no parallel test stack).
import { selectStaleMultidevs } from '../lib/multidevCleanup.ts'

let pass = 0, fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n         got ${a}\n         want ${e}`) }
}

console.log('\nselectStaleMultidevs — the regression (findByPrefix returned only one match)')
check('single stale env, unrelated to target',
  selectStaleMultidevs(['mu-260917', 'mu-260918'], 'mu-260918'),
  ['mu-260917'])
check('THREE stale envs stacked — all must be selected, not just the first',
  selectStaleMultidevs(['mu-260820', 'mu-260917', 'mu-260918', 'mu-260919'], 'mu-260919'),
  ['mu-260820', 'mu-260917', 'mu-260918'])
// The live bowside-capital case: an 11-month-old env sorted first in Pantheon's list
// order. It must be selected exactly like any other stale match — no special-casing by
// age or position — so the fix is "select everything", not "pick a different one".
check('an old (11-month) env sorts first but is not skipped',
  selectStaleMultidevs(['mu-241026', 'mu-260927'], 'mu-260928'),
  ['mu-241026', 'mu-260927'])

console.log('\nselectStaleMultidevs — must-not-sweep cases')
check('no stale envs at all',
  selectStaleMultidevs(['mu-260928'], 'mu-260928'),
  [])
check('the target itself is excluded even when it is in the list',
  selectStaleMultidevs(['mu-260927', 'mu-260928'], 'mu-260928'),
  ['mu-260927'])
// Non-conforming / hand-staged env names must never be swept, target standard or not —
// this is what keeps genuinely manual production envs (e.g. spire-ri's ori-theme) safe.
check('non-conforming names are left alone (dev, test, live)',
  selectStaleMultidevs(['dev', 'test', 'live', 'mu-260918'], 'mu-260919'),
  ['mu-260918'])
check('non-conforming hand-staged name (mu-241025a) is left alone',
  selectStaleMultidevs(['mu-241025a', 'mu-260918'], 'mu-260919'),
  ['mu-260918'])
// A non-standard target (manual run, custom name) must never trigger a sweep at all —
// mirrors the pre-fix isStandardName guard.
check('non-standard target name → nothing is swept',
  selectStaleMultidevs(['mu-260917', 'mu-260918'], 'my-custom-env'),
  [])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
