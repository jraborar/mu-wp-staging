import { getPacificYYMMDD, getManilaToday, addBusinessDays } from '@/lib/timezone'
import { listSites, getSite, updateSite, isPaused } from '@/lib/sites'
import {
  getActiveSchedules,
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
import { computeNextOccurrence, isDueNow } from '@/lib/cadence'
import { broadcastText } from '@/lib/slack'

// ── Main scheduler loop ───────────────────────────────────────────────────────

let schedulerStarted = false

const ACTIVE_JOB_STATUSES = new Set(['running', 'paused', 'awaiting-approval'])

async function runDueJobs(): Promise<void> {
  try {
    const [schedules, sites] = await Promise.all([getActiveSchedules(), listSites()])
    const bySite = new Map(sites.map(s => [s.site, s]))
    const now = new Date()
    const multidev = `mu-${getPacificYYMMDD()}`

    for (const sched of schedules) {
      // Registry is the source of truth for site facts — the cadence anchor
      // (last_deployment) and the skip flags alike.
      const site = bySite.get(sched.site)
      if (!isDueNow(sched, site?.last_deployment, now)) continue

      // A customer-requested hold outranks everything, including a due occurrence.
      if (site && isPaused(site)) {
        console.log(`[scheduler] ${sched.site} is due but updates are paused${site.pause_reason ? ` — ${site.pause_reason}` : ''}`)
        continue
      }

      // Guardrail: only auto-stage sites explicitly opted in (auto_stage). A due
      // schedule on a non-opted site does NOT fire — prevents surprise staging.
      if (!site?.auto_stage) {
        console.log(`[scheduler] Skipping scheduled staging for ${sched.site} — auto_stage is off`)
        continue
      }

      // One run per multidev name (mu-YYMMDD) per site: a second run today would
      // delete and rebuild the first one's multidev. When today's slot is already
      // taken (typically by a fast-track upstream run), defer rather than drop —
      // the ISO-week window is still open, so this fires on tomorrow's tick.
      if (getAllJobs().some(j => j.site === sched.site && ACTIVE_JOB_STATUSES.has(j.status))) {
        console.log(`[scheduler] ${sched.site} is due but a run is already in flight — deferring`)
        continue
      }
      if (await hasRunForMultidev(sched.site, multidev)) {
        console.log(`[scheduler] ${sched.site} is due but already staged today (${multidev}) — deferring`)
        continue
      }

      const job = createJob(sched.site, multidev, {
        skipUpstream: site.skip_upstream ?? sched.skip_upstream,
        skipPluginsThemes: site.skip_plugins_themes ?? sched.skip_plugins_themes,
        scheduleId: sched.id,
        deployDays: sched.deploy_days,
        deployDestination: sched.deploy_destination,
      })
      void executeJob(job)
      const next = computeNextOccurrence(sched, now, site.last_deployment)
      await updateScheduleAfterRun(sched.id, next)
      // A one-off ('once') has no next occurrence — retire it so it can't linger active.
      if (sched.cadence === 'once') await updateSchedule(sched.id, { active: false })
      void broadcastText(`◈ Auto-staging *${site.machine_name ?? sched.site}* — ${sched.cadence} run (\`${multidev}\`).`)
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
      // Guardrail: never security-stage a site that isn't opted in.
      const site = await getSite(sched.site)
      if (site && isPaused(site)) {
        console.log(`[scheduler] Skipping security staging for ${sched.site} — updates are paused`)
        continue
      }
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
        await updateScheduleAfterRun(sched.id, computeNextOccurrence(sched, new Date(), site?.last_deployment))
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
    const eligible = sites.filter(s => s.active && s.auto_stage && !s.skip_upstream && !isPaused(s))
    if (eligible.length === 0) return

    const multidev = `mu-${today}`

    for (const site of eligible) {
      // Skip if we already staged upstream for this site today
      const stateKey = `upstream_staged_${site.site}`
      const lastStaged = await getSchedulerState(stateKey)
      if (lastStaged === today) continue

      // Dedupe across lanes: don't create a second run when the site already has
      // one today (manual/scheduled/security — all share the mu-YYMMDD name) or an
      // in-flight job. This is what prevented the duplicate up-/mu- History entries.
      if (getAllJobs().some(j => j.site === site.site && ACTIVE_JOB_STATUSES.has(j.status))) {
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


// A hold with no follow-up becomes a site that quietly stopped being maintained.
// This pass IS the follow-up: it warns 3 business days before an expected end so
// the consultant can chase the customer, keeps nudging once that date lapses (the
// site stays paused — an elapsed date never resumes anything), and for the common
// case where the customer gave no timeline it reports the AGE of the hold, since
// chasing a date is consultant discretion and needs a prompt rather than a rule.
const PAUSE_NUDGE_EVERY_MS = 7 * 24 * 60 * 60 * 1000
const PAUSE_WARN_BUSINESS_DAYS = 3
const PAUSE_OPEN_ENDED_NUDGE_DAYS = 14

async function runPauseReminders(): Promise<void> {
  try {
    const paused = (await listSites()).filter(isPaused)
    if (paused.length === 0) return
    const now = Date.now()
    const today = getManilaToday()
    const warnHorizon = addBusinessDays(today, PAUSE_WARN_BUSINESS_DAYS)

    for (const site of paused) {
      // At most one reminder per site per week, whichever kind applies.
      const last = site.pause_notified_at ? new Date(site.pause_notified_at).getTime() : 0
      if (now - last < PAUSE_NUDGE_EVERY_MS) continue

      const label = site.site_name ?? site.machine_name ?? site.site
      const ageDays = site.paused_at
        ? Math.floor((now - new Date(site.paused_at).getTime()) / 86_400_000)
        : 0
      let message: string | null = null

      if (site.paused_until) {
        const until = new Date(`${String(site.paused_until).slice(0, 10)}T00:00:00+08:00`)
        if (until.getTime() < today.getTime()) {
          message = `⏸ *${label}* — the hold was expected to end ${site.paused_until} and has not been resumed (paused ${ageDays} days). Still paused: resume it, or agree a new date.`
        } else if (until.getTime() <= warnHorizon.getTime()) {
          message = `⏸ *${label}* — the hold is expected to end ${site.paused_until}. Follow up with the customer before updates resume.`
        }
      } else if (ageDays >= PAUSE_OPEN_ENDED_NUDGE_DAYS) {
        message = `⏸ *${label}* — paused ${ageDays} days with no end date${site.pause_reason ? ` (${site.pause_reason})` : ''}. Worth chasing a timeline.`
      }

      if (!message) continue
      void broadcastText(message)
      await updateSite(site.site, { pause_notified_at: new Date().toISOString() }).catch(() => {})
      console.log(`[scheduler] Pause reminder sent for ${site.site}`)
    }
  } catch (err) {
    console.error('[scheduler] Error in pause reminders:', err)
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

  // Pause follow-ups — every 6 hours, deduped to one nudge per site per week
  void runPauseReminders()
  setInterval(runPauseReminders, 6 * 60 * 60 * 1000)

  // VRT report link expiry (14 days / superseded) — every 6 hours
  void runVrtLinkExpiry()
  setInterval(runVrtLinkExpiry, 6 * 60 * 60 * 1000)

  console.log('[scheduler] Started')
}
