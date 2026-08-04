import { type NextRequest } from 'next/server'
import { getJob } from '@/lib/jobStore'

export const runtime = 'nodejs'

// Returns current job metadata (non-streaming, for polling state)
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const job = getJob(jobId)
  if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })

  return Response.json({
    id: job.id,
    site: job.site,
    site_name: job.site_name,
    multidev: job.multidev,
    upstream: job.upstream,
    upstreamUpdated: job.upstreamUpdated,
    upstreamConflict: job.upstreamConflict,
    plugins: job.plugins,
    themes: job.themes,
    status: job.status,
    startedAt: job.startedAt,
    lastActivity: job.lastActivity,
  })
}
