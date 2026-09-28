// Checks lib/schedule.ts's cancelStaleBooking() — the cancellation half of the
// fast-track multidev-cleanup fix (see scripts/multidev-cleanup-check.ts's header for
// the selection half, selectStaleMultidevs()). cancelStaleBooking is called immediately
// before every `terminus multidev:delete` in staging.ts / drupal.ts, precisely to close
// the regression: a stale mu-YYMMDD env got reaped while mu-deployment still held a
// PENDING booking whose `source` pointed at it, so the deploy fired later against a
// multidev that no longer existed ("Multidev does not exist on site X") — confirmed
// live on 6 customer sites for a week. See memory bug_upstream_scan_wipes_scheduled_multidev.
//
// Unlike selectStaleMultidevs (pure, no imports), cancelStaleBooking talks to
// mu-deployment's HTTP API via global fetch — GET /api/schedule to find the pending
// row, then DELETE it — so this check mocks fetch instead of hitting the network.
//
// lib/schedule.ts also imports @/lib/jobStore, @/lib/timezone, @/lib/supabase and
// @/lib/sites through the tsconfig `@/*` path alias. That alias is resolved by
// tsc/webpack/Next, but plain `node` (the runner every check:* script in this repo
// uses — no ts-node, no bundler) has no idea what `@/` means and fails to import the
// file at all. The loader registered below teaches Node that one mapping — `@/x` ->
// `<repo root>/x.ts` — for this process only. It is test-only plumbing; lib/schedule.ts
// itself is untouched, and every other check:* script keeps importing lib files that
// happen to have no `@/` imports, so it never needed this before.
//
// No test runner: `npm run check:schedule-cancel` (Node strips the types).
import { register } from 'node:module'
import { EventEmitter } from 'node:events'
import type { StagingJob } from '../lib/jobStore.ts'

const ROOT = new URL('../', import.meta.url).href
const loaderSrc = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const target = new URL(specifier.slice(2) + '.ts', '${ROOT}').href
      return nextResolve(target, context)
    }
    return nextResolve(specifier, context)
  }
`
register('data:text/javascript,' + encodeURIComponent(loaderSrc), import.meta.url)

const { cancelStaleBooking } = await import('../lib/schedule.ts')

// ── minimal fake StagingJob ──────────────────────────────────────────────────
// cancelStaleBooking only reads job.site and hands `job` to appendLog(), which pushes
// onto job.logs, stamps job.lastActivity and emits on job.emitter — a real (unmocked)
// EventEmitter is the smallest thing that satisfies that without stubbing jobStore.
function fakeJob(overrides: Partial<StagingJob> = {}): StagingJob {
  return {
    id: 'job-1',
    site: 'example-site',
    multidev: 'mu-260927',
    upstreamUpdated: false,
    upstreamConflict: false,
    upstreamConflictFiles: [],
    upstreamUpdates: [],
    plugins: { updated: [], skipped: [] },
    themes: { updated: [], skipped: [] },
    composerDeps: [],
    securityAdvisories: [],
    status: 'running',
    logs: [],
    startedAt: Date.now(),
    lastActivity: Date.now(),
    emitter: new EventEmitter(),
    stepName: 'Testing',
    stepIndex: 0,
    stepTotal: 1,
    skipUpstream: false,
    skipPluginsThemes: false,
    cancelRequested: false,
    pendingApproval: null,
    multidevCreated: false,
    ...overrides,
  } as StagingJob
}

// ── fetch mock ───────────────────────────────────────────────────────────────
interface FetchCall { url: string; method: string; body?: unknown }

function makeFetchMock(opts: {
  rows: unknown[] | 'get-not-ok' | 'get-throws'
  deleteBehavior?: 'ok' | 'throws'
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchMock = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    if (method === 'GET') {
      if (opts.rows === 'get-throws') throw new Error('network down')
      if (opts.rows === 'get-not-ok') return { ok: false, json: async () => [] } as Response
      return { ok: true, json: async () => opts.rows } as Response
    }
    if (method === 'DELETE') {
      if (opts.deleteBehavior === 'throws') throw new Error('delete failed')
      return { ok: true, json: async () => ({}) } as Response
    }
    throw new Error(`fetch mock: unexpected method ${method}`)
  }) as typeof globalThis.fetch
  return { fetch: fetchMock, calls }
}

const DEPLOY_URL = 'https://mu-deployment.example'
const originalFetch = globalThis.fetch
const originalDeployUrl = process.env.MU_DEPLOY_URL

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`) }
}

async function run() {
  console.log('\ncancelStaleBooking — pending booking exists for (site, source)')
  {
    process.env.MU_DEPLOY_URL = DEPLOY_URL
    const { fetch, calls } = makeFetchMock({
      rows: [
        { id: 'row-1', site: 'example-site', source: 'mu-260927', status: 'pending' },
        { id: 'row-2', site: 'example-site', source: 'mu-260918', status: 'pending' },
      ],
    })
    globalThis.fetch = fetch
    const job = fakeJob()

    await cancelStaleBooking(job, 'mu-260927')

    const deletes = calls.filter((c) => c.method === 'DELETE')
    check('exactly one DELETE was sent', deletes.length === 1,
      `got ${deletes.length} DELETE call(s)`)
    check('DELETE target is MU_DEPLOY_URL + /api/schedule',
      deletes[0]?.url === `${DEPLOY_URL}/api/schedule`,
      `got url ${deletes[0]?.url}`)
    check('DELETE body carries the matched booking\'s id (not the unrelated row)',
      (deletes[0]?.body as { id?: string } | undefined)?.id === 'row-1',
      `got body ${JSON.stringify(deletes[0]?.body)}`)
    check('the GET (lookup) happened before the DELETE',
      calls[0]?.method === 'GET' && calls[1]?.method === 'DELETE',
      `got call order ${calls.map((c) => c.method).join(',')}`)
    check('a warn log recorded the cancellation',
      job.logs.some((l) => l.logType === 'warn' && l.message.includes('mu-260927')),
      `got logs ${JSON.stringify(job.logs.map((l) => l.message))}`)
  }

  console.log('\ncancelStaleBooking — no pending booking exists for (site, source)')
  {
    process.env.MU_DEPLOY_URL = DEPLOY_URL
    // Rows exist, but none match this (site, source, pending) — e.g. a different
    // source, a different site, or status already 'completed'/'cancelled'.
    const { fetch, calls } = makeFetchMock({
      rows: [
        { id: 'row-1', site: 'example-site', source: 'mu-260918', status: 'pending' },
        { id: 'row-2', site: 'other-site',    source: 'mu-260927', status: 'pending' },
        { id: 'row-3', site: 'example-site',  source: 'mu-260927', status: 'completed' },
      ],
    })
    globalThis.fetch = fetch
    const job = fakeJob()

    await cancelStaleBooking(job, 'mu-260927')

    check('no DELETE was sent', calls.every((c) => c.method !== 'DELETE'),
      `got calls ${JSON.stringify(calls.map((c) => c.method))}`)
    check('exactly one GET (the lookup) was made', calls.length === 1 && calls[0].method === 'GET',
      `got calls ${JSON.stringify(calls.map((c) => c.method))}`)
  }

  console.log('\ncancelStaleBooking — MU_DEPLOY_URL unset')
  {
    delete process.env.MU_DEPLOY_URL
    const { fetch, calls } = makeFetchMock({ rows: [] })
    globalThis.fetch = fetch
    const job = fakeJob()

    await cancelStaleBooking(job, 'mu-260927')

    check('no fetch calls were made at all (mirrors prebookDeployment\'s early return)',
      calls.length === 0, `got calls ${JSON.stringify(calls)}`)
    check('no log entries were written', job.logs.length === 0,
      `got logs ${JSON.stringify(job.logs)}`)
  }

  console.log('\ncancelStaleBooking — the DELETE fetch itself fails')
  {
    process.env.MU_DEPLOY_URL = DEPLOY_URL
    const { fetch } = makeFetchMock({
      rows: [{ id: 'row-1', site: 'example-site', source: 'mu-260927', status: 'pending' }],
      deleteBehavior: 'throws',
    })
    globalThis.fetch = fetch
    const job = fakeJob()

    let threw = false
    try {
      await cancelStaleBooking(job, 'mu-260927')
    } catch {
      threw = true
    }

    check('cancelStaleBooking does not throw when the DELETE rejects', !threw)
    check('a warn log recorded the failure (try/catch path)',
      job.logs.some((l) => l.logType === 'warn' && l.message.includes('Failed to cancel')),
      `got logs ${JSON.stringify(job.logs.map((l) => l.message))}`)
  }

  globalThis.fetch = originalFetch
  if (originalDeployUrl === undefined) delete process.env.MU_DEPLOY_URL
  else process.env.MU_DEPLOY_URL = originalDeployUrl

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

await run()
