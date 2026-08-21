import { type NextRequest } from 'next/server'
import { createJob, getJob, type StagingJob } from '@/lib/jobStore'
import { executeJob } from '@/lib/staging'
import { getPacificYYMMDD } from '@/lib/timezone'

export const runtime = 'nodejs'

const SITE_RE = /^[a-zA-Z0-9_-]+$/

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

      if (['completed', 'failed', 'cancelled', 'paused'].includes(job.status)) {
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

  const { site, multidev: multidevOverride, testMode, skipUpstream, skipPluginsThemes,
          securityFastTrack, deployDays, deployDestination } = body as Record<string, unknown>

  if (!site || typeof site !== 'string' || !SITE_RE.test(site)) {
    return Response.json({ error: 'Invalid or missing site ID' }, { status: 400 })
  }

  // Test mode: append -t to today's date → mu-YYMMDD-t (never collides with production mu-YYMMDD)
  // Custom override: explicit multidev name for ad-hoc runs
  // Default: standard mu-YYMMDD
  const dateStr = getPacificYYMMDD()
  const multidev = testMode
    ? `mu-${dateStr}-t`
    : (typeof multidevOverride === 'string' && /^[a-z0-9-]{1,11}$/.test(multidevOverride))
      ? multidevOverride
      : `mu-${dateStr}`
  // An out-of-band security/core patch is NOT a managed-cycle run: it deploys on
  // the site's security_deploy_hours window (24h) instead of the relative one, and
  // it must NOT advance sites.last_deployment — otherwise a hand-run security patch
  // drags the whole staging cadence forward. Both behaviours hang off this flag
  // (lib/schedule.ts isFastTrack, lib/staging.ts anchor advance), which until now
  // only the automatic upstream scan could set. Upstream-only is implied: applying
  // plugins/themes would make it a regular run wearing a fast-track badge.
  const fastTrack = Boolean(securityFastTrack)
  const job = createJob(site, multidev, {
    skipUpstream: Boolean(skipUpstream),
    skipPluginsThemes: fastTrack ? true : Boolean(skipPluginsThemes),
    securityFastTrack: fastTrack,
    deployDays: typeof deployDays === 'number' ? deployDays : undefined,
    deployDestination: typeof deployDestination === 'string' ? deployDestination : undefined,
  })
  void executeJob(job)
  return streamJob(job, request)
}

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get('jobId')
  if (!jobId) return Response.json({ error: 'Missing jobId' }, { status: 400 })
  const job = getJob(jobId)
  if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })
  return streamJob(job, request)
}
