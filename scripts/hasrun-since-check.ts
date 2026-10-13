// Checks hasRunForSiteSince() in lib/supabase.ts — the Defect B fail-closed guard for the
// fast-track upstream scan's multidev-destination lane. Those sites never get a
// scheduled_deployments row, never update `.dev`, and the rolling mu-YYMMDD name defeats
// hasRunForMultidev across days, so only a real staging_history row (keyed on the ISO-week
// start) proves "already staged this week". The guard is what keeps the daily multidev
// re-stage storm from silently reopening, so its fail-closed branches are load-bearing.
//
// Gap this closes: scripts/scheduler-dedupe-check.ts fakes @/lib/supabase wholesale
// (hasRunForSiteSince included), so the scheduler suite exercises the LANE's use of the
// signal but never the signal's own null-client / query-error fail-closed branches —
// those rested on code inspection only. This drives the REAL hasRunForSiteSince against a
// mocked @supabase/supabase-js client, exactly as scripts/dedupe-signal-check.ts does for
// its sibling hasUnresolvedDeployment.
//
// lib/supabase.ts reads NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY once at module
// top level (isConfigured()/getClient() close over them), so the "unconfigured" case needs
// a fresh module instance — imported under a distinct query string so Node treats it as a
// separate instantiation rather than the cached one.
//
// No test runner: `npm run check:hasrun-since` (Node strips the types).
import { register } from 'node:module'

const ROOT = new URL('../', import.meta.url).href

// Fake @supabase/supabase-js: createClient() returns an object whose .from() starts a
// chainable query builder. Every chain method records what was called and returns itself;
// the builder is thenable so `await db.from(...)...limit(1)` resolves to whatever the test
// queued in globalThis.__SINCE_MOCK__.next. hasRunForSiteSince chains .gte(), which
// dedupe-signal-check.ts's builder does not model, so it is added here.
const fakeSupabaseJs = `
  export function createClient() {
    return {
      from(table) {
        const calls = { table, eq: [], gte: [] }
        const builder = {
          select(cols) { calls.select = cols; return builder },
          eq(col, val) { calls.eq.push([col, val]); return builder },
          gte(col, val) { calls.gte.push([col, val]); return builder },
          limit(n) { calls.limit = n; return builder },
          then(resolve, reject) {
            globalThis.__SINCE_MOCK__.calls.push(calls)
            const next = globalThis.__SINCE_MOCK__.next
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
  var __SINCE_MOCK__: { calls: Array<{ table: string; eq: [string, unknown][]; gte: [string, unknown][]; select?: string; limit?: number }>; next: { data?: unknown[] | null; error?: { message: string } | null } | null }
}
globalThis.__SINCE_MOCK__ = { calls: [], next: null }

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

const WEEK_START = '2026-10-12T00:00:00+08:00'

async function run() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  const { hasRunForSiteSince } = await importFresh('configured')

  console.log('\nhasRunForSiteSince — a staging_history row in the window exists → already staged')
  {
    globalThis.__SINCE_MOCK__ = { calls: [], next: { data: [{ id: 'row-1' }], error: null } }
    const result = await hasRunForSiteSince('site-a', WEEK_START)
    check('returns true', result === true)
    const call = globalThis.__SINCE_MOCK__.calls[0]
    check('queried staging_history', call.table === 'staging_history', `got ${call.table}`)
    check('filtered by site', call.eq.some(([k, v]) => k === 'site' && v === 'site-a'), JSON.stringify(call.eq))
    check('bounded by started_at >= since', call.gte.some(([k, v]) => k === 'started_at' && v === WEEK_START), JSON.stringify(call.gte))
  }

  console.log('\nhasRunForSiteSince — successful read, no row in the window → free to stage')
  {
    globalThis.__SINCE_MOCK__ = { calls: [], next: { data: [], error: null } }
    const result = await hasRunForSiteSince('site-a', WEEK_START)
    check('returns false — only a confirmed-empty successful read says "not yet"', result === false)
  }

  console.log('\nhasRunForSiteSince — query returns an error (fail closed)')
  {
    globalThis.__SINCE_MOCK__ = { calls: [], next: { data: null, error: { message: 'connection reset' } } }
    const result = await hasRunForSiteSince('site-a', WEEK_START)
    check('returns true — an unknown state must not read as "not yet staged"', result === true)
  }

  console.log('\nhasRunForSiteSince — Supabase not configured, no client to ask (fail closed)')
  {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const { hasRunForSiteSince: hasRunForSiteSinceUnconfigured } = await importFresh('unconfigured')
    const result = await hasRunForSiteSinceUnconfigured('site-a', WEEK_START)
    check('returns true with no client to confirm against', result === true)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

await run()
