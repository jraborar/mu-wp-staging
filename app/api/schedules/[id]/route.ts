import { type NextRequest } from 'next/server'
import { getSchedule, updateSchedule, deleteSchedule } from '@/lib/scheduleStore'
import { computeNextOccurrence, isoWeekMondayStr, manilaDayOfWeek } from '@/lib/cadence'
import { getSite } from '@/lib/sites'

export const runtime = 'nodejs'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const schedule = await getSchedule(id)
  if (!schedule) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json(schedule)
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

  // Recompute next_staging_at if scheduling fields changed
  const existing = await getSchedule(id)
  if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

  const merged = { ...existing, ...body }
  const site = await getSite(existing.site)
  const next = computeNextOccurrence(merged, new Date(), site?.last_deployment)
  const updated = await updateSchedule(id, { ...body, next_staging_at: next?.toISOString() ?? null })
  if (!updated) return Response.json({ error: 'Update failed' }, { status: 500 })
  return Response.json(updated)
}

// PATCH — lightweight updates from the Upcoming tab. Due-ness is computed from the
// cadence + the site's last_deployment anchor, so overriding it means writing an
// explicit marker, not nudging next_staging_at (which is only a projection now):
//   { next_staging_at }                        → pin THIS occurrence (override_at)
//   { next_staging_at, shift_reference: true } → move the cadence itself (weekday + parity)
//   { skip_next: true, occurrence_at? }        → skip that occurrence's ISO week (skip_week)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

  const existing = await getSchedule(id)
  if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })
  const site = await getSite(existing.site)

  if (body.skip_next) {
    // Mark the target ISO week skipped. Parity is untouched, so the cycle resumes on
    // its next on-parity week — a skip costs one occurrence, not the cadence.
    const target = body.occurrence_at ? new Date(body.occurrence_at)
                 : existing.next_staging_at ? new Date(existing.next_staging_at)
                 : new Date()
    const next = computeNextOccurrence(existing, target, site?.last_deployment)
    const updated = await updateSchedule(id, {
      skip_week: isoWeekMondayStr(target),
      override_at: null,
      next_staging_at: next?.toISOString() ?? undefined,
    })
    return Response.json(updated ?? { error: 'Update failed' })
  }

  if (body.next_staging_at) {
    const newDate = new Date(body.next_staging_at)

    if (body.shift_reference) {
      // Move the cadence itself: the weekday comes from the new datetime, and the
      // reference date re-parities the week. parityAnchor() takes the later of
      // reference vs. last_deployment, so a forward shift wins until the next
      // completed run catches up to it.
      const patch: Record<string, unknown> = { next_staging_at: body.next_staging_at, override_at: null }
      if (existing.cadence === 'biweekly' || existing.cadence === 'weekly') {
        patch.day_of_week = manilaDayOfWeek(newDate)
        patch.biweekly_reference_date = isoWeekMondayStr(newDate)
      }
      const updated = await updateSchedule(id, patch)
      if (!updated) return Response.json({ error: 'Update failed' }, { status: 500 })
      return Response.json(updated)
    }

    // This occurrence only — an explicit pin, cleared once it fires.
    const updated = await updateSchedule(id, {
      override_at: newDate.toISOString(),
      next_staging_at: body.next_staging_at,
    })
    if (!updated) return Response.json({ error: 'Update failed' }, { status: 500 })
    return Response.json(updated)
  }

  return Response.json({ error: 'Nothing to update' }, { status: 400 })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  await deleteSchedule(id)
  return Response.json({ ok: true })
}
