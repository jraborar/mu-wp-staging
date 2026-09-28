import { type NextRequest } from 'next/server'
import { getJob } from '@/lib/jobStore'
import { requireCaller } from '@/lib/callerAuth'

export const runtime = 'nodejs'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const denied = await requireCaller(request)
  if (denied) return denied

  const { jobId } = await params
  const job = getJob(jobId)
  if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })

  if (!['running', 'awaiting-approval', 'paused'].includes(job.status)) {
    return Response.json({ error: 'Job is not cancellable' }, { status: 409 })
  }

  // Force-cancel immediately when there is no pipeline to signal:
  //   - paused jobs, which have already unwound; and
  //   - jobs whose pipeline never entered its try/catch, so nothing will ever read
  //     `cancelRequested`. Setting the flag on one of those was a silent no-op — the
  //     Live card stayed stuck at 'running' and Cancel did nothing, every time.
  if (job.status === 'paused' || !job.pipelineStarted) {
    // Also raise the flag: a job cancelled in the narrow window between createJob and
    // the pipeline's try must still unwind at its first checkCancelled rather than run
    // on behind a UI that says cancelled.
    job.cancelRequested = true
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
