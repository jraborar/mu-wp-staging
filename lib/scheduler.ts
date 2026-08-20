import { getPacificYYMMDD } from '@/lib/timezone'
import { listSites, getSite } from '@/lib/sites'
import {
  type StagingSchedule,
  getDueSchedules,
  listSchedules,
  updateSchedule,
  updateScheduleAfterRun,
  getSecurityCheckSites,
  getPendingSecuritySites,
  markSecurityCheckPending,
  clearSecurityCheckPending,
  getSchedulerState,
  setSchedulerState,
} from '@/lib/scheduleStore'
import { createJob, getAllJobs } from '@/lib/jobStore'
import { executeJob } from '@/lib/staging'
import { run, cleanJson } from '@/lib/terminus'
import { parseWpJson } from '@/lib/wordpress'
import { hasRunForMultidev, listStagingWithVrt, clearStagingVrt } from '@/lib/supabase'
import { deleteVrtRun, runIdFromReportUrl } from '@/lib/vrt'
import { broadcastText } from '@/lib/slack'

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

// Staging runs at 15:00 PHT — shift-start time, safely after morning deployments.
function manilaDate(year: number, month: number, day: number): Date {
  const m = String(month).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return new Date(`${year}-${m}-${d}T15:00:00+08:00`)
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
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
  // 'once' fires a single time at its stored next_staging_at and never recurs;
  // 'security-only' is triggered separately, not on a cadence.
  if (sched.cadence === 'security-only' || sched.cadence === 'once') return null

  const start = getManilaDate(addDays(after, 1)) // start search from tomorrow Manila

  if (sched.cadence === 'weekly') {
    if (sched.day_of_week == null) return null
    let candidate = start
    for (let i = 0; i < 14; i++) {
      if (getDayOfWeek(candidate) === sched.day_of_week) {
        return atStagingHour(candidate)
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
        return atStagingHour(candidate)
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

// Run-now rule (PR-2): a weekly/biweekly site is "due this week" when we're in an
// on-parity ISO week (Mon–Sun), it hasn't run this week, AND the preferred weekday
// has ALREADY passed this week — so we fire at the next tick instead of skipping to
// the next parity week. (When the preferred day is still ahead, next_staging_at
// fires it on the day, so this returns false and we don't run early.) Paused weeks
// never make up: the anchor doesn't advance, parity just rolls to the next on-week.
export function isDueThisWeek(sched: StagingSchedule, now: Date): boolean {
  if (sched.cadence !== 'weekly' && sched.cadence !== 'biweekly') return false
  if (sched.day_of_week == null) return false

  const thisMonday = isoWeekMonday(now)

  // Already staged this ISO week (or later)? Not due.
  if (sched.last_staged_at) {
    const lastMonday = isoWeekMonday(new Date(sched.last_staged_at))
    if (lastMonday.getTime() >= thisMonday.getTime()) return false
  }

  // Biweekly parity — only "on" weeks (anchored on biweekly_reference_date, which
  // PR-1 seeds from the site's last_deployment).
  if (sched.cadence === 'biweekly') {
    if (!sched.biweekly_reference_date) return false
    if (weeksSince(new Date(sched.biweekly_reference_date), now) % 2 !== 0) return false
  }

  // Only fire early when the preferred weekday already passed this week.
  const isoIdx = (d: number) => (d + 6) % 7 // Sun=0..Sat=6 → Mon=0..Sun=6
  return isoIdx(getDayOfWeek(now)) > isoIdx(sched.day_of_week)
}

// ── Main scheduler loop ───────────────────────────────────────────────────────

let schedulerStarted = false

async function runDueJobs(): Promise<void> {
  try {
    const due = await getDueSchedules()
    for (const sched of due) {
      const multidev = `mu-${getPacificYYMMDD()}`
      // Skip flags are SITE FACTS (registry) — same source runUpstreamCheck uses.
      const site = await getSite(sched.site)
      // Guardrail: only auto-stage sites explicitly opted in (auto_stage). A due
      // schedule on a non-opted site does NOT fire — prevents surprise staging.
      if (!site?.auto_stage) {
        console.log(`[scheduler] Skipping scheduled staging for ${sched.site} — auto_stage is off`)
        continue
      }
      const job = createJob(sched.site, multidev, {
        skipUpstream: site?.skip_upstream ?? sched.skip_upstream,
        skipPluginsThemes: site?.skip_plugins_themes ?? sched.skip_plugins_themes,
        scheduleId: sched.id,
        deployDays: sched.deploy_days,
        deployDestination: sched.deploy_destination,
      })
      void executeJob(job)
      const next = computeNextOccurrence(sched, new Date())
      await updateScheduleAfterRun(sched.id, next)
      // A one-off ('once') has no next occurrence — retire it so it can't linger active.
      if (sched.cadence === 'once') await updateSchedule(sched.id, { active: false })
      void broadcastText(`◈ Auto-staging *${site.machine_name ?? sched.site}* — scheduled ${sched.cadence} run (\`${multidev}\`).`)
      console.log(`[scheduler] Triggered staging for ${sched.site} (${multidev}); next at ${next?.toISOString() ?? 'none'}`)
    }

    // Run-now pass (PR-2): catch weekly/biweekly sites that are due THIS on-parity
    // week but whose preferred weekday already passed (so next_staging_at points at
    // the next parity week). Deduped against the pass above + same-day/in-flight runs.
    const activeStatuses = new Set(['running', 'paused', 'awaiting-approval'])
    const multidevToday = `mu-${getPacificYYMMDD()}`
    const dueIds = new Set(due.map((d) => d.id))
    const now = new Date()
    for (const sched of await listSchedules()) {
      if (sched.active === false || dueIds.has(sched.id)) continue
      if (!isDueThisWeek(sched, now)) continue
      if (getAllJobs().some((j) => j.site === sched.site && activeStatuses.has(j.status))) continue
      if (await hasRunForMultidev(sched.site, multidevToday)) continue

      const site = await getSite(sched.site)
      const job = createJob(sched.site, multidevToday, {
        skipUpstream: site?.skip_upstream ?? sched.skip_upstream,
        skipPluginsThemes: site?.skip_plugins_themes ?? sched.skip_plugins_themes,
        scheduleId: sched.id,
        deployDays: sched.deploy_days,
        deployDestination: sched.deploy_destination,
      })
      void executeJob(job)
      await updateScheduleAfterRun(sched.id, computeNextOccurrence(sched, now))
      console.log(`[scheduler] Run-now (due this week, preferred day passed) staging for ${sched.site} (${multidevToday})`)
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
      // Guardrail: never security-stage a site that isn't opted in.
      const site = await getSite(sched.site)
      if (!site?.auto_stage) {
        console.log(`[scheduler] Skipping security staging for ${sched.site} — auto_stage is off`)
        continue
      }
      // Check if Pantheon has propagated the upstream update yet
      const result = await run(`terminus upstream:updates:list ${sched.site}.dev --format=json 2>&1`)
      let hasUpdates = false
      try {
        const entries = parseWpJson(cleanJson(result.stdout))
        hasUpdates = entries.length > 0
      } catch {}

      if (hasUpdates) {
        const multidev = `mu-${getPacificYYMMDD()}`
        const job = createJob(sched.site, multidev, {
          skipPluginsThemes: true, // security runs apply upstream only
          scheduleId: sched.id,
          deployDays: sched.deploy_days,
          securityFastTrack: true,
        })
        void executeJob(job)
        await clearSecurityCheckPending(sched.id)
        await updateScheduleAfterRun(sched.id, computeNextOccurrence(sched, new Date()))
        void broadcastText(`🔐 Auto-staging *${site.machine_name ?? sched.site}* — security update confirmed (\`${multidev}\`).`)
        console.log(`[scheduler] Security staging triggered for ${sched.site} — upstream updates confirmed on Pantheon`)
      } else {
        console.log(`[scheduler] No upstream updates yet on Pantheon for ${sched.site} — will check again`)
      }
    }
  } catch (err) {
    console.error('[scheduler] Error in pending security checks:', err)
  }
}

async function runUpstreamCheck(): Promise<void> {
  try {
    const today = getPacificYYMMDD()
    const sites = await listSites()
    // Guardrail: auto_stage gates enrollment — a merely-registered site is never
    // auto-staged by the scan until explicitly opted in. skip_upstream still means
    // "skip the upstream step when we do stage".
    const eligible = sites.filter(s => s.active && s.auto_stage && !s.skip_upstream)
    if (eligible.length === 0) return

    const activeStatuses = new Set(['running', 'paused', 'awaiting-approval'])
    const multidev = `mu-${today}`

    for (const site of eligible) {
      // Skip if we already staged upstream for this site today
      const stateKey = `upstream_staged_${site.site}`
      const lastStaged = await getSchedulerState(stateKey)
      if (lastStaged === today) continue

      // Dedupe across lanes: don't create a second run when the site already has
      // one today (manual/scheduled/security — all share the mu-YYMMDD name) or an
      // in-flight job. This is what prevented the duplicate up-/mu- History entries.
      if (getAllJobs().some(j => j.site === site.site && activeStatuses.has(j.status))) {
        console.log(`[scheduler] Skipping upstream scan for ${site.site} — a run is already in flight`)
        continue
      }
      if (await hasRunForMultidev(site.site, multidev)) {
        await setSchedulerState(stateKey, today)
        console.log(`[scheduler] Skipping upstream scan for ${site.site} — already staged today (${multidev})`)
        continue
      }

      const result = await run(`terminus upstream:updates:list ${site.site}.dev --format=json 2>&1`)
      let hasUpdates = false
      try {
        const entries = parseWpJson(cleanJson(result.stdout))
        hasUpdates = Array.isArray(entries) && entries.length > 0
      } catch {}

      if (!hasUpdates) continue

      // Upstream-only fast-track run — unified mu- name so slot-reclaim recognizes it.
      const job = createJob(site.site, multidev, {
        skipUpstream: false,
        skipPluginsThemes: true,
        deployDays: site.deploy_days,
        deployDestination: site.deploy_destination,
        securityFastTrack: true,
      })
      void executeJob(job)
      await setSchedulerState(stateKey, today)
      void broadcastText(`🔐 Auto-staging *${site.machine_name ?? site.site}* — upstream/security update detected (\`${multidev}\`, upstream-only fast-track).`)
      console.log(`[scheduler] Upstream updates found for ${site.site} — staging upstream only (${multidev})`)
    }
  } catch (err) {
    console.error('[scheduler] Error in upstream check:', err)
  }
}

const VRT_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

// Expire shareable VRT report links: a report is stale once it's >14 days old OR
// superseded by a newer run on the same site (a later code update). Expired reports
// have their screenshots purged in mu-vrt and their link fields nulled here, so the
// History tab stops offering the link.
async function runVrtLinkExpiry(): Promise<void> {
  try {
    const rows = await listStagingWithVrt() // newest first
    if (rows.length === 0) return
    const now = Date.now()
    const seenSite = new Set<string>()

    for (const row of rows) {
      const superseded = seenSite.has(row.site) // a newer run for this site came first
      seenSite.add(row.site)
      const tooOld = now - new Date(row.started_at).getTime() > VRT_LINK_TTL_MS
      if (!superseded && !tooOld) continue

      const runId = runIdFromReportUrl(row.vrt_report_url)
      if (runId) await deleteVrtRun(runId)
      await clearStagingVrt(row.id)
      console.log(`[scheduler] Expired VRT report for ${row.site} (${superseded ? 'superseded' : '>14d'})`)
    }
  } catch (err) {
    console.error('[scheduler] Error in VRT link expiry:', err)
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

  // Upstream check for all active sites — every 12 hours
  void runUpstreamCheck()
  setInterval(runUpstreamCheck, 12 * 60 * 60 * 1000)

  // VRT report link expiry (14 days / superseded) — every 6 hours
  void runVrtLinkExpiry()
  setInterval(runVrtLinkExpiry, 6 * 60 * 60 * 1000)

  console.log('[scheduler] Started')
}
