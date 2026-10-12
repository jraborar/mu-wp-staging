// Status-aware regression check for hasUnresolvedDeployment() in lib/supabase.ts — the
// "have I already handled this" signal the fast-track upstream/security scan lanes
// (lib/scheduler.ts) consult before firing. See project_mu_fasttrack_dedupe_suppression:
// the function filtered `.in('status', ['pending','triggered'])`, but scheduled_deployments
// rows that fire are flipped to 'triggered' and, on the fast-track path, that row is never
// cleared back out. So a long-dead 'triggered' row kept matching and made EVERY auto
// fast-track believe a deployment was still unresolved — suppressing all of them since
// 2026-09-28. The fix narrows the filter to `.eq('status','pending')`.
//
// Why a NEW check and not scripts/dedupe-signal-check.ts: that check's fake
// @supabase/supabase-js is a BLIND pass-through — its then() returns whatever rows the
// test pre-queued regardless of which .eq/.in predicates were applied, so it asserted the
// *shape* of the query ("filtered by status in (pending,triggered)") rather than its
// *effect*. It could never catch this bug because it never ran the filter; a seeded
// 'triggered' row was returned whether the code asked for it or not.
//
// This builder instead actually APPLIES the recorded .eq/.in predicates to a seeded row
// set, so flipping lib/supabase.ts between the buggy `.in(...)` and the fixed `.eq(...)`
// changes the result for the same seed. Case 1 (a stale-triggered-only row) is therefore
// RED against the current unpatched code (returns true) and GREEN after the fix (false).
//
// No test runner: `npm run check:fasttrack-dedupe` (Node strips the types). lib/supabase.ts
// reads NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY once at module top level, so
// the "unconfigured" case needs a fresh module instance imported under a distinct query
// string (importFresh), same as dedupe-signal-check.ts.
import { register } from 'node:module'

const ROOT = new URL('../', import.meta.url).href

// Fake @supabase/supabase-js: createClient().from() returns a chainable builder that
// RECORDS the .eq/.in/.limit it is handed, then — when awaited — applies those predicates
// to the seeded rows in globalThis.__FT_MOCK__.rows and resolves with only the rows that
// match ALL of them (honoring .limit). If the test queued an error, it resolves
// { data: null, error } so the caller's fail-closed branch runs.
const fakeSupabaseJs = `
  export function createClient() {
    return {
      from(table) {
        const eqs = []
        let inFilter = null
        let limit = Infinity
        const builder = {
          select() { return builder },
          eq(col, val) { eqs.push([col, val]); return builder },
          in(col, vals) { inFilter = [col, vals]; return builder },
          limit(n) { limit = n; return builder },
          then(resolve, reject) {
            const mock = globalThis.__FT_MOCK__
            mock.lastQuery = { table, eqs, in: inFilter, limit }
            if (mock.error) {
              Promise.resolve({ data: null, error: mock.error }).then(resolve, reject)
              return
            }
            let rows = (mock.rows ?? []).filter((row) => {
              for (const [col, val] of eqs) { if (row[col] !== val) return false }
              if (inFilter) { const [col, vals] = inFilter; if (!vals.includes(row[col])) return false }
              return true
            })
            if (Number.isFinite(limit)) rows = rows.slice(0, limit)
            Promise.resolve({ data: rows, error: null }).then(resolve, reject)
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

interface MockRow { id: string; site: string; destination: string; status: string }
declare global {
  // eslint-disable-next-line no-var
  var __FT_MOCK__: {
    rows: MockRow[]
    error: { message: string } | null
    lastQuery?: { table: string; eqs: [string, unknown][]; in: [string, unknown[]] | null; limit: number }
  }
}
function seed(rows: MockRow[], error: { message: string } | null = null) {
  globalThis.__FT_MOCK__ = { rows, error }
}
globalThis.__FT_MOCK__ = { rows: [], error: null }

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`) }
}

// Built via concatenation so tsc's static import-specifier resolution (which has no notion
// of the ?scenario= cache-buster) doesn't try to resolve it; Node's loader handles it at
// runtime, and the cast keeps the destructured export typed against the real module.
function importFresh(scenario: string): Promise<typeof import('../lib/supabase.ts')> {
  const specifier = '../lib/supabase.ts' + '?scenario=' + scenario
  return import(specifier)
}

async function run() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  const { hasUnresolvedDeployment } = await importFresh('configured')

  // Case 1 — the core regression. A fast-track row that fired long ago was flipped to
  // 'triggered' and never cleared. It is NOT an unresolved deployment, so the fast-track
  // lane must be allowed to fire. Buggy `.in(['pending','triggered'])` matches it (→ true,
  // wrong); fixed `.eq('status','pending')` does not (→ false, right).
  console.log('\nCase 1 — stale triggered-only row must NOT suppress (the regression)')
  {
    seed([{ id: 'row-trig', site: 'site-a', destination: 'live', status: 'triggered' }])
    const result = await hasUnresolvedDeployment('site-a', 'live')
    check('returns false for a triggered-only row', result === false,
      `got ${result}; lastQuery=${JSON.stringify(globalThis.__FT_MOCK__.lastQuery)}`)
  }

  // Case 2 — guard against an over-correction that drops pending too. A genuine pending row
  // IS an unresolved deployment and must still suppress.
  console.log('\nCase 2 — a genuine pending row still suppresses')
  {
    seed([{ id: 'row-pend', site: 'site-a', destination: 'live', status: 'pending' }])
    const result = await hasUnresolvedDeployment('site-a', 'live')
    check('returns true for a pending row', result === true)
  }

  // Case 3 — the site/destination predicates must actually bind. Pending rows exist, but
  // for a different site, and for site-a on a different destination — neither is site-a/live.
  console.log('\nCase 3 — pending rows for other site/destination do not match')
  {
    seed([
      { id: 'row-other', site: 'other', destination: 'live', status: 'pending' },
      { id: 'row-test', site: 'site-a', destination: 'test', status: 'pending' },
    ])
    const result = await hasUnresolvedDeployment('site-a', 'live')
    check('returns false — no pending row for site-a/live', result === false)
  }

  // Case 4 — a stale triggered row alongside a real pending row. Pending must win.
  console.log('\nCase 4 — mixed stale-triggered + real-pending still suppresses')
  {
    seed([
      { id: 'row-trig', site: 'site-a', destination: 'live', status: 'triggered' },
      { id: 'row-pend', site: 'site-a', destination: 'live', status: 'pending' },
    ])
    const result = await hasUnresolvedDeployment('site-a', 'live')
    check('returns true — the pending row suppresses', result === true)
  }

  // Case 5 — a failed query is an unknown state; fail closed rather than read it as
  // "nothing pending" and let the lane re-fire.
  console.log('\nCase 5 — query error fails closed')
  {
    seed([], { message: 'connection reset' })
    const result = await hasUnresolvedDeployment('site-a', 'live')
    check('returns true on error', result === true)
  }

  // Case 6 — no Supabase client at all; same fail-closed posture, via a fresh module
  // instance with the env unset so isConfigured() closes over empty values.
  console.log('\nCase 6 — unconfigured client fails closed')
  {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const { hasUnresolvedDeployment: hasUnresolvedUnconfigured } = await importFresh('unconfigured')
    const result = await hasUnresolvedUnconfigured('site-a', 'live')
    check('returns true with no client to ask', result === true)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

await run()
