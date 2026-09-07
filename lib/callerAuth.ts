import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@/utils/supabase/server'

/**
 * Who is allowed to call a mutating API route.
 *
 * `proxy.ts` lists `/api/` among its public paths with the comment "API routes
 * handle their own auth or are internal-only". Only one of seventeen actually
 * did — `/api/me`, and that one only to decide whose name to show. Everything
 * else was reachable by anyone who could resolve the host: register a site,
 * start a 40-minute Terminus run against a customer's production, approve it,
 * cancel it, delete a schedule.
 *
 * Two kinds of caller are legitimate, so this accepts either:
 *
 *   1. A signed-in browser session — mu-staging's own UI, which calls these
 *      same-origin from app/page.tsx with the auth cookie attached.
 *   2. A shared secret in `authorization: Bearer …` — mu-pmu-tool's action
 *      proxy, which calls server-to-server and has no cookie to send. It
 *      already puts a real role check in front of the call on its own side
 *      (requireRole in its lib/auth.ts); this is what stops anyone ELSE
 *      calling the same endpoint directly.
 *
 * DELIBERATELY NOT GATED:
 *
 *   - `/api/slack/interact` verifies an HMAC with SLACK_SIGNING_SECRET. Slack
 *     presents neither a cookie nor our secret, so adding this would break it.
 *   - Every GET. `/api/upcoming` is read server-to-server by mu-deployment with
 *     no credential at all, so gating reads means changing that app too. Reads
 *     do expose customer site data and are worth closing next — but as their
 *     own change, not smuggled into this one.
 *
 * FAILS CLOSED when MU_ACTION_SECRET is unset: the secret branch simply cannot
 * match, and the session branch still gates the route. So an unset variable
 * costs mu-pmu-tool its Stage and Register buttons (401) — it does not leave
 * the route open. Set the variable on both services BEFORE this merges.
 */

/** Constant-time compare that does not leak length through early return. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal — hash-free equalisation: compare against a padded copy and
  // AND in the length check.
  if (a.length !== b.length) {
    // Still burn a comparison of equal-length buffers so the work is constant.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

export async function requireCaller(request: Request): Promise<Response | null> {
  const secret = process.env.MU_ACTION_SECRET
  if (secret) {
    const presented = request.headers.get('authorization')
    if (presented && secretMatches(presented, `Bearer ${secret}`)) return null
  }

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (user) return null
  } catch {
    // A broken Supabase call must not become an open door.
  }

  return Response.json(
    {
      error:
        'Sign in, or call with the MU_ACTION_SECRET bearer token. ' +
        'This endpoint changes real sites, so it is no longer anonymous.',
    },
    { status: 401 },
  )
}
