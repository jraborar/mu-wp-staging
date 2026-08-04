import { type NextRequest } from 'next/server'
import { createJob, getJob, type StagingJob } from '@/lib/jobStore'
import { executeJob } from '@/lib/staging'

export const runtime = 'nodejs'

const SITE_RE     = /^[a-zA-Z0-9_-]+$/
const MULTIDEV_RE = /^[a-z0-9][a-z0-9-]{0,10}$/

function streamJob(job: StagingJob, request: NextRequest): Response {
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {}
      }

      // Flush buffered logs for reconnect
      for (const entry of job.logs) send(entry)

      if (['completed', 'failed'].includes(job.status)) {
        send({ type: 'complete', status: job.status })
        controller.close()
        return
      }

      const onEvent = (data: object) => send(data)
      const onDone  = () => { try { controller.close() } catch {} }

      job.emitter.on('event', onEvent)
      job.emitter.once('done', onDone)

      const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 5000)

      const cleanup = () => {
        clearInterval(heartbeat)
        job.emitter.off('event', onEvent)
        job.emitter.off('done', onDone)
      }

      request.signal.addEventListener('abort', cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Job-Id':          job.id,
    },
  })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

  const { site, multidev } = body as Record<string, string>

  if (!site || !SITE_RE.test(site)) {
    return Response.json({ error: 'Invalid or missing site ID' }, { status: 400 })
  }
  if (!multidev || !MULTIDEV_RE.test(multidev)) {
    return Response.json({ error: 'Invalid or missing multidev name' }, { status: 400 })
  }

  const job = createJob(site, multidev)
  void executeJob(job)
  return streamJob(job, request)
}

// Resume SSE stream for an existing job
export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get('jobId')
  if (!jobId) return Response.json({ error: 'Missing jobId' }, { status: 400 })
  const job = getJob(jobId)
  if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })
  return streamJob(job, request)
}
