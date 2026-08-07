import { type NextRequest } from 'next/server'
import { listSchedules, createSchedule, type Cadence } from '@/lib/scheduleStore'
import { computeNextOccurrence } from '@/lib/scheduler'

export const runtime = 'nodejs'

export async function GET() {
  const schedules = await listSchedules()
  const now = new Date()
  const withNext = schedules.map(s => ({
    ...s,
    next_staging_at: s.next_staging_at ?? computeNextOccurrence(s, now)?.toISOString() ?? null,
  }))
  return Response.json(withNext)
}

const VALID_CADENCES: Cadence[] = ['weekly', 'biweekly', 'monthly', 'bimonthly-week-of-15', 'security-only']

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

  const { site, cadence, day_of_week, week_of_month, biweekly_reference_date,
          bimonthly_ref_month, bimonthly_day_of_week, security_check_enabled,
          skip_upstream, skip_plugins_themes } = body

  if (!site || typeof site !== 'string') {
    return Response.json({ error: 'site is required' }, { status: 400 })
  }
  if (!cadence || !VALID_CADENCES.includes(cadence)) {
    return Response.json({ error: `cadence must be one of: ${VALID_CADENCES.join(', ')}` }, { status: 400 })
  }

  const record = await createSchedule({
    site,
    cadence,
    day_of_week: day_of_week ?? undefined,
    week_of_month: week_of_month ?? undefined,
    biweekly_reference_date: biweekly_reference_date ?? undefined,
    bimonthly_ref_month: bimonthly_ref_month ?? undefined,
    bimonthly_day_of_week: bimonthly_day_of_week ?? undefined,
    security_check_enabled: security_check_enabled ?? cadence === 'bimonthly-week-of-15',
    skip_upstream: skip_upstream ?? false,
    skip_plugins_themes: skip_plugins_themes ?? false,
    active: true,
    next_staging_at: computeNextOccurrence({ cadence, day_of_week, week_of_month, biweekly_reference_date, bimonthly_ref_month, bimonthly_day_of_week } as never, new Date())?.toISOString(),
  })

  if (!record) return Response.json({ error: 'Failed to create schedule' }, { status: 500 })
  return Response.json(record, { status: 201 })
}
