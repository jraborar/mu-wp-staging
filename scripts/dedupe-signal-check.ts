// Checks hasUnresolvedDeployment() in lib/supabase.ts — the "have I already handled
// this" signal the fast-track upstream/security scan lanes (lib/scheduler.ts) now use
// instead of polling terminus `<site>.dev` state + a same-day scheduler-state key.
//
// Why the old signal was wrong: staging always builds fresh from LIVE, so `.dev` only
// reflects a change once the deploy actually lands there (multidev:merge-to-dev) —
// which, per bug_upstream_scan_wipes_scheduled_multidev, can sit pending for 3+ days.
// `.dev` correctly kept reporting "still pending" that whole time, and the same-day key
// reset every Pacific midnight regardless, guaranteeing a re-fire once enough days
// passed without a deploy landing — confirmed live: the identical WP 7.1.2 commit was
// staged fresh into a new multidev on 6 consecutive days across 6 sites. No date-scoped
// key can fix that; the signal itself was asking the wrong environment. A stacked
// pending/triggered scheduled_deployments row for the site+destination IS proof the
// site was already staged, independent of the source multidev name or how long ago.
//
// hasUnresolvedDeployment talks to Supabase via @supabase/supabase-js, not global fetch,
// so this mocks that module instead (cancelStaleBooking's sibling check,
// scripts/schedule-cancel-check.ts, mocks fetch for the same reason on the mu-deployment
// HTTP side). lib/supabase.ts also reads NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
// once at module top level (isConfigured()/getClient() close over them), so the
// "unconfigured" case needs a fresh module instance — imported under a distinct query
// string so Node treats it as a separate module instantiation rather than the cached one.
//
// No test runner: `npm run check:dedupe-signal` (Node strips the types).
import { register } from 'node:module'

const ROOT = new URL('../', import.meta.url).href

// Fake @supabase/supabase-js: createClient() returns an object whose .from() starts a
// chainable query builder. Every chain method just records what was called and returns
// itself; the builder is thenable so `await db.from(...)....limit(1)` resolves to
// whatever the test queued in globalThis.__DEDUPE_MOCK__.next.
const fakeSupabaseJs = `
  export function createClient() {
    return {
      from(table) {
        const calls = { table, eq: [] }
        const builder = {
          select(cols) { calls.select = cols; return builder },
          eq(col, val) { calls.eq.push([col, val]); return builder },
          in(col, vals) { calls.in = [col, vals]; return builder },
          limit(n) { calls.limit = n; return builder },
          then(resolve, reject) {
            globalThis.__DEDUPE_MOCK__.calls.push(calls)
            const next = globalThis.__DEDUPE_MOCK__.next
            if (next && next.throws) { reject(next.throws); return }
            Promise.resolve(next ?? { data: [], error: null }).then(resolve, reject)
          },
        }
        return builder
      },
    }
  }
`
const fakeSupabaseJsUrl = 'data:text/javascript,' + encodeURIComponent(fakeSupabaseJs)

const loaderSrc = `
  const ROOT = '${ROOT}'
  const FAKE_SUPABASE_JS = '${fakeSupabaseJsUrl}'
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === '@supabase/supabase-js') return { url: FAKE_SUPABASE_JS, shortCircuit: true }
    if (specifier.startsWith('@/')) {
      const target = new URL(specifier.slice(2) + '.ts', ROOT).href
      return nextResolve(target, context)
    }
    return nextResolve(specifier, context)
  }
`
register('data:text/javascript,' + encodeURIComponent(loaderSrc), import.meta.url)

declare global {
  // eslint-disable-next-line no-var
  var __DEDUPE_MOCK__: { calls: unknown[]; next: { data?: unknown[] | null; error?: { message: string } | null; throws?: unknown } | null }
}
globalThis.__DEDUPE_MOCK__ = { calls: [], next: null }

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`) }
}

// Built via concatenation, not a string literal, so tsc's static import-specifier
// resolution (which has no notion of the ?scenario= cache-busting query string below)
// doesn't try to resolve it and error — Node's loader still handles it fine at runtime,
// and the cast keeps the caller's destructuring typed against the real module.
function importFresh(scenario: string): Promise<typeof import('../lib/supabase.ts')> {
  const specifier = '../lib/supabase.ts' + '?scenario=' + scenario
  return import(specifier)
}

async function run() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  const { hasUnresolvedDeployment } = await importFresh('configured')

  console.log('\nhasUnresolvedDeployment — a pending row for this site+destination exists')
  {
    globalThis.__DEDUPE_MOCK__ = { calls: [], next: { data: [{ id: 'row-1' }], error: null } }
    const result = await hasUnresolvedDeployment('site-a', 'live')
    check('returns true', result === true)
    const call = globalThis.__DEDUPE_MOCK__.calls[0] as { table: string; eq: [string, unknown][]; in?: [string, unknown[]] }
    check('queried scheduled_deployments', call.table === 'scheduled_deployments', `got ${call.table}`)
    check('filtered by site', call.eq.some(([k, v]) => k === 'site' && v === 'site-a'), JSON.stringify(call.eq))
    check('filtered by destination', call.eq.some(([k, v]) => k === 'destination' && v === 'live'), JSON.stringify(call.eq))
    check('filtered by status in (pending, triggered)',
      call.in?.[0] === 'status' && JSON.stringify(call.in?.[1]) === JSON.stringify(['pending', 'triggered']),
      JSON.stringify(call.in))
  }

  console.log('\nhasUnresolvedDeployment — a triggered row for this site+destination exists')
  {
    globalThis.__DEDUPE_MOCK__ = { calls: [], next: { data: [{ id: 'row-2' }], error: null } }
    const result = await hasUnresolvedDeployment('site-a', 'live')
    check('returns true', result === true)
  }

  console.log('\nhasUnresolvedDeployment — no matching row (query returns empty)')
  {
    // Models both "no row at all" and "rows exist but for a different site/destination,
    // or resolved (completed/cancelled/customer-deployed/failed)" — those are filtered
    // out server-side by the same query, so from this function's view it's just empty.
    globalThis.__DEDUPE_MOCK__ = { calls: [], next: { data: [], error: null } }
    const result = await hasUnresolvedDeployment('site-a', 'live')
    check('returns false', result === false)
  }

  console.log('\nhasUnresolvedDeployment — query errors (fail closed)')
  {
    globalThis.__DEDUPE_MOCK__ = { calls: [], next: { data: null, error: { message: 'connection reset' } } }
    const result = await hasUnresolvedDeployment('site-a', 'live')
    check('returns true — an unknown state must not read as "nothing pending"', result === true)
  }

  console.log('\nhasUnresolvedDeployment — Supabase not configured (fail closed)')
  {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const { hasUnresolvedDeployment: hasUnresolvedDeploymentUnconfigured } =
      await importFresh('unconfigured')
    const result = await hasUnresolvedDeploymentUnconfigured('site-a', 'live')
    check('returns true with no client to ask', result === true)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

await run()
