import { getAllJobs } from '@/lib/jobStore'

export const runtime = 'nodejs'

export async function GET() {
  const running = getAllJobs()
    .filter((j) => j.status === 'running')
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
