import { type NextRequest } from 'next/server'
import { run, cleanJson } from '@/lib/terminus'
import { parseWpJson } from '@/lib/wordpress'

export const runtime = 'nodejs'

interface WpPlugin {
  name: string
  title?: string
  status: string
  version: string
}

// Fetches ALL plugins (not just those with updates) from the site's live environment
// so the user can configure skip preferences before updates are available.
export async function GET(req: NextRequest) {
  const site = req.nextUrl.searchParams.get('site')
  if (!site || !/^[a-zA-Z0-9_-]+$/.test(site)) {
    return Response.json({ error: 'Invalid site' }, { status: 400 })
  }

  const token = process.env.TERMINUS_TOKEN
  if (token) await run(`terminus auth:login --machine-token="${token}" 2>&1`)

  const [pluginRes, themeRes] = await Promise.all([
    run(`terminus wp ${site}.live -- plugin list --format=json --fields=name,title,status 2>&1`),
    run(`terminus wp ${site}.live -- theme list --format=json --fields=name,title,status 2>&1`),
  ])

  const plugins = parseWpJson<WpPlugin>(cleanJson(pluginRes.stdout))
    .filter(p => p.status === 'active' || p.status === 'inactive')
    .map(p => ({ name: p.name, title: p.title || p.name }))

  const themes = parseWpJson<WpPlugin>(cleanJson(themeRes.stdout))
    .map(t => ({ name: t.name, title: t.title || t.name }))

  return Response.json({ plugins, themes })
}
