import type { StagingSchedule } from '@/lib/scheduleStore'

// Cadence math for the staging scheduler: when is a schedule due, and when does it
// next come round. Pure Manila-timezone date logic with no I/O — the scheduler and
// the schedule/upcoming APIs all read due-ness from here, and `npm run check:cadence`
// (scripts/cadence-check.ts) exercises it directly.

function getManilaDate(date: Date): Date {
  const str = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(date)
  return new Date(`${str}T00:00:00+08:00`)
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Day of week in Manila: 0=Sun … 6=Sat (the encoding staging_schedules.day_of_week uses).
export function manilaDayOfWeek(date: Date): number {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short' }).format(date)
  return Math.max(0, WEEKDAYS.indexOf(short))
}

function getManilaMonthDay(date: Date): { month: number; day: number; year: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date)
  return {
    month: parseInt(parts.find(p => p.type === 'month')?.value ?? '1', 10),
    day:   parseInt(parts.find(p => p.type === 'day')?.value ?? '1', 10),
    year:  parseInt(parts.find(p => p.type === 'year')?.value ?? '2025', 10),
  }
}

// Staging runs at 15:00 PHT — shift-start time, safely after morning deployments.
function manilaDate(year: number, month: number, day: number): Date {
  const m = String(month).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return new Date(`${year}-${m}-${d}T15:00:00+08:00`)
}

// Snap a Manila-midnight date to the 15:00 PHT staging hour on the same Manila day.
// weekly/biweekly candidates are built from getManilaDate (midnight); without this
// they would fire at 00:00 instead of the intended 15:00 the other cadences use.
function atStagingHour(date: Date): Date {
  const { year, month, day } = getManilaMonthDay(date)
  return manilaDate(year, month, day)
}

// Returns the Nth occurrence (1-based, or -1 for last) of dayOfWeek in the given month/year.
function nthWeekdayInMonth(year: number, month: number, dayOfWeek: number, n: number): Date | null {
  const firstDay = manilaDate(year, month, 1)
  const firstDow = manilaDayOfWeek(firstDay)
  let offset = (dayOfWeek - firstDow + 7) % 7
  const firstOccurrence = addDays(firstDay, offset)

  if (n === -1) {
    // Last occurrence
    let candidate = firstOccurrence
    let next = addDays(candidate, 7)
    while (getManilaMonthDay(next).month === month) {
      candidate = next
      next = addDays(next, 7)
    }
    return candidate
  }

  const result = addDays(firstOccurrence, (n - 1) * 7)
  return getManilaMonthDay(result).month === month ? result : null
}

// ── ISO-week cadence model ────────────────────────────────────────────────────
// Due-ness is COMPUTED (isDueNow), not read from a stored next_staging_at. A
// schedule is due when the current ISO week (Mon–Sun, Manila) is an on-cadence week
// and nothing has run in it yet. Two intentional consequences:
//   • RUN-NOW — a cycle that becomes due mid-week fires on the next scheduler tick
//     even if the preferred weekday already passed (no waiting a whole cycle).
//   • NO MAKE-UP — a week that passes without a run is lost. Parity keeps counting
//     from the anchor, it does not slide forward, so a paused/missed week never
//     produces a catch-up run in an off-parity week.
// Parity anchors on the site's real cycle completion (`sites.last_deployment`),
// which is why every caller threads that value through.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// Returns Monday of the ISO week containing the given date (Manila time)
function isoWeekMonday(date: Date): Date {
  const dow = manilaDayOfWeek(date) // 0=Sun … 6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow
  return getManilaDate(addDays(date, mondayOffset))
}

// The same Monday as a Manila date string — what `skip_week` /
// `biweekly_reference_date` store.
export function isoWeekMondayStr(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(isoWeekMonday(date))
}

// Manila has no DST, so ISO-week Mondays are always exact 7-day multiples apart.
function weekSpan(fromMonday: Date, toMonday: Date): number {
  return Math.round((toMonday.getTime() - fromMonday.getTime()) / WEEK_MS)
}

function addWeeks(monday: Date, weeks: number): Date {
  return new Date(monday.getTime() + weeks * WEEK_MS)
}

// Accepts either a Manila date-only string ('2026-08-03') or a full timestamp.
function parseAnchor(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+08:00`) : new Date(value)
}

function sameWeek(a: Date, b: Date): boolean {
  return isoWeekMonday(a).getTime() === isoWeekMonday(b).getTime()
}

// Weeks between fires — null for the calendar-driven cadences.
function intervalWeeks(cadence: StagingSchedule['cadence']): number | null {
  return cadence === 'weekly' ? 1 : cadence === 'biweekly' ? 2 : null
}

// The staging moment (15:00 PHT) for `dayOfWeek` inside the ISO week at `monday`.
// ISO weeks run Mon→Sun, so Sunday (0) is the LAST day of the week, not the first.
function weekTarget(monday: Date, dayOfWeek: number): Date {
  return atStagingHour(addDays(monday, dayOfWeek === 0 ? 6 : dayOfWeek - 1))
}

// The ISO-week Monday the cadence counts from.
//   completion (`sites.last_deployment`) — its own week is already spent, so the next
//     fire is anchor + interval.
//   reference (`biweekly_reference_date`) — an explicit user shift ("all future
//     occurrences" in the Upcoming tab) or the registration seed; its own week IS a
//     fire week.
// Later wins, ties go to the completion, so a deliberate shift holds until the next
// completed run catches up to it. With neither, a schedule anchors on its creation
// week — i.e. a freshly created schedule may fire on the next tick. That is the
// run-now contract; enter the site's real "Last deployment" when registering to land
// the cycle on the correct week instead.
function parityAnchor(
  sched: StagingSchedule,
  lastDeployment?: string | null,
): { monday: Date; fromCompletion: boolean } | null {
  const completed = lastDeployment ? isoWeekMonday(parseAnchor(lastDeployment)) : null
  const reference = sched.biweekly_reference_date ? isoWeekMonday(parseAnchor(sched.biweekly_reference_date)) : null
  if (completed && (!reference || reference.getTime() <= completed.getTime())) {
    return { monday: completed, fromCompletion: true }
  }
  if (reference) return { monday: reference, fromCompletion: false }
  if (sched.created_at) return { monday: isoWeekMonday(new Date(sched.created_at)), fromCompletion: false }
  return null
}

// The occurrence for one calendar month, or null when that month isn't an "on" month.
function monthOccurrence(sched: StagingSchedule, year: number, month: number): Date | null {
  if (sched.cadence === 'monthly') {
    if (sched.day_of_week == null || sched.week_of_month == null) return null
    return nthWeekdayInMonth(year, month, sched.day_of_week, sched.week_of_month)
  }
  if (sched.cadence === 'bimonthly-week-of-15') {
    if (sched.bimonthly_ref_month == null || sched.bimonthly_day_of_week == null) return null
    // Every OTHER month, counted from bimonthly_ref_month
    const monthsFromRef = (((month - sched.bimonthly_ref_month) % 12) + 12) % 12
    if (monthsFromRef % 2 !== 0) return null
    // The target weekday inside the ISO week containing the 15th (mid-month)
    return weekTarget(isoWeekMonday(manilaDate(year, month, 15)), sched.bimonthly_day_of_week)
  }
  return null
}

// A single ISO week can straddle two months.
function monthsInWeek(monday: Date): { year: number; month: number }[] {
  const a = getManilaMonthDay(monday)
  const b = getManilaMonthDay(addDays(monday, 6))
  return a.year === b.year && a.month === b.month ? [a] : [a, b]
}

// The scheduled moment inside the CURRENT ISO week, or null when this week isn't an
// on-cadence week. Once `now` passes it the schedule stays due for the rest of the
// week — and never beyond it, which is what makes missed weeks lost rather than
// deferred.
export function currentWindowTarget(
  sched: StagingSchedule,
  lastDeployment?: string | null,
  now: Date = new Date(),
): Date | null {
  const thisMonday = isoWeekMonday(now)
  const weeks = intervalWeeks(sched.cadence)

  if (weeks) {
    if (sched.day_of_week == null) return null
    const anchor = parityAnchor(sched, lastDeployment)
    if (!anchor) return null
    const span = weekSpan(anchor.monday, thisMonday)
    if (span < (anchor.fromCompletion ? weeks : 0) || span % weeks !== 0) return null
    return weekTarget(thisMonday, sched.day_of_week)
  }

  for (const { year, month } of monthsInWeek(thisMonday)) {
    const occ = monthOccurrence(sched, year, month)
    if (occ && sameWeek(occ, thisMonday)) return occ
  }
  return null
}

// Should this schedule fire right now?
export function isDueNow(
  sched: StagingSchedule,
  lastDeployment?: string | null,
  now: Date = new Date(),
): boolean {
  if (!sched.active || sched.cadence === 'security-only') return false

  // An explicit pin ("this occurrence only") outranks cadence parity.
  if (sched.override_at) return parseAnchor(sched.override_at) <= now
  // A one-off has no cadence — it fires at its stored datetime, once.
  if (sched.cadence === 'once') return !!sched.next_staging_at && new Date(sched.next_staging_at) <= now

  if (sched.skip_week && sameWeek(parseAnchor(sched.skip_week), now)) return false
  // Already fired this ISO week, or completed a cycle in it. (A failed run counts as
  // fired: the anchor didn't move, so the cycle resumes on the next on-parity week.)
  if (sched.last_staged_at && sameWeek(new Date(sched.last_staged_at), now)) return false
  if (lastDeployment && sameWeek(parseAnchor(lastDeployment), now)) return false

  const target = currentWindowTarget(sched, lastDeployment, now)
  return target != null && target <= now
}

// Next FUTURE occurrence after `after` — the projection the Upcoming tab renders and
// what gets stored back into next_staging_at. Due-ness is isDueNow()'s call, not
// this: a moment already passed inside the current window is "due now", not upcoming.
export function computeNextOccurrence(
  sched: StagingSchedule,
  after: Date,
  lastDeployment?: string | null,
): Date | null {
  // 'once' fires a single time at its stored next_staging_at and never recurs;
  // 'security-only' is triggered separately, not on a cadence.
  if (sched.cadence === 'security-only' || sched.cadence === 'once') return null

  const weeks = intervalWeeks(sched.cadence)
  if (weeks) {
    if (sched.day_of_week == null) return null
    const anchor = parityAnchor(sched, lastDeployment)
    if (!anchor) return null
    const minSpan = anchor.fromCompletion ? weeks : 0
    let span = Math.max(minSpan, weekSpan(anchor.monday, isoWeekMonday(after)))
    span = Math.ceil(span / weeks) * weeks
    for (let i = 0; i < 106; i++, span += weeks) {
      const target = weekTarget(addWeeks(anchor.monday, span), sched.day_of_week)
      if (target > after) return target
    }
    return null
  }

  const { year: startYear, month: startMonth } = getManilaMonthDay(after)
  for (let i = 0; i < 25; i++) {
    const month = ((startMonth - 1 + i) % 12) + 1
    const year  = startYear + Math.floor((startMonth - 1 + i) / 12)
    const occ = monthOccurrence(sched, year, month)
    if (occ && occ > after) return occ
  }
  return null
}
