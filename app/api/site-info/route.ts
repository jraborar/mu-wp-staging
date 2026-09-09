import { type NextRequest } from 'next/server'
import { run, cleanJson } from '@/lib/terminus'
import { parseSiteFacts } from '@/lib/siteFactsParse'
import { requireCaller } from '@/lib/callerAuth'

export const runtime = 'nodejs'
// One remote call at ~4s, measured. Nothing like the inventory's 15s, but a
// cold container plus a Terminus login still wants headroom.
export const maxDuration = 60

/**
 * What Pantheon knows about a site: its UUID, its label, and the organization
 * that owns it.
 *
 * WHY THIS IS NOT READ FROM THE REGISTRY: `sites` has no organization column,
 * and the organization is per-customer — six sampled sites returned six
 * different UUIDs, so it cannot be derived from anything already stored.
 * `site_uuid` is also absent on 13 of 28 rows, and `id` here is that value.
 *
 * SEPARATE FROM /api/site-components on purpose. That one takes ~15 seconds
 * because it shells into the live environment; this is ~4. The per-site
 * Overview needs these facts and must not wait on a plugin inventory it does
 * not show.
 *
 * Gated by requireCaller. Unlike the inventory this is not especially
 * sensitive — a site UUID is in every dashboard URL — but it does name the
 * customer and their plan, and there is no reason for it to be the one open
 * route.
 */
export async function GET(req: NextRequest) {
  const denied = await requireCaller(req)
  if (denied) return denied

  const site = req.nextUrl.searchParams.get('site')
  // Interpolated into a shell command, so this is the guard between a query
  // string and command execution. Strict allowlist, never a denylist.
  if (!site || !/^[a-zA-Z0-9_-]+$/.test(site)) {
    return Response.json({ error: 'Invalid site' }, { status: 400 })
  }

  try {
    const token = process.env.TERMINUS_TOKEN
    if (token) await run(`terminus auth:login --machine-token="${token}" 2>&1`)

    const res = await run(`terminus site:info ${site} --format=json 2>&1`)
    const facts = parseSiteFacts(cleanJson(res.stdout))

    // No id means terminus did not return a site — a wrong machine name, or a
    // token without access to it. Reported as 404 rather than a body of nulls
    // the caller would render as blank fields.
    if (!facts.id) {
      return Response.json(
        { error: `terminus returned no site for "${site}".` },
        { status: 404 },
      )
    }

    return Response.json(
      { ...facts, fetchedAt: new Date().toISOString() },
      // A label or plan changes when someone edits it in the dashboard, not
      // when a page is opened.
      { headers: { 'cache-control': 'private, max-age=600' } },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `site:info failed: ${msg}` }, { status: 502 })
  }
}
