import { getAllJobs } from '@/lib/jobStore'

export const runtime = 'nodejs'

export async function GET() {
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
