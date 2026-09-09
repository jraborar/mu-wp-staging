import { type NextRequest } from 'next/server'
import { listInventory, type ComponentKind } from '@/lib/inventory'
import { requireCaller } from '@/lib/callerAuth'
import { isDropsUpdateMode } from '@/lib/platform'
import type { UpdateMode } from '@/lib/sites'

export const runtime = 'nodejs'

/**
 * Components a site's exclusion picker can offer, as `{name, title}`.
 *
 * The listing itself moved to lib/inventory.ts, which /api/site-components also
 * uses — one place now knows how to ask Pantheon what is installed, instead of
 * two copies of the drush-JSON-shape handling drifting apart.
 *
 * THE OUTPUT SHAPE HERE IS DELIBERATELY UNCHANGED. No versions, no update
 * state, and WordPress components still filtered to active|inactive: must-use
 * plugins and drop-ins cannot be excluded from an update run, so listing them
 * would offer a control that does nothing. Read the full inventory from
 * /api/site-components.
 */

// Kept keyed on update_mode rather than a substring of the upstream string —
// see isDropsUpdateMode. `platform` still gates it, so a WordPress site with
// any update_mode is never treated as Composer-managed.
function isDrupalIC(platform: string | null, updateMode: UpdateMode | null): boolean {
  return platform === 'drupal' && !isDropsUpdateMode(updateMode)
}

export async function GET(req: NextRequest) {
  const denied = await requireCaller(req)
  if (denied) return denied

  const site       = req.nextUrl.searchParams.get('site')
  const platform   = req.nextUrl.searchParams.get('platform')
  const updateMode = req.nextUrl.searchParams.get('update_mode') as UpdateMode | null

  if (!site || !/^[a-zA-Z0-9_-]+$/.test(site)) {
    return Response.json({ error: 'Invalid site' }, { status: 400 })
  }

  // IC Drupal answers with the `ic` marker its caller already branches on.
  // Checked before the inventory call so it still costs no Terminus round trip.
  if (isDrupalIC(platform, updateMode)) {
    return Response.json({ plugins: [], themes: [], ic: true })
  }

  const inventory = await listInventory(site, platform, updateMode)

  // Drupal modules land in `plugins`, which is what this endpoint has always
  // called the first list — the picker keys off position, not vocabulary.
  const project = (kinds: ComponentKind[], filterInactive: boolean) =>
    inventory.components
      .filter((c) => kinds.includes(c.kind))
      .filter((c) => !filterInactive || c.status === 'active' || c.status === 'inactive')
      .map((c) => ({ name: c.name, title: c.title }))

  return Response.json({
    plugins: project(['plugin', 'module'], inventory.source === 'wp-cli'),
    themes:  project(['theme'], false),
  })
}
