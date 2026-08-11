import { type NextRequest } from 'next/server'
import { getSiteUpdatePrefs, saveSiteUpdatePrefs } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ site: string }> },
) {
  const { site } = await params
  const prefs = await getSiteUpdatePrefs(site)
  return Response.json(prefs ?? { site, plugin_skips: [], theme_skips: [] })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ site: string }> },
) {
  const { site } = await params
  const body = await req.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  const pluginSkips: string[] = Array.isArray(body.plugin_skips) ? body.plugin_skips : []
  const themeSkips:  string[] = Array.isArray(body.theme_skips)  ? body.theme_skips  : []
  await saveSiteUpdatePrefs(site, pluginSkips, themeSkips)
  return Response.json({ ok: true })
}
