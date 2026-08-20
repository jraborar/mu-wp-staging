import { listStagingHistory } from '@/lib/supabase'
import { listSites } from '@/lib/sites'
import { getAllJobs } from '@/lib/jobStore'

export const runtime = 'nodejs'

export async function GET() {
  // site key is the UUID; resolve machine_name for display from the registry.
  const mn = new Map((await listSites()).map((s) => [s.site, s.machine_name ?? null]))

  // Always include in-memory running jobs (not yet persisted with results)
  const running = getAllJobs()
    .filter((j) => j.status === 'running')
    .map((j) => ({
      id: j.id,
      site: j.site,
      site_name: j.site_name,
      machine_name: mn.get(j.site) ?? null,
      multidev: j.multidev,
      upstream: j.upstream,
      upstream_updated: j.upstreamUpdated,
      plugins_updated: j.plugins.updated,
      plugins_skipped: j.plugins.skipped,
      themes_updated: j.themes.updated,
      themes_skipped: j.themes.skipped,
      status: j.status,
      started_at: new Date(j.startedAt).toISOString(),
      completed_at: null,
    }))

  const history = (await listStagingHistory(30)).map((h) => ({
    ...h,
    machine_name: mn.get(h.site) ?? null,
  }))

  // Merge: running jobs at top, then Supabase history (deduplicated)
  const runningIds = new Set(running.map((j) => j.id))
  const merged = [...running, ...history.filter((h) => !runningIds.has(h.id))]

  return Response.json(merged)
}
