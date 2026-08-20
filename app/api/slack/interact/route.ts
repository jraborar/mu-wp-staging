import { type NextRequest } from 'next/server'
import { getJob } from '@/lib/jobStore'
import { verifySignature } from '@/lib/slack'

export const runtime = 'nodejs'

// Slack Interactivity endpoint — handles Approve/Reject button clicks on the
// staging approval message (action_ids staging_approve/staging_reject; the button
// `value` carries {jobId, approved}). Point the Slack app's "Interactivity &
// Shortcuts → Request URL" at /api/slack/interact. Verifies with SLACK_SIGNING_SECRET.
export async function POST(request: NextRequest) {
  const rawBody   = await request.text()
  const timestamp = request.headers.get('x-slack-request-timestamp') ?? ''
  const signature = request.headers.get('x-slack-signature') ?? ''
  const secret    = process.env.SLACK_SIGNING_SECRET ?? ''

  if (secret && !verifySignature(rawBody, timestamp, signature, secret)) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Slack sends interactions URL-encoded: payload=<json>
  const params  = new URLSearchParams(rawBody)
  const payload = JSON.parse(params.get('payload') ?? '{}')

  const action = payload?.actions?.[0]
  if (!action?.value) return new Response('OK', { status: 200 })

  let parsed: { jobId?: string; approved?: boolean }
  try {
    parsed = JSON.parse(action.value)
  } catch {
    return new Response('OK', { status: 200 })
  }

  const { jobId, approved } = parsed
  if (!jobId) return new Response('OK', { status: 200 })

  const job = getJob(jobId)
  if (!job?.pendingApproval) {
    // Already resolved, expired on redeploy, or handled in-app — ack so Slack doesn't retry.
    return new Response('OK', { status: 200 })
  }

  job.pendingApproval.resolve(Boolean(approved))
  job.pendingApproval = null
  console.log(`[slack] Job ${jobId} ${approved ? 'approved' : 'rejected'} via Slack button`)

  return new Response('OK', { status: 200 })
}
