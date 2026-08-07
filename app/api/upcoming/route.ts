import { listSchedules } from '@/lib/scheduleStore'
import { computeNextOccurrence } from '@/lib/scheduler'

export const runtime = 'nodejs'

export async function GET() {
  const schedules = await listSchedules()
  const now = new Date()

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

    // Compute next 3 occurrences per schedule
    let cursor = now
    for (let i = 0; i < 3; i++) {
      const next = computeNextOccurrence(sched, cursor)
      if (!next) break
      upcoming.push({
        id: sched.id,
        site: sched.site,
        site_name: sched.site_name,
        cadence: sched.cadence,
        at: next.toISOString(),
        skip_upstream: sched.skip_upstream,
        skip_plugins_themes: sched.skip_plugins_themes,
      })
      cursor = next
    }
  }

  upcoming.sort((a, b) => a.at.localeCompare(b.at))

  return Response.json(upcoming.slice(0, 30))
}
