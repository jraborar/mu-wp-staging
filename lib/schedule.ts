import { type StagingJob, appendLog } from '@/lib/jobStore'
import { addBusinessDays, getManilaToday, manilaNineAM } from '@/lib/timezone'

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

export async function scheduleDeployment(job: StagingJob): Promise<void> {
  const deployUrl = process.env.MU_DEPLOY_URL
  if (!deployUrl) {
    appendLog(job, 'warn', 'MU_DEPLOY_URL not set — skipping auto-schedule')
    return
  }

  const destination  = process.env.MU_DEPLOY_DESTINATION ?? 'live'
  const days         = job.deployDays ?? parseInt(process.env.MU_DEPLOY_SCHEDULE_DAYS ?? '2', 10)
  const targetDate   = addBusinessDays(getManilaToday(), days)
  const scheduledFor = manilaNineAM(targetDate)
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
      appendLog(job, 'success', `Deployment scheduled in mu-deployment — ${job.multidev} → ${destination} on ${scheduledFor.slice(0, 10)} at 9 AM PHT`)
    } else {
      appendLog(job, 'warn', `Deployment schedule request failed (HTTP ${res.status}) — schedule manually in mu-deployment`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(job, 'warn', `Deployment schedule failed: ${msg} — schedule manually in mu-deployment`)
  }
}
