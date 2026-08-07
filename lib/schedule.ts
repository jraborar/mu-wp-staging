import { type StagingJob, appendLog } from '@/lib/jobStore'
import { addBusinessDays, getManilaToday, manilaThreePM, formatAsManilaISO } from '@/lib/timezone'
import { getScheduledDeploymentTimes } from '@/lib/supabase'

function buildNotes(job: StagingJob): string {
  const parts: string[] = ['Auto-scheduled after WP staging.']

  if (job.upstreamUpdated) parts.push('Upstream updated.')
  if (job.upstreamConflict) parts.push('Upstream skipped (conflict).')

  const pCount = job.plugins.updated.length
  const sCount = job.plugins.skipped.length
  if (pCount > 0) parts.push(`${pCount} plugin${pCount !== 1 ? 's' : ''} updated.`)
  if (sCount > 0) parts.push(`${sCount} plugin${sCount !== 1 ? 's' : ''} skipped.`)

  const tCount = job.themes.updated.length
  if (tCount > 0) parts.push(`${tCount} theme${tCount !== 1 ? 's' : ''} updated.`)

  return parts.join(' ')
}

// Finds the first free 30-minute slot on targetDate at or after 15:00 Manila time.
// Checks the shared scheduled_deployments table to avoid booking a taken slot.
async function findNextAvailableSlot(targetDate: Date): Promise<string> {
  const manilaDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(targetDate)
  const existing = await getScheduledDeploymentTimes(manilaDateStr)

  const takenMs  = new Set(existing.map((t) => new Date(t).getTime()))
  const HALF_HR  = 30 * 60 * 1000
  let candidate  = new Date(manilaThreePM(targetDate)) // 15:00 Manila

  while (takenMs.has(candidate.getTime())) {
    candidate = new Date(candidate.getTime() + HALF_HR)
  }

  return formatAsManilaISO(candidate)
}

export async function scheduleDeployment(job: StagingJob): Promise<void> {
  const deployUrl = process.env.MU_DEPLOY_URL
  if (!deployUrl) {
    appendLog(job, 'warn', 'MU_DEPLOY_URL not set — skipping auto-schedule')
    return
  }

  const destination  = job.deployDestination || process.env.MU_DEPLOY_DESTINATION || 'live'
  const days         = job.deployDays ?? parseInt(process.env.MU_DEPLOY_SCHEDULE_DAYS ?? '1', 10)

  const targetDate   = addBusinessDays(getManilaToday(), days)
  const scheduledFor = await findNextAvailableSlot(targetDate)
  const notes        = buildNotes(job)

  try {
    const res = await fetch(`${deployUrl}/api/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site:          job.site,
        source:        job.multidev,
        destination,
        scheduled_for: scheduledFor,
        notes,
        consultant:    'WP Staging',
      }),
    })
    if (res.ok) {
      const timeLabel = scheduledFor.slice(11, 16) // HH:MM
      appendLog(job, 'success', `Deployment scheduled in mu-deployment — ${job.multidev} → ${destination} on ${scheduledFor.slice(0, 10)} at ${timeLabel} PHT`)
    } else {
      appendLog(job, 'warn', `Deployment schedule request failed (HTTP ${res.status}) — schedule manually in mu-deployment`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(job, 'warn', `Deployment schedule failed: ${msg} — schedule manually in mu-deployment`)
  }
}
