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

function isDrupalIC(platform: string | null, upstream: string | null): boolean {
  if (platform !== 'drupal') return false
  const up = (upstream ?? '').toLowerCase()
  return !up.includes('drops-7') && !up.includes('drops-8')
}

function isDrupalDrops(platform: string | null, upstream: string | null): boolean {
  if (platform !== 'drupal') return false
  const up = (upstream ?? '').toLowerCase()
  return up.includes('drops-7') || up.includes('drops-8')
}

// Parse `drush pm-list --format=json` output into {name, title}[].
// D7 (drush 8): JSON array of objects with name/display_name/type keys.
// D8+ (drush 9+): JSON object keyed by machine name with nested name/status keys.
function parseDrushPmList(raw: string): { name: string; title: string }[] {
  try {
    const parsed = JSON.parse(cleanJson(raw))
    if (Array.isArray(parsed)) {
      return parsed.map((p: Record<string, string>) => ({
        name: p.name ?? '',
        title: p.display_name ?? p.title ?? p.name ?? '',
      })).filter(p => p.name)
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return Object.entries(parsed).map(([key, val]) => {
        const v = val as Record<string, string>
        return { name: key, title: v.name ?? v.title ?? key }
      })
    }
  } catch {}
  return []
}

export async function GET(req: NextRequest) {
  const site     = req.nextUrl.searchParams.get('site')
  const platform = req.nextUrl.searchParams.get('platform')
  const upstream = req.nextUrl.searchParams.get('upstream')

  if (!site || !/^[a-zA-Z0-9_-]+$/.test(site)) {
    return Response.json({ error: 'Invalid site' }, { status: 400 })
  }

  const token = process.env.TERMINUS_TOKEN
  if (token) await run(`terminus auth:login --machine-token="${token}" 2>&1`)

  // IC Drupal: exclusions are managed by Composer, not by this tool.
  if (isDrupalIC(platform, upstream)) {
    return Response.json({ plugins: [], themes: [], ic: true })
  }

  // Drops7 / drops8 Drupal: list contrib modules and themes via drush.
  if (isDrupalDrops(platform, upstream)) {
    const [modRes, themeRes] = await Promise.all([
      run(`terminus drush ${site}.live -- pm-list --type=module --no-core --format=json 2>&1`),
      run(`terminus drush ${site}.live -- pm-list --type=theme --format=json 2>&1`),
    ])
    return Response.json({
      plugins: parseDrushPmList(modRes.stdout),
      themes:  parseDrushPmList(themeRes.stdout),
    })
  }

  // WordPress: existing wp-cli behaviour.
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
