// Cadence check for lib/cadence.ts — the ISO-week due-ness / projection math the
// staging scheduler runs on. No test runner: `npm run check:cadence` (Node strips the
// types). Dates are fixed so the assertions never depend on today.
import {
  computeNextOccurrence,
  currentWindowTarget,
  isDueNow,
  manilaDayOfWeek,
} from '../lib/cadence.ts'
import type { StagingSchedule } from '../lib/scheduleStore.ts'

const D = (s: string) => new Date(s)
const dow = (s: string) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][manilaDayOfWeek(D(s))]
console.log('weekday sanity:',
  ['2026-08-03','2026-08-10','2026-08-17','2026-08-20','2026-08-23','2026-08-31','2026-09-07','2026-10-15','2026-08-15']
    .map(d => `${d}=${dow(d + 'T12:00:00+08:00')}`).join(' '))

let pass = 0, fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = actual instanceof Date ? actual.toISOString() : String(actual)
  const e = expected instanceof Date ? expected.toISOString() : String(expected)
  if (a === e) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n         got ${a}\n         want ${e}`) }
}
const s = (o: Partial<StagingSchedule>): StagingSchedule =>
  ({ cadence: 'weekly', active: true, created_at: '2026-01-01T00:00:00Z', ...o }) as StagingSchedule

const weekly  = s({ cadence: 'weekly',  day_of_week: 1 })
const biwk    = s({ cadence: 'biweekly', day_of_week: 1 })

console.log('\nweekly (Mon), anchor = week of Aug 10')
check('Thu Aug 20 → due (run-now, Monday passed)', isDueNow(weekly, '2026-08-10', D('2026-08-20T15:00:00+08:00')), true)
check('anchor is THIS week → not due',             isDueNow(weekly, '2026-08-17', D('2026-08-20T15:00:00+08:00')), false)
check('Mon Aug 17 10:00 → not due yet',            isDueNow(weekly, '2026-08-10', D('2026-08-17T10:00:00+08:00')), false)
check('Mon Aug 17 15:05 → due',                    isDueNow(weekly, '2026-08-10', D('2026-08-17T15:05:00+08:00')), true)
check('already staged this week → not due',        isDueNow(s({ ...weekly, last_staged_at: '2026-08-18T07:00:00Z' }), '2026-08-10', D('2026-08-20T15:00:00+08:00')), false)
check('skip_week = this week → not due',           isDueNow(s({ ...weekly, skip_week: '2026-08-17' }), '2026-08-10', D('2026-08-20T15:00:00+08:00')), false)
check('skip_week = other week → due',              isDueNow(s({ ...weekly, skip_week: '2026-08-24' }), '2026-08-10', D('2026-08-20T15:00:00+08:00')), true)
check('stale anchor (5 weeks) → due this week',    isDueNow(weekly, '2026-07-13', D('2026-08-20T15:00:00+08:00')), true)

console.log('\nbiweekly (Mon), anchor = week of Aug 3 → on-parity weeks Aug 17, Aug 31')
check('Thu Aug 20 (Aug 17 week) → due',            isDueNow(biwk, '2026-08-03', D('2026-08-20T15:00:00+08:00')), true)
check('Thu Aug 27 (off-parity) → NOT due',         isDueNow(biwk, '2026-08-03', D('2026-08-27T15:00:00+08:00')), false)
check('Thu Sep 3 (Aug 31 week) → due',             isDueNow(biwk, '2026-08-03', D('2026-09-03T15:00:00+08:00')), true)
check('anchor week itself → not due',              isDueNow(biwk, '2026-08-03', D('2026-08-07T15:00:00+08:00')), false)
// A stale next_staging_at is no longer a trigger: after downtime the cycle resumes on
// its next on-parity week instead of firing a make-up run the moment we come back.
check('stale next_staging_at, off-parity → no make-up',
  isDueNow(s({ ...biwk, next_staging_at: '2026-08-17T15:00:00+08:00' }), '2026-08-03', D('2026-08-27T09:00:00+08:00')), false)

console.log('\noverrides')
check('override_at passed, off-parity week → due',  isDueNow(s({ ...biwk, override_at: '2026-08-25T09:00:00+08:00' }), '2026-08-03', D('2026-08-25T10:00:00+08:00')), true)
check('override_at in future → not due',            isDueNow(s({ ...biwk, override_at: '2026-08-25T09:00:00+08:00' }), '2026-08-03', D('2026-08-25T08:00:00+08:00')), false)
check('once, datetime passed → due',                isDueNow(s({ cadence: 'once', next_staging_at: '2026-08-20T09:00:00+08:00' }), null, D('2026-08-20T10:00:00+08:00')), true)
check('once, datetime future → not due',            isDueNow(s({ cadence: 'once', next_staging_at: '2026-08-21T09:00:00+08:00' }), null, D('2026-08-20T10:00:00+08:00')), false)
check('inactive → not due',                         isDueNow(s({ ...weekly, active: false }), '2026-08-10', D('2026-08-20T15:00:00+08:00')), false)
check('security-only → not due',                    isDueNow(s({ cadence: 'security-only' }), '2026-08-10', D('2026-08-20T15:00:00+08:00')), false)

console.log('\nSunday cadence (day_of_week = 0) — Sunday closes the ISO week')
const sun = s({ cadence: 'weekly', day_of_week: 0 })
check('Sun Aug 23 16:00 → due',                     isDueNow(sun, '2026-08-10', D('2026-08-23T16:00:00+08:00')), true)
check('Mon Aug 24 → not due (waits for Sunday)',    isDueNow(sun, '2026-08-10', D('2026-08-24T16:00:00+08:00')), false)

console.log('\nmonthly (1st Monday) + custom (every other month, week of the 15th, Wed)')
const monthly = s({ cadence: 'monthly', day_of_week: 1, week_of_month: 1 })
check('Wed Aug 5 (Aug 3 week) → due (run-now)',     isDueNow(monthly, null, D('2026-08-05T15:00:00+08:00')), true)
check('Thu Aug 20 (no occurrence) → not due',       isDueNow(monthly, null, D('2026-08-20T15:00:00+08:00')), false)
const custom = s({ cadence: 'bimonthly-week-of-15', bimonthly_ref_month: 8, bimonthly_day_of_week: 3 })
check('Aug window target = Wed Aug 12 15:00 PHT',   currentWindowTarget(custom, null, D('2026-08-13T09:00:00+08:00')), D('2026-08-12T15:00:00+08:00'))
check('Thu Aug 13 → due (Wed passed)',              isDueNow(custom, null, D('2026-08-13T09:00:00+08:00')), true)
check('Sep (off month) → not due',                  isDueNow(custom, null, D('2026-09-16T09:00:00+08:00')), false)

console.log('\nprojections (computeNextOccurrence)')
check('weekly, anchor Aug 10, after Aug 20',        computeNextOccurrence(weekly, D('2026-08-20T15:00:00+08:00'), '2026-08-10'), D('2026-08-24T15:00:00+08:00'))
check('biweekly, anchor Aug 3, after Aug 20',       computeNextOccurrence(biwk,   D('2026-08-20T15:00:00+08:00'), '2026-08-03'), D('2026-08-31T15:00:00+08:00'))
check('biweekly, after Aug 31 16:00 → Sep 14',      computeNextOccurrence(biwk,   D('2026-08-31T16:00:00+08:00'), '2026-08-03'), D('2026-09-14T15:00:00+08:00'))
check('custom, after Aug 20 → Wed Oct 14',          computeNextOccurrence(custom, D('2026-08-20T15:00:00+08:00'), null),        D('2026-10-14T15:00:00+08:00'))
check('monthly, after Aug 20 → Mon Sep 7',          computeNextOccurrence(monthly,D('2026-08-20T15:00:00+08:00'), null),        D('2026-09-07T15:00:00+08:00'))

console.log('\nexplicit forward shift (biweekly_reference_date in the future wins)')
const shifted = s({ ...biwk, biweekly_reference_date: '2026-09-07' })
check('before the shifted week → not due',          isDueNow(shifted, '2026-08-03', D('2026-08-20T15:00:00+08:00')), false)
check('projection = the shifted week itself',       computeNextOccurrence(shifted, D('2026-08-20T15:00:00+08:00'), '2026-08-03'), D('2026-09-07T15:00:00+08:00'))
check('shifted week, Tue → due (run-now)',          isDueNow(shifted, '2026-08-03', D('2026-09-08T09:00:00+08:00')), true)
check('week after shift → not due',                 isDueNow(shifted, '2026-08-03', D('2026-09-15T09:00:00+08:00')), false)
check('stale reference loses to newer completion',  computeNextOccurrence(s({ ...biwk, biweekly_reference_date: '2026-08-03' }), D('2026-08-20T15:00:00+08:00'), '2026-08-17'), D('2026-08-31T15:00:00+08:00'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
