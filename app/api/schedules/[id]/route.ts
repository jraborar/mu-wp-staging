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

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  await deleteSchedule(id)
  return Response.json({ ok: true })
}
