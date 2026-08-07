import { getJob } from '@/lib/jobStore'

let started = false

export async function startSocketMode(): Promise<void> {
  if (started) return
  started = true

  const appToken  = process.env.SLACK_APP_TOKEN
  const botToken  = process.env.SLACK_BOT_TOKEN
  const channelId = process.env.SLACK_CHANNEL_ID

  if (!appToken || !botToken || !channelId) {
    const missing = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID'].filter(k => !process.env[k])
    console.log(`[slack] Socket Mode skipped — missing env var(s): ${missing.join(', ')}`)
    started = false
    return
  }

  try {
    const { SocketModeClient } = await import('@slack/socket-mode')
    const socket = new SocketModeClient({ appToken, logLevel: 'warn' as never })

    socket.on('block_actions', async ({ event, ack }) => {
      await ack()
      const action = (event.actions as Array<{ value?: string }> | undefined)?.[0]
      if (!action?.value) return

      let parsed: { jobId?: string; approved?: boolean }
      try { parsed = JSON.parse(action.value) } catch { return }

      const { jobId, approved } = parsed
      if (!jobId) return

      const job = getJob(jobId)
      if (!job?.pendingApproval) {
        console.log(`[slack] Interaction for unknown or already-resolved job: ${jobId}`)
        return
      }
      job.pendingApproval.resolve(Boolean(approved))
      job.pendingApproval = null
      job.status = 'running'
      console.log(`[slack] Job ${jobId} ${approved ? 'approved' : 'rejected'} via Slack`)
    })

    socket.on('error', (err) => { console.error('[slack] Socket Mode error:', err) })

    await socket.start()
    console.log('[slack] Socket Mode client connected')
  } catch (err) {
    console.error('[slack] Failed to start Socket Mode client:', err)
    started = false
  }
}
