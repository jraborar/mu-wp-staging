import { type NextRequest } from 'next/server'
import { listSchedules, createSchedule, type Cadence } from '@/lib/scheduleStore'
import { computeNextOccurrence } from '@/lib/cadence'
import { listSites, getSite } from '@/lib/sites'

export const runtime = 'nodejs'

export async function GET() {
  const [schedules, sites] = await Promise.all([listSchedules(), listSites()])
  const now = new Date()
  // Registry is the source of truth for friendly name + machine name (schedule rows
  // carry neither; site key is the UUID) and for the cadence anchor.
  const bySite = new Map(sites.map(s => [s.site, s]))
  const withNext = schedules.map(s => {
    const site = bySite.get(s.site)
    // Recompute rather than trust the stored projection — the anchor moves whenever a
    // cycle completes, so a stored next_staging_at can be a cycle out of date.
    const projected = s.cadence === 'once'
      ? s.next_staging_at ?? null
      : s.override_at ?? computeNextOccurrence(s, now, site?.last_deployment)?.toISOString() ?? null
    return {
      ...s,
      site_name: site?.site_name ?? s.site_name,
      machine_name: site?.machine_name ?? null,
      next_staging_at: projected,
    }
  })
  return Response.json(withNext)
}

const VALID_CADENCES: Cadence[] = ['weekly', 'biweekly', 'monthly', 'bimonthly-week-of-15', 'security-only', 'once']

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

  const { site, cadence, day_of_week, week_of_month, biweekly_reference_date,
          bimonthly_ref_month, bimonthly_day_of_week, security_check_enabled,
          skip_upstream, skip_plugins_themes, deploy_days, deploy_destination,
          scheduled_for } = body

  if (!site || typeof site !== 'string') {
    return Response.json({ error: 'site is required' }, { status: 400 })
  }
  if (!cadence || !VALID_CADENCES.includes(cadence)) {
    return Response.json({ error: `cadence must be one of: ${VALID_CADENCES.join(', ')}` }, { status: 400 })
  }
  if (cadence === 'once' && !scheduled_for) {
    return Response.json({ error: 'scheduled_for is required for a one-off (once) schedule' }, { status: 400 })
  }

  // 'once' fires at the explicit datetime; recurring cadences project the next
  // occurrence off the site's cadence anchor (`sites.last_deployment`). Note this is
  // display only — if the current ISO week is already on-parity and its slot has
  // passed, the scheduler fires on the next tick (run-now) rather than waiting for
  // the projected date.
  const anchor = (await getSite(site))?.last_deployment
  const nextStagingAt = cadence === 'once'
    ? new Date(scheduled_for).toISOString()
    : computeNextOccurrence(
        { cadence, day_of_week, week_of_month, biweekly_reference_date, bimonthly_ref_month, bimonthly_day_of_week, created_at: new Date().toISOString() } as never,
        new Date(),
        anchor,
      )?.toISOString()

  const record = await createSchedule({
    site,
    cadence,
    day_of_week: day_of_week ?? undefined,
    week_of_month: week_of_month ?? undefined,
    biweekly_reference_date: biweekly_reference_date ?? undefined,
    bimonthly_ref_month: bimonthly_ref_month ?? undefined,
    bimonthly_day_of_week: bimonthly_day_of_week ?? undefined,
    security_check_enabled: security_check_enabled ?? ['bimonthly-week-of-15', 'security-only'].includes(cadence),
    security_check_pending: false,
    deploy_days: deploy_days ?? undefined,
    deploy_destination: deploy_destination ?? undefined,
    skip_upstream: skip_upstream ?? false,
    skip_plugins_themes: skip_plugins_themes ?? false,
    active: true,
    next_staging_at: nextStagingAt,
  })

  if (!record) return Response.json({ error: 'Failed to create schedule' }, { status: 500 })
  return Response.json(record, { status: 201 })
}
