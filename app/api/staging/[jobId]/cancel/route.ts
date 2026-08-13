import { type NextRequest } from 'next/server'
import { getJob } from '@/lib/jobStore'

export const runtime = 'nodejs'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const job = getJob(jobId)
  if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })

  if (!['running', 'awaiting-approval', 'paused'].includes(job.status)) {
    return Response.json({ error: 'Job is not cancellable' }, { status: 409 })
  }

  // Force-cancel paused jobs immediately (no pipeline to signal)
  if (job.status === 'paused') {
    job.status = 'cancelled'
    job.emitter.emit('event', { type: 'complete', status: 'cancelled' })
    job.emitter.emit('done')
    return Response.json({ ok: true })
  }

  job.cancelRequested = true

  // If the job is waiting for user approval, reject it so the pipeline resumes and hits checkCancelled
  if (job.pendingApproval) {
    job.pendingApproval.resolve(false)
    job.pendingApproval = null
  }

  return Response.json({ ok: true })
}
