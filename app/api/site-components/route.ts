import { type NextRequest } from 'next/server'
import { listInventory } from '@/lib/inventory'
import { requireCaller } from '@/lib/callerAuth'
import type { UpdateMode } from '@/lib/sites'

export const runtime = 'nodejs'
// Two remote WP-CLI calls at ~13s each. They run in parallel, but the login in
// front of them is serial, so allow real headroom rather than letting the
// platform's default cut a good response off mid-flight.
export const maxDuration = 120

/**
 * A site's full component inventory — everything installed, its version, and
 * whether an update is waiting.
 *
 * WHY A SEPARATE ROUTE FROM /api/site-plugins: that one feeds the exclusion
 * picker and returns `{name, title}` after filtering WordPress components down
 * to active|inactive. Widening it would change the picker's list — must-use
 * plugins and drop-ins would appear as excludable when they cannot be excluded.
 * Both now project from lib/inventory.ts; only this route returns the full set.
 *
 * Gated by requireCaller, so mu-pmu-tool reaches it with MU_ACTION_SECRET and
 * mu-staging's own UI with its session cookie. Note this IS a read behind the
 * gate, unlike the GETs callerAuth's comment lists as deliberately open — it
 * hands back a customer's complete plugin inventory including versions, which
 * is a map of exactly which known vulnerabilities apply to that site.
 */
export async function GET(req: NextRequest) {
  const denied = await requireCaller(req)
  if (denied) return denied

  const site = req.nextUrl.searchParams.get('site')
  const platform = req.nextUrl.searchParams.get('platform')
  const updateMode = req.nextUrl.searchParams.get('update_mode') as UpdateMode | null

  // The same guard /api/site-plugins applies. `site` is interpolated into a
  // shell command, so this is the thing standing between a query string and
  // command execution — keep it a strict allowlist, never a denylist.
  if (!site || !/^[a-zA-Z0-9_-]+$/.test(site)) {
    return Response.json({ error: 'Invalid site' }, { status: 400 })
  }

  try {
    const inventory = await listInventory(site, platform, updateMode)
    return Response.json(inventory, {
      // Let the caller cache; the data changes when a customer's plugin author
      // ships a release, not when someone opens a page.
      headers: { 'cache-control': 'private, max-age=300' },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `Inventory failed: ${msg}` }, { status: 502 })
  }
}
