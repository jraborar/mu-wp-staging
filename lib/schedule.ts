import { type StagingJob, appendLog } from '@/lib/jobStore'
import { addBusinessDays, getManilaToday, manilaThreePM, formatAsManilaISO } from '@/lib/timezone'
import { getScheduledDeploymentTimes } from '@/lib/supabase'
import { getSite } from '@/lib/sites'

// Credentials for every call this app makes to mu-deployment — reads included.
//
// The mutating calls (pre-book, confirm, cancel) were authenticated first, in
// #223, when mu-deployment's write routes were gated. Its READS were left bare
// then, on the grounds that `GET /api/schedule` was staying open. That is no
// longer the plan: mu-deployment's open GETs hand out the whole customer
// registry — `/api/sites` alone returns all 27 sites with platform, PHP version
// and upstream repo — to anyone who can resolve the host.
//
// So `authHeader()` now goes on the reads too. Sent only when MU_ACTION_SECRET
// is present, exactly as mu-pmu-tool's action proxy does, so the two sides roll
// out independently: mu-deployment ignores an unknown header until its read
// gate ships, and once it ships this app is already authenticating.
function authHeader(): Record<string, string> {
  const secret = process.env.MU_ACTION_SECRET
  return secret ? { authorization: `Bearer ${secret}` } : {}
}

function mutateHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', ...authHeader() }
}

// A staging run triggered by the upstream/security auto-scan deploys on the
// fast-track window (now + security_deploy_hours). All runs now use the `mu-`
// multidev name, so this is an explicit job flag rather than a name prefix.
function isFastTrack(job: StagingJob): boolean {
  return job.securityFastTrack === true
}

function buildNotes(job: StagingJob, planned = false): string {
  const parts: string[] = [planned ? 'Planned — staging in progress.' : 'Auto-scheduled after WP staging.']
  if (job.upstreamUpdated) parts.push('Upstream updated.')
  if (job.upstreamConflict) parts.push('Upstream skipped (conflict).')
  const pCount = job.plugins.updated.length
  const sCount = job.plugins.skipped.length
  if (pCount > 0) parts.push(`${pCount} plugin${pCount !== 1 ? 's' : ''} updated.`)
  if (sCount > 0) parts.push(`${sCount} plugin${sCount !== 1 ? 's' : ''} skipped.`)
  const tCount = job.themes.updated.length
  if (tCount > 0) parts.push(`${tCount} theme${tCount !== 1 ? 's' : ''} updated.`)
  if (isFastTrack(job)) parts.push('Security/upstream fast-track.')
  return parts.join(' ')
}

// First free 1-hour slot at or after `base`, avoiding slots already taken that day.
async function findFreeSlot(base: Date): Promise<string> {
  const manilaDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(base)
  const existing = await getScheduledDeploymentTimes(manilaDateStr)
  const takenMs = new Set(existing.map((t) => new Date(t).getTime()))
  const ONE_HR  = 60 * 60 * 1000
  // round up to the top of the hour
  let candidate = new Date(Math.ceil(base.getTime() / ONE_HR) * ONE_HR)
  while (takenMs.has(candidate.getTime())) candidate = new Date(candidate.getTime() + ONE_HR)
  return formatAsManilaISO(candidate)
}

// When should this job's deploy land?
//  - fast-track (security/upstream): now + security_deploy_hours (calendar hours)
//  - normal: staging-day + deploy_days business days, at the 15:00 PHT slot
//
// `siteDeployDays` is the registry value, and it sits between the job and the env
// default for the same reason destination does in prebookDeployment: a manual run
// via POST /api/staging omits deployDays entirely, and a schedule row may carry
// null. Without this the env default won every time — and MU_DEPLOY_SCHEDULE_DAYS
// is '3' in production while 26 of 27 active sites are registered as 1 or 2, so
// nearly every manual run booked the deploy two days late.
//
// `??` and not `||`: deploy_days = 0 means "deploy the same day", which is a real
// setting the API accepts (it validates 0..30). `||` would silently discard it and
// fall through to the env default.
async function computeScheduledFor(
  job: StagingJob,
  securityHours: number,
  siteDeployDays?: number | null,
): Promise<string> {
  if (isFastTrack(job)) {
    return findFreeSlot(new Date(Date.now() + securityHours * 60 * 60 * 1000))
  }
  const days = job.deployDays ?? siteDeployDays ?? parseInt(process.env.MU_DEPLOY_SCHEDULE_DAYS ?? '1', 10)
  const targetDate = addBusinessDays(getManilaToday(), days)
  return findFreeSlot(new Date(manilaThreePM(targetDate)))
}

// Look up a pending deployment in mu-deployment by (site, source multidev).
async function findPendingDeployment(deployUrl: string, site: string, source: string): Promise<string | null> {
  try {
    const res = await fetch(`${deployUrl}/api/schedule`, { cache: 'no-store', headers: authHeader() })
    if (!res.ok) return null
    const rows = await res.json()
    const match = Array.isArray(rows)
      ? rows.find((r) => r.site === site && r.source === source && r.status === 'pending')
      : null
    return match?.id ?? null
  } catch {
    return null
  }
}

// Pre-book the deployment the moment staging starts (source multidev now exists),
// so it's visible/committed without waiting for staging to finish. Reconciled at the end.
export async function prebookDeployment(job: StagingJob): Promise<void> {
  const deployUrl = process.env.MU_DEPLOY_URL
  if (!deployUrl) { appendLog(job, 'warn', 'MU_DEPLOY_URL not set — skipping deploy pre-book'); return }
  if (job.deployDestination === 'multidev') return // stays in multidev, no deploy

  const site = await getSite(job.site)
  const destination = job.deployDestination || site?.deploy_destination || process.env.MU_DEPLOY_DESTINATION || 'live'
  const securityHours = site?.security_deploy_hours ?? 24

  // Idempotent — don't double-book if a pending deploy for this source already exists
  if (await findPendingDeployment(deployUrl, job.site, job.multidev)) return

  const scheduledFor = await computeScheduledFor(job, securityHours, site?.deploy_days)
  const approval = site?.deploy_approval ?? 'manual'
  const notes = `${buildNotes(job, true)} [approval: ${approval}]`

  try {
    const res = await fetch(`${deployUrl}/api/schedule`, {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({ site: job.site, source: job.multidev, destination, scheduled_for: scheduledFor, notes, consultant: 'WP Staging', anchor_advance: !isFastTrack(job) }),
    })
    if (res.ok) {
      appendLog(job, 'info', `Deploy pre-booked — ${job.multidev} → ${destination} on ${scheduledFor.slice(0, 10)} at ${scheduledFor.slice(11, 16)} PHT (pending staging${isFastTrack(job) ? ', fast-track' : ''})`)
    } else {
      appendLog(job, 'warn', `Deploy pre-book failed (HTTP ${res.status}) — schedule manually in mu-deployment`)
    }
  } catch (err) {
    appendLog(job, 'warn', `Deploy pre-book failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// After staging: keep the pre-booked deploy if something changed, else cancel it.
// Also used on failure/cancel to pull the booked deploy.
export async function reconcileDeployment(job: StagingJob, keep: boolean): Promise<void> {
  const deployUrl = process.env.MU_DEPLOY_URL
  if (!deployUrl || job.deployDestination === 'multidev') return

  const id = await findPendingDeployment(deployUrl, job.site, job.multidev)
  if (!id) {
    // No pre-booked row (e.g. pre-book failed) — fall back to booking now if there are changes
    if (keep) await prebookDeployment(job)
    return
  }

  try {
    if (keep) {
      // Confirm: update notes to the final change summary (drop the "planned" prefix)
      const site = await getSite(job.site)
      const approval = site?.deploy_approval ?? 'manual'
      const existing = await (await fetch(`${deployUrl}/api/schedule`, { cache: 'no-store', headers: authHeader() })).json().catch(() => [])
      const row = Array.isArray(existing) ? existing.find((r) => r.id === id) : null
      await fetch(`${deployUrl}/api/schedule`, {
        method: 'PATCH',
        headers: mutateHeaders(),
        body: JSON.stringify({ id, scheduled_for: row?.scheduled_for, notes: `${buildNotes(job, false)} [approval: ${approval}]` }),
      })
      appendLog(job, 'success', `Deployment confirmed for ${job.multidev} — pending in mu-deployment`)
    } else {
      await fetch(`${deployUrl}/api/schedule`, {
        method: 'DELETE',
        headers: mutateHeaders(),
        body: JSON.stringify({ id }),
      })
      appendLog(job, 'info', `Deploy for ${job.multidev} cancelled — nothing to deploy`)
    }
  } catch (err) {
    appendLog(job, 'warn', `Deploy reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Back-compat shim — old call site books at completion (updated runs only).
export async function scheduleDeployment(job: StagingJob): Promise<void> {
  await prebookDeployment(job)
}
