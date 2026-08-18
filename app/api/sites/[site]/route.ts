import { type NextRequest } from 'next/server'
import { getSite, updateSite, deleteSite } from '@/lib/sites'

export const runtime = 'nodejs'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ site: string }> },
) {
  const { site } = await params
  const s = await getSite(decodeURIComponent(site))
  if (!s) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json(s)
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ site: string }> },
) {
  const { site } = await params
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  try {
    const updated = await updateSite(decodeURIComponent(site), body)
    if (!updated) return Response.json({ error: 'Update failed' }, { status: 500 })
    return Response.json(updated)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: msg }, { status: 400 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ site: string }> },
) {
  const { site } = await params
  await deleteSite(decodeURIComponent(site))
  return Response.json({ ok: true })
}
