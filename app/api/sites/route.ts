import { type NextRequest } from 'next/server'
import { listSites, registerSite } from '@/lib/sites'
import { requireCaller } from '@/lib/callerAuth'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const denied = await requireCaller(request)
  if (denied) return denied

  const sites = await listSites()
  return Response.json(sites)
}

export async function POST(request: NextRequest) {
  const denied = await requireCaller(request)
  if (denied) return denied

  const body = await request.json().catch(() => null)
  if (!body || typeof body.site !== 'string' || !body.site.trim()) {
    return Response.json({ error: 'Missing site machine-name' }, { status: 400 })
  }
  try {
    const site = await registerSite(body)
    if (!site) return Response.json({ error: 'Registry not configured' }, { status: 503 })
    return Response.json(site)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: msg }, { status: 400 })
  }
}
