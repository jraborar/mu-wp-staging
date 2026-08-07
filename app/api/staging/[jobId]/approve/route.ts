import { type NextRequest } from 'next/server'
import { getJob } from '@/lib/jobStore'

export const runtime = 'nodejs'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const body = await request.json().catch(() => null)
  if (!body || typeof body.approved !== 'boolean') {
    return Response.json({ error: 'Missing approved boolean' }, { status: 400 })
  }

  const job = getJob(jobId)
  if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })

  if (!job.pendingApproval) {
    return Response.json({ error: 'No pending approval for this job' }, { status: 409 })
  }

  job.pendingApproval.resolve(body.approved)
  job.pendingApproval = null
  job.status = 'running'

  return Response.json({ ok: true, approved: body.approved })
}
