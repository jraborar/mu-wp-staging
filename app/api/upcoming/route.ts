import { listSchedules } from '@/lib/scheduleStore'
import { computeNextOccurrence, currentWindowTarget, isDueNow } from '@/lib/cadence'
import { listSites } from '@/lib/sites'

export const runtime = 'nodejs'

export async function GET() {
  const [schedules, sites] = await Promise.all([listSchedules(), listSites()])
  const now = new Date()

  // Registry is the source of truth for friendly name + skip policy (site facts)
  // and for the cadence anchor (last_deployment) the projections count from.
  const bySite = new Map(sites.map(s => [s.site, s]))

  type UpcomingEntry = {
    id: string
    site: string
    site_name?: string
    machine_name?: string | null
    cadence: string
    at: string
    due_now?: boolean
    skip_upstream: boolean
    skip_plugins_themes: boolean
  }

  const upcoming: UpcomingEntry[] = []

  for (const sched of schedules) {
    if (!sched.active || sched.cadence === 'security-only') continue

    const site = bySite.get(sched.site)
    const anchor = site?.last_deployment
    const base = {
      id: sched.id,
      site: sched.site,
      site_name: site?.site_name ?? sched.site_name,
      machine_name: site?.machine_name ?? null,
      cadence: sched.cadence,
      skip_upstream: site?.skip_upstream ?? sched.skip_upstream,
      skip_plugins_themes: site?.skip_plugins_themes ?? sched.skip_plugins_themes,
    }

    // A schedule whose slot has already passed inside an on-cadence week is due NOW —
    // it fires on the next tick, so show it as such instead of skipping ahead to the
    // next projected occurrence (which would read as "nothing happening today").
    if (isDueNow(sched, anchor, now)) {
      const target = sched.override_at
        ? new Date(sched.override_at)
        : sched.cadence === 'once'
          ? (sched.next_staging_at ? new Date(sched.next_staging_at) : null)
          : currentWindowTarget(sched, anchor, now)
      if (target) upcoming.push({ ...base, at: target.toISOString(), due_now: true })
    }

    // A future override_at that hasn't fired yet is invisible to
    // computeNextOccurrence (cadence-only math) and to the isDueNow branch above
    // (only active once the moment arrives). Inject it directly so it always
    // appears in the list — the common case is rescheduling to later in the same day
    // after the regular cadence slot has already passed.
    if (sched.override_at && !isDueNow(sched, anchor, now)) {
      const overrideTarget = new Date(sched.override_at)
      if (overrideTarget > now) upcoming.push({ ...base, at: sched.override_at, due_now: false })
    }

    // Compute next 3 occurrences per schedule
    let cursor = now
    for (let i = 0; i < 3; i++) {
      const next = computeNextOccurrence(sched, cursor, anchor)
      if (!next) break
      upcoming.push({ ...base, at: next.toISOString() })
      cursor = next
    }
  }

  upcoming.sort((a, b) => a.at.localeCompare(b.at))

  return Response.json(upcoming.slice(0, 30))
}
