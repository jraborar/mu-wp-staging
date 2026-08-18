import { listSchedules } from '@/lib/scheduleStore'
import { computeNextOccurrence } from '@/lib/scheduler'
import { listSites } from '@/lib/sites'

export const runtime = 'nodejs'

export async function GET() {
  const [schedules, sites] = await Promise.all([listSchedules(), listSites()])
  const now = new Date()

  // Registry is the source of truth for friendly name + skip policy (site facts)
  const bySite = new Map(sites.map(s => [s.site, s]))

  type UpcomingEntry = {
    id: string
    site: string
    site_name?: string
    cadence: string
    at: string
    skip_upstream: boolean
    skip_plugins_themes: boolean
  }

  const upcoming: UpcomingEntry[] = []

  for (const sched of schedules) {
    if (!sched.active || sched.cadence === 'security-only') continue

    const site = bySite.get(sched.site)
    // Compute next 3 occurrences per schedule
    let cursor = now
    for (let i = 0; i < 3; i++) {
      const next = computeNextOccurrence(sched, cursor)
      if (!next) break
      upcoming.push({
        id: sched.id,
        site: sched.site,
        site_name: site?.site_name ?? sched.site_name,
        cadence: sched.cadence,
        at: next.toISOString(),
        skip_upstream: site?.skip_upstream ?? sched.skip_upstream,
        skip_plugins_themes: site?.skip_plugins_themes ?? sched.skip_plugins_themes,
      })
      cursor = next
    }
  }

  upcoming.sort((a, b) => a.at.localeCompare(b.at))

  return Response.json(upcoming.slice(0, 30))
}
