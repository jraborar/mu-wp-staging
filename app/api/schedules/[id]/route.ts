import { type NextRequest } from 'next/server'
import { getSchedule, updateSchedule, deleteSchedule } from '@/lib/scheduleStore'
import { computeNextOccurrence } from '@/lib/scheduler'

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
  const next = computeNextOccurrence(merged, new Date())
  const updated = await updateSchedule(id, { ...body, next_staging_at: next?.toISOString() ?? null })
  if (!updated) return Response.json({ error: 'Update failed' }, { status: 500 })
  return Response.json(updated)
}

// PATCH — lightweight updates from the Upcoming tab:
//   { next_staging_at }            → override next occurrence only
//   { next_staging_at, shift_reference: true } → also shift cadence reference so all future occurrences move
//   { skip_next: true }            → advance next_staging_at past current to skip this occurrence
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

  const existing = await getSchedule(id)
  if (!existing) return Response.json({ error: 'Not found' }, { status: 404 })

  if (body.skip_next) {
    // Advance next_staging_at past the current occurrence so scheduler skips it
    const cursor = existing.next_staging_at ? new Date(existing.next_staging_at) : new Date()
    const next   = computeNextOccurrence(existing, cursor)
    const updated = await updateSchedule(id, { next_staging_at: next?.toISOString() ?? undefined })
    return Response.json(updated ?? { error: 'Update failed' })
  }

  if (body.next_staging_at) {
    const patch: Record<string, unknown> = { next_staging_at: body.next_staging_at }

    if (body.shift_reference) {
      // Shift the cadence reference date to match the new time so all future occurrences align
      const newDate = new Date(body.next_staging_at)
      if (existing.cadence === 'biweekly' || existing.cadence === 'weekly') {
        patch.biweekly_reference_date = newDate.toISOString().slice(0, 10)
      }
    }

    const updated = await updateSchedule(id, patch)
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
