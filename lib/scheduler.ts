import { getManilaYYMMDD } from '@/lib/timezone'
import {
  type StagingSchedule,
  getDueSchedules,
  updateScheduleAfterRun,
  getSecurityCheckSites,
  getPendingSecuritySites,
  markSecurityCheckPending,
  clearSecurityCheckPending,
  getSchedulerState,
  setSchedulerState,
} from '@/lib/scheduleStore'
import { createJob } from '@/lib/jobStore'
import { executeJob } from '@/lib/staging'
import { run, cleanJson } from '@/lib/terminus'
import { parseWpJson } from '@/lib/wordpress'

// ── Next occurrence computation (Manila timezone, pure date math) ─────────────

function getManilaDate(date: Date): Date {
  const str = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(date)
  return new Date(`${str}T00:00:00+08:00`)
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function getDayOfWeek(date: Date): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short' })
      .formatToParts(date)
      .find(p => p.type === 'weekday')?.value === 'Sun' ? '0' :
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short' })
      .formatToParts(date)
      .find(p => p.type === 'weekday')?.value === 'Mon' ? '1' :
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short' })
      .formatToParts(date)
      .find(p => p.type === 'weekday')?.value === 'Tue' ? '2' :
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short' })
      .formatToParts(date)
      .find(p => p.type === 'weekday')?.value === 'Wed' ? '3' :
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short' })
      .formatToParts(date)
      .find(p => p.type === 'weekday')?.value === 'Thu' ? '4' :
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'short' })
      .formatToParts(date)
      .find(p => p.type === 'weekday')?.value === 'Fri' ? '5' : '6',
    10,
  )
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

function manilaDate(year: number, month: number, day: number): Date {
  const m = String(month).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return new Date(`${year}-${m}-${d}T09:00:00+08:00`)
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

// Returns the Nth occurrence (1-based, or -1 for last) of dayOfWeek in the given month/year.
function nthWeekdayInMonth(year: number, month: number, dayOfWeek: number, n: number): Date | null {
  const firstDay = manilaDate(year, month, 1)
  const firstDow = getDayOfWeek(firstDay)
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

// Returns Monday of the ISO week containing the given date (Manila time)
function isoWeekMonday(date: Date): Date {
  const dow = getDayOfWeek(date) // 0=Sun … 6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow
  return getManilaDate(addDays(date, mondayOffset))
}

// Returns number of full weeks since reference (using Manila midnight dates)
function weeksSince(reference: Date, target: Date): number {
  const refMidnight = getManilaDate(reference)
  const tgtMidnight = getManilaDate(target)
  const diff = tgtMidnight.getTime() - refMidnight.getTime()
  return Math.floor(diff / (7 * 24 * 60 * 60 * 1000))
}

export function computeNextOccurrence(sched: StagingSchedule, after: Date): Date | null {
  if (sched.cadence === 'security-only') return null

  const start = getManilaDate(addDays(after, 1)) // start search from tomorrow Manila

  if (sched.cadence === 'weekly') {
    if (sched.day_of_week == null) return null
    let candidate = start
    for (let i = 0; i < 14; i++) {
      if (getDayOfWeek(candidate) === sched.day_of_week) {
        return new Date(candidate.getTime())
      }
      candidate = addDays(candidate, 1)
    }
    return null
  }

  if (sched.cadence === 'biweekly') {
    if (sched.day_of_week == null || !sched.biweekly_reference_date) return null
    const ref = new Date(sched.biweekly_reference_date)
    let candidate = start
    for (let i = 0; i < 28; i++) {
      if (
        getDayOfWeek(candidate) === sched.day_of_week &&
        weeksSince(ref, candidate) % 2 === 0
      ) {
        return new Date(candidate.getTime())
      }
      candidate = addDays(candidate, 1)
    }
    return null
  }

  if (sched.cadence === 'monthly') {
    if (sched.day_of_week == null || sched.week_of_month == null) return null
    const { month: startMonth, year: startYear } = getManilaMonthDay(start)
    for (let i = 0; i < 13; i++) {
      const month = ((startMonth - 1 + i) % 12) + 1
      const year  = startYear + Math.floor((startMonth - 1 + i) / 12)
      const date  = nthWeekdayInMonth(year, month, sched.day_of_week, sched.week_of_month)
      if (date && date > after) return date
    }
    return null
  }

  if (sched.cadence === 'bimonthly-week-of-15') {
    if (sched.bimonthly_ref_month == null || sched.bimonthly_day_of_week == null) return null
    const { month: startMonth, year: startYear } = getManilaMonthDay(start)
    for (let i = 0; i < 25; i++) {
      const month = ((startMonth - 1 + i) % 12) + 1
      const year  = startYear + Math.floor((startMonth - 1 + i) / 12)
      // Check if this is an "on" month: (month - ref_month) % 2 === 0
      const diff = ((month - sched.bimonthly_ref_month) % 12 + 12) % 12
      if (diff % 2 !== 0) continue
      // Find the ISO week containing the 15th of this month
      const the15th = manilaDate(year, month, 15)
      const monday  = isoWeekMonday(the15th)
      // Find the target weekday within that ISO week
      const dowOffset = (sched.bimonthly_day_of_week - getDayOfWeek(monday) + 7) % 7
      const target = addDays(monday, dowOffset)
      // Make sure it's still within the same ISO week (Mon–Sun)
      if (getManilaMonthDay(target).month !== getManilaMonthDay(monday).month &&
          getDayOfWeek(target) < getDayOfWeek(monday)) continue
      if (target > after) return target
    }
    return null
  }

  return null
}

// ── Main scheduler loop ───────────────────────────────────────────────────────

let schedulerStarted = false

async function runDueJobs(): Promise<void> {
  try {
    const due = await getDueSchedules()
    for (const sched of due) {
      const multidev = `mu-${getManilaYYMMDD()}`
      const job = createJob(sched.site, multidev, {
        skipUpstream: sched.skip_upstream,
        skipPluginsThemes: sched.skip_plugins_themes,
        scheduleId: sched.id,
        deployDays: sched.deploy_days,
      })
      void executeJob(job)
      const next = computeNextOccurrence(sched, new Date())
      await updateScheduleAfterRun(sched.id, next)
      console.log(`[scheduler] Triggered staging for ${sched.site} (${multidev}); next at ${next?.toISOString() ?? 'none'}`)
    }
  } catch (err) {
    console.error('[scheduler] Error in runDueJobs:', err)
  }
}

async function runSecurityCheck(): Promise<void> {
  try {
    const res = await fetch('https://api.wordpress.org/core/version-check/1.7/')
    if (!res.ok) return
    const payload = await res.json() as { offers?: Array<{ version?: string }> }
    const latest = payload?.offers?.[0]?.version
    if (!latest) return

    const stored = await getSchedulerState('last_known_wp_version')
    if (stored === latest) return

    // New WP version detected — flag eligible sites as pending instead of staging immediately.
    // Pantheon's upstream may take a day or two to propagate; runPendingSecurityChecks()
    // will poll terminus until the update is actually available, then trigger staging.
    console.log(`[scheduler] New WordPress version detected: ${latest} (was ${stored ?? 'unknown'}) — marking sites as pending`)
    await setSchedulerState('last_known_wp_version', latest)

    const sites = await getSecurityCheckSites(14)
    for (const sched of sites) {
      await markSecurityCheckPending(sched.id)
      console.log(`[scheduler] Marked ${sched.site} as pending security check (WP ${latest})`)
    }
  } catch (err) {
    console.error('[scheduler] Error in security check:', err)
  }
}

async function runPendingSecurityChecks(): Promise<void> {
  try {
    const pending = await getPendingSecuritySites()
    if (pending.length === 0) return

    for (const sched of pending) {
      // Check if Pantheon has propagated the upstream update yet
      const result = await run(`terminus upstream:updates:list ${sched.site}.dev --format=json 2>&1`)
      let hasUpdates = false
      try {
        const entries = parseWpJson(cleanJson(result.stdout))
        hasUpdates = entries.length > 0
      } catch {}

      if (hasUpdates) {
        const multidev = `mu-${getManilaYYMMDD()}`
        const job = createJob(sched.site, multidev, {
          skipPluginsThemes: sched.skip_plugins_themes,
          scheduleId: sched.id,
          deployDays: sched.deploy_days,
        })
        void executeJob(job)
        await clearSecurityCheckPending(sched.id)
        await updateScheduleAfterRun(sched.id, computeNextOccurrence(sched, new Date()))
        console.log(`[scheduler] Security staging triggered for ${sched.site} — upstream updates confirmed on Pantheon`)
      } else {
        console.log(`[scheduler] No upstream updates yet on Pantheon for ${sched.site} — will check again`)
      }
    }
  } catch (err) {
    console.error('[scheduler] Error in pending security checks:', err)
  }
}

export function startScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true

  // Main loop: due scheduled jobs + pending security checks — every 5 minutes
  void runDueJobs()
  void runPendingSecurityChecks()
  setInterval(() => {
    void runDueJobs()
    void runPendingSecurityChecks()
  }, 5 * 60 * 1000)

  // WP.org version check — every 6 hours
  void runSecurityCheck()
  setInterval(runSecurityCheck, 6 * 60 * 60 * 1000)

  console.log('[scheduler] Started')
}
