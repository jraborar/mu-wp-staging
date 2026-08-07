import { createHmac, timingSafeEqual } from 'crypto'
import { WebClient, type Block, type KnownBlock } from '@slack/web-api'

const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN   ?? ''
const SLACK_CHANNEL_ID  = process.env.SLACK_CHANNEL_ID  ?? ''
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? ''

export function isSlackConfigured(): boolean {
  return Boolean((SLACK_BOT_TOKEN && SLACK_CHANNEL_ID) || SLACK_WEBHOOK_URL)
}

let _web: WebClient | null = null
function getWeb(): WebClient | null {
  if (!SLACK_BOT_TOKEN) return null
  if (!_web) _web = new WebClient(SLACK_BOT_TOKEN)
  return _web
}

const PANTHEON_ICON = 'https://avatars.githubusercontent.com/u/1043537'
const BOT_NAME      = 'Pantheon MU Staging'

async function postSlackMessage(blocks: (Block | KnownBlock)[], text: string): Promise<void> {
  const web = getWeb()
  if (web && SLACK_CHANNEL_ID) {
    try {
      await web.chat.postMessage({
        channel: SLACK_CHANNEL_ID, text, blocks,
        username: BOT_NAME, icon_url: PANTHEON_ICON,
      })
    } catch (err) {
      console.error('[slack] postMessage (web api) failed:', err)
    }
    return
  }
  if (SLACK_WEBHOOK_URL) {
    try {
      const res = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, blocks, username: BOT_NAME, icon_url: PANTHEON_ICON }),
      })
      if (!res.ok) console.error('[slack] postMessage (webhook) failed:', res.status, await res.text())
    } catch (err) {
      console.error('[slack] postMessage (webhook) failed:', err)
    }
  }
}

const PUMBLE_WEBHOOK_URL = process.env.PUMBLE_WEBHOOK_URL ?? ''

export function isPumbleConfigured(): boolean {
  return Boolean(PUMBLE_WEBHOOK_URL)
}

async function postPumbleMessage(blocks: (Block | KnownBlock)[], text: string): Promise<void> {
  try {
    const res = await fetch(PUMBLE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, blocks, username: BOT_NAME, icon_url: PANTHEON_ICON }),
    })
    if (!res.ok) console.error('[pumble] postMessage failed:', res.status, await res.text())
  } catch (err) {
    console.error('[pumble] postMessage failed:', err)
  }
}

export async function startStagingThread(site: string, multidev: string, siteId?: string): Promise<string | null> {
  const text   = `🔧 Staging started on ${site} (${multidev})`
  const blocks = buildStartedBlocks(site, multidev, siteId)
  void postPumbleMessage(blocks, text)
  const web = getWeb()
  if (web && SLACK_CHANNEL_ID) {
    try {
      const result = await web.chat.postMessage({
        channel: SLACK_CHANNEL_ID, text, blocks,
        username: BOT_NAME, icon_url: PANTHEON_ICON,
      })
      return (result.ts as string) ?? null
    } catch (err) { console.error('[slack] startStagingThread failed:', err) }
  } else if (SLACK_WEBHOOK_URL) {
    void postSlackMessage(blocks, text)
  }
  return null
}

export async function postThreadBlocks(threadTs: string | null, blocks: (Block | KnownBlock)[], text: string): Promise<void> {
  if (!threadTs) return
  const web = getWeb()
  if (!web || !SLACK_CHANNEL_ID) return
  try {
    await web.chat.postMessage({
      channel: SLACK_CHANNEL_ID, thread_ts: threadTs, text, blocks,
      username: BOT_NAME, icon_url: PANTHEON_ICON,
    })
  } catch (err) { console.error('[slack] postThreadBlocks failed:', err) }
}

export async function postThreadStep(threadTs: string | null, message: string): Promise<void> {
  if (!threadTs) return
  const web = getWeb()
  if (!web || !SLACK_CHANNEL_ID) return
  try {
    await web.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      thread_ts: threadTs,
      text: message,
      username: BOT_NAME,
      icon_url: PANTHEON_ICON,
    })
  } catch (err) { console.error('[slack] postThreadStep failed:', err) }
}

export async function broadcastMessage(blocks: (Block | KnownBlock)[], text: string): Promise<void> {
  await Promise.all([
    isSlackConfigured()  ? postSlackMessage(blocks, text)  : Promise.resolve(),
    isPumbleConfigured() ? postPumbleMessage(blocks, text) : Promise.resolve(),
  ])
}

export function verifySignature(rawBody: string, timestamp: string, signature: string, secret: string): boolean {
  if (!secret) return false
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (age > 300) return false
  const hmac     = createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')
  const computed = Buffer.from(`v0=${hmac}`)
  const received = Buffer.from(signature)
  if (computed.length !== received.length) return false
  return timingSafeEqual(computed, received)
}

function formatSite(name: string, siteId?: string): string {
  return siteId && siteId !== name ? `${name} (\`${siteId}\`)` : `\`${name}\``
}

export function buildStartedBlocks(site: string, multidev: string, siteId?: string): (Block | KnownBlock)[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `🔧 *Staging started*\n${formatSite(site, siteId)} · multidev \`${multidev}\``,
    },
  }]
}

export function buildApprovalBlocks(
  jobId: string,
  message: string,
  approveLabel: string,
  rejectLabel: string,
): (Block | KnownBlock)[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `◈ *Approval required*\n${message}` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: approveLabel, emoji: true },
          style: 'primary',
          value: JSON.stringify({ jobId, approved: true }),
          action_id: 'staging_approve',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: rejectLabel, emoji: true },
          style: 'danger',
          value: JSON.stringify({ jobId, approved: false }),
          action_id: 'staging_reject',
        },
      ],
    },
  ]
}

export function buildCompleteBlocks(site: string, multidev: string, pluginsUpdated: number, themesUpdated: number, siteId?: string): (Block | KnownBlock)[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `✅ *Staging complete*\n${formatSite(site, siteId)} · \`${multidev}\`\n${pluginsUpdated} plugin(s) updated · ${themesUpdated} theme(s) updated`,
    },
  }]
}

export function buildFailedBlocks(site: string, multidev: string, reason: string, siteId?: string): (Block | KnownBlock)[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `❌ *Staging failed*\n${formatSite(site, siteId)} · \`${multidev}\`\n${reason}`,
    },
  }]
}

export function buildPausedBlocks(site: string, multidev: string, pausedAt: string, siteId?: string): (Block | KnownBlock)[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `⏸ *Staging paused*\n${formatSite(site, siteId)} · \`${multidev}\`\nPaused at: ${pausedAt} — resume from the console when ready.`,
    },
  }]
}

export function buildCancelledBlocks(site: string, multidev: string, reason: string, siteId?: string): (Block | KnownBlock)[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `🚫 *Staging cancelled*\n${formatSite(site, siteId)} · \`${multidev}\`\n${reason}`,
    },
  }]
}

export function buildLongRunningBlocks(site: string, multidev: string, elapsedMin: number, stepName: string, siteId?: string): (Block | KnownBlock)[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `⏱ *Staging running longer than usual*\n${formatSite(site, siteId)} · \`${multidev}\`\nCurrent step: ${stepName} · ${elapsedMin} min elapsed`,
    },
  }]
}

export function buildScheduledBlocks(site: string, scheduledFor: string, cadence: string, siteId?: string): (Block | KnownBlock)[] {
  const dt = new Date(scheduledFor).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' })
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `📅 *Staging scheduled*\n${formatSite(site, siteId)}\n${dt} (Manila) · ${cadence}`,
    },
  }]
}
