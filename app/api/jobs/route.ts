import { getAllJobs } from '@/lib/jobStore'
import { requireCaller } from '@/lib/callerAuth'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const denied = await requireCaller(request)
  if (denied) return denied

  const running = getAllJobs()
    .filter((j) => ['running', 'awaiting-approval', 'paused'].includes(j.status))
    .map((j) => ({
      id:        j.id,
      site:      j.site,
      site_name: j.site_name,
      multidev:  j.multidev,
      status:    j.status,
      startedAt: j.startedAt,
    }))

  return Response.json(running)
}
