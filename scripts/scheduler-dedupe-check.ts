// Checks the fast-track upstream/security scan lanes in lib/scheduler.ts — specifically
// that both runUpstreamCheck() and runPendingSecurityChecks() now stand down when the
// site already has an unresolved (pending/triggered) scheduled_deployments row for its
// destination, and still fire normally when it doesn't. See
// bug_upstream_scan_wipes_scheduled_multidev's "SEPARATE BUG" section:
// runPendingSecurityChecks had NO dedupe at all, and runUpstreamCheck's existing guard
// polled terminus `<site>.dev` state + a same-day key — a signal that can't tell
// "already staged, deploy just hasn't landed yet" apart from "never staged", since
// staging always builds fresh from LIVE and `.dev` only updates at actual deploy time.
//
// Unlike scripts/dedupe-signal-check.ts (which exercises the real hasUnresolvedDeployment
// against a mocked Supabase client), this check fakes @/lib/supabase entirely — along with
// every other I/O boundary scheduler.ts touches (sites registry, schedule store, job store,
// staging execution, terminus, wordpress parsing, VRT, Slack) — so it can drive
// runUpstreamCheck/runPendingSecurityChecks directly and observe exactly what they did:
// was terminus even asked, was a job created and executed, was a broadcast sent. Real
// (unmocked): lib/cadence.ts + lib/timezone.ts — both are pure, no I/O, and using the
// real off-week predicate (isScheduledThisWeek) keeps that existing guard's interaction
// with the new one honest instead of re-stubbing it.
//
// No test runner: `npm run check:scheduler-dedupe` (Node strips the types).
import { register } from 'node:module'

const ROOT = new URL('../', import.meta.url).href

declare global {
  // eslint-disable-next-line no-var
  var __SCHED_T__: {
    sites: unknown[]
    schedules: unknown[]
    pendingSecuritySites: unknown[]
    jobs: unknown[]
    createdJobs: Array<{ site: string; multidev: string; [k: string]: unknown }>
    executedJobs: unknown[]
    terminusCalls: string[]
    terminusHasUpdates: boolean
    hasRunForMultidevResult: boolean
    hasUnresolvedDeploymentResult: boolean
    hasUnresolvedDeploymentCalls: Array<{ site: string; destination: string }>
    clearedPending: string[]
    broadcasts: string[]
  }
}

function resetTestState(): void {
  globalThis.__SCHED_T__ = {
    sites: [],
    schedules: [],
    pendingSecuritySites: [],
    jobs: [],
    createdJobs: [],
    executedJobs: [],
    terminusCalls: [],
    terminusHasUpdates: false,
    hasRunForMultidevResult: false,
    hasUnresolvedDeploymentResult: false,
    hasUnresolvedDeploymentCalls: [],
    clearedPending: [],
    broadcasts: [],
  }
}
resetTestState()

// ── Fake modules for every I/O boundary scheduler.ts imports (besides cadence/timezone,
// which stay real — see header). Each reads/writes globalThis.__SCHED_T__ at CALL time
// (not import time), so the same module instance can be reused across scenarios just by
// calling resetTestState() between them.
const fakes: Record<string, string> = {
  '@/lib/sites': `
    export function listSites() { return Promise.resolve(globalThis.__SCHED_T__.sites) }
    export function getSite(site) { return Promise.resolve(globalThis.__SCHED_T__.sites.find(s => s.site === site) ?? null) }
    export function updateSite() { return Promise.resolve() }
    export function isPaused(site) { return Boolean(site && site.paused_at) }
  `,
  '@/lib/scheduleStore': `
    export function getActiveSchedules() { return Promise.resolve(globalThis.__SCHED_T__.schedules) }
    export function updateSchedule() { return Promise.resolve() }
    export function updateScheduleAfterRun() { return Promise.resolve() }
    export function getSecurityCheckSites() { return Promise.resolve([]) }
    export function getPendingSecuritySites() { return Promise.resolve(globalThis.__SCHED_T__.pendingSecuritySites) }
    export function markSecurityCheckPending() { return Promise.resolve() }
    export function clearSecurityCheckPending(id) { globalThis.__SCHED_T__.clearedPending.push(id); return Promise.resolve() }
    export function getSchedulerState() { return Promise.resolve(null) }
    export function setSchedulerState() { return Promise.resolve() }
  `,
  '@/lib/jobStore': `
    export function createJob(site, multidev, opts) {
      const job = Object.assign({ site, multidev }, opts, { id: 'job-' + globalThis.__SCHED_T__.createdJobs.length })
      globalThis.__SCHED_T__.createdJobs.push(job)
      return job
    }
    export function getAllJobs() { return globalThis.__SCHED_T__.jobs }
  `,
  '@/lib/staging': `
    export function executeJob(job) { globalThis.__SCHED_T__.executedJobs.push(job); return Promise.resolve() }
  `,
  '@/lib/terminus': `
    export function run(cmd) {
      globalThis.__SCHED_T__.terminusCalls.push(cmd)
      const body = globalThis.__SCHED_T__.terminusHasUpdates ? '[{"id":"core"}]' : '[]'
      return Promise.resolve({ stdout: body, stderr: '' })
    }
    export function cleanJson(s) { return s }
  `,
  '@/lib/wordpress': `
    export function parseWpJson(s) { return JSON.parse(s) }
  `,
  '@/lib/supabase': `
    export function hasRunForMultidev() { return Promise.resolve(globalThis.__SCHED_T__.hasRunForMultidevResult) }
    export function hasUnresolvedDeployment(site, destination) {
      globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls.push({ site, destination })
      return Promise.resolve(globalThis.__SCHED_T__.hasUnresolvedDeploymentResult)
    }
    export function listStagingWithVrt() { return Promise.resolve([]) }
    export function clearStagingVrt() { return Promise.resolve() }
  `,
  '@/lib/vrt': `
    export function deleteVrtRun() { return Promise.resolve() }
    export function runIdFromReportUrl() { return null }
  `,
  '@/lib/slack': `
    export function broadcastText(msg) { globalThis.__SCHED_T__.broadcasts.push(msg); return Promise.resolve() }
  `,
}

const fakeUrls: Record<string, string> = {}
for (const [specifier, src] of Object.entries(fakes)) {
  fakeUrls[specifier] = 'data:text/javascript,' + encodeURIComponent(src)
}

const loaderSrc = `
  const ROOT = '${ROOT}'
  const FAKES = ${JSON.stringify(fakeUrls)}
  export async function resolve(specifier, context, nextResolve) {
    if (FAKES[specifier]) return { url: FAKES[specifier], shortCircuit: true }
    if (specifier.startsWith('@/')) {
      const target = new URL(specifier.slice(2) + '.ts', ROOT).href
      return nextResolve(target, context)
    }
    return nextResolve(specifier, context)
  }
`
register('data:text/javascript,' + encodeURIComponent(loaderSrc), import.meta.url)

const { runUpstreamCheck, runPendingSecurityChecks } = await import('../lib/scheduler.ts')

// ── fixtures ─────────────────────────────────────────────────────────────────
function site(overrides: Record<string, unknown> = {}) {
  return {
    site: 'site-a',
    machine_name: 'site-a',
    site_name: 'Site A',
    platform: 'wp-single',
    update_mode: 'upstream',
    skip_upstream: false,
    skip_plugins_themes: false,
    deploy_days: 1,
    deploy_destination: 'live',
    deploy_approval: 'manual',
    security_deploy_hours: 24,
    vrt_enabled: false,
    vrt_threshold: 0,
    vrt_paths: [],
    active: true,
    auto_stage: true,
    last_deployment: '2026-01-01',
    ...overrides,
  }
}

function pendingSecuritySite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sched-1',
    site: 'site-a',
    cadence: 'security-only',
    active: true,
    created_at: '2026-01-01T00:00:00Z',
    deploy_days: 1,
    ...overrides,
  }
}

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`) }
}

async function run() {
  console.log('\nrunUpstreamCheck — unresolved booking skips staging even though terminus reports the update pending')
  {
    resetTestState()
    globalThis.__SCHED_T__.sites = [site()]
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = true
    globalThis.__SCHED_T__.terminusHasUpdates = true // terminus still says "update pending" — must not matter

    await runUpstreamCheck()

    check('terminus was never even queried', globalThis.__SCHED_T__.terminusCalls.length === 0,
      `got ${JSON.stringify(globalThis.__SCHED_T__.terminusCalls)}`)
    check('no job was created', globalThis.__SCHED_T__.createdJobs.length === 0)
    check('no job was executed', globalThis.__SCHED_T__.executedJobs.length === 0)
    check('the booking check ran for (site-a, live)',
      globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls.some(c => c.site === 'site-a' && c.destination === 'live'),
      JSON.stringify(globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls))
  }

  console.log('\nrunUpstreamCheck — no unresolved booking, terminus reports an update → stages normally')
  {
    resetTestState()
    globalThis.__SCHED_T__.sites = [site()]
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = false
    globalThis.__SCHED_T__.terminusHasUpdates = true

    await runUpstreamCheck()

    check('terminus was queried', globalThis.__SCHED_T__.terminusCalls.length === 1,
      JSON.stringify(globalThis.__SCHED_T__.terminusCalls))
    check('exactly one job was created', globalThis.__SCHED_T__.createdJobs.length === 1,
      JSON.stringify(globalThis.__SCHED_T__.createdJobs))
    check('the job is for site-a, fast-track, destination live',
      globalThis.__SCHED_T__.createdJobs[0]?.site === 'site-a' &&
      globalThis.__SCHED_T__.createdJobs[0]?.securityFastTrack === true &&
      globalThis.__SCHED_T__.createdJobs[0]?.deployDestination === 'live',
      JSON.stringify(globalThis.__SCHED_T__.createdJobs[0]))
    check('the job was executed', globalThis.__SCHED_T__.executedJobs.length === 1)
    check('a broadcast was sent', globalThis.__SCHED_T__.broadcasts.length === 1)
  }

  console.log('\nrunUpstreamCheck — no unresolved booking, terminus reports nothing pending → no-op (unchanged base case)')
  {
    resetTestState()
    globalThis.__SCHED_T__.sites = [site()]
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = false
    globalThis.__SCHED_T__.terminusHasUpdates = false

    await runUpstreamCheck()

    check('terminus was queried', globalThis.__SCHED_T__.terminusCalls.length === 1)
    check('no job was created', globalThis.__SCHED_T__.createdJobs.length === 0)
  }

  console.log('\nrunUpstreamCheck — an in-flight job skips before the booking check is even consulted')
  {
    resetTestState()
    globalThis.__SCHED_T__.sites = [site()]
    globalThis.__SCHED_T__.jobs = [{ site: 'site-a', status: 'running' }]
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = false // irrelevant — should never be asked
    globalThis.__SCHED_T__.terminusHasUpdates = true

    await runUpstreamCheck()

    check('the booking check was never called', globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls.length === 0,
      JSON.stringify(globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls))
    check('no job was created', globalThis.__SCHED_T__.createdJobs.length === 0)
  }

  console.log('\nrunPendingSecurityChecks — unresolved booking skips staging even though terminus reports the update pending')
  {
    resetTestState()
    globalThis.__SCHED_T__.sites = [site()]
    globalThis.__SCHED_T__.pendingSecuritySites = [pendingSecuritySite()]
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = true
    globalThis.__SCHED_T__.terminusHasUpdates = true

    await runPendingSecurityChecks()

    check('terminus was never even queried', globalThis.__SCHED_T__.terminusCalls.length === 0,
      JSON.stringify(globalThis.__SCHED_T__.terminusCalls))
    check('no job was created', globalThis.__SCHED_T__.createdJobs.length === 0)
    check('no job was executed', globalThis.__SCHED_T__.executedJobs.length === 0)
    check('the pending flag was left set (deferred, not dropped)',
      globalThis.__SCHED_T__.clearedPending.length === 0)
    check('the booking check ran for (site-a, live)',
      globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls.some(c => c.site === 'site-a' && c.destination === 'live'))
  }

  console.log('\nrunPendingSecurityChecks — no unresolved booking, terminus reports an update → stages normally')
  {
    resetTestState()
    globalThis.__SCHED_T__.sites = [site()]
    globalThis.__SCHED_T__.pendingSecuritySites = [pendingSecuritySite()]
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = false
    globalThis.__SCHED_T__.terminusHasUpdates = true

    await runPendingSecurityChecks()

    check('terminus was queried', globalThis.__SCHED_T__.terminusCalls.length === 1)
    check('exactly one job was created', globalThis.__SCHED_T__.createdJobs.length === 1,
      JSON.stringify(globalThis.__SCHED_T__.createdJobs))
    check('the job was executed', globalThis.__SCHED_T__.executedJobs.length === 1)
    check('the pending flag was cleared', globalThis.__SCHED_T__.clearedPending.includes('sched-1'),
      JSON.stringify(globalThis.__SCHED_T__.clearedPending))
    check('a broadcast was sent', globalThis.__SCHED_T__.broadcasts.length === 1)
  }

  console.log('\nrunPendingSecurityChecks — an in-flight job skips before the booking check is even consulted')
  {
    resetTestState()
    globalThis.__SCHED_T__.sites = [site()]
    globalThis.__SCHED_T__.pendingSecuritySites = [pendingSecuritySite()]
    globalThis.__SCHED_T__.jobs = [{ site: 'site-a', status: 'awaiting-approval' }]
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = false
    globalThis.__SCHED_T__.terminusHasUpdates = true

    await runPendingSecurityChecks()

    check('the booking check was never called', globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls.length === 0,
      JSON.stringify(globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls))
    check('no job was created', globalThis.__SCHED_T__.createdJobs.length === 0)
  }

  console.log('\nrunPendingSecurityChecks — a scheduled run covers this ISO week → stands down (existing guard, unchanged)')
  {
    resetTestState()
    globalThis.__SCHED_T__.sites = [site()]
    globalThis.__SCHED_T__.pendingSecuritySites = [pendingSecuritySite()]
    // A weekly schedule anchored far in the past covers "this week" per isScheduledThisWeek
    // (real, unmocked) — the off-week guard must fire and clear pending BEFORE the new
    // booking check is ever consulted.
    globalThis.__SCHED_T__.schedules = [{
      id: 'active-sched-1', site: 'site-a', cadence: 'weekly', day_of_week: 1,
      active: true, created_at: '2020-01-01T00:00:00Z', skip_upstream: false,
    }]
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = false
    globalThis.__SCHED_T__.terminusHasUpdates = true

    await runPendingSecurityChecks()

    check('the booking check was never called', globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls.length === 0,
      JSON.stringify(globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls))
    check('no job was created', globalThis.__SCHED_T__.createdJobs.length === 0)
    check('the pending flag was cleared', globalThis.__SCHED_T__.clearedPending.includes('sched-1'))
  }

  // ── Gap: every fixture above uses the default deploy_destination: 'live', so a
  // regression that hardcoded 'live' into the booking check (instead of routing through
  // effectiveDestination(site)) would pass every test above unnoticed. These two prove
  // each fast-track lane asks hasUnresolvedDeployment about the SITE's actual destination.
  console.log('\nrunUpstreamCheck — site has a non-default deploy_destination (\'test\') → booking check asks about THAT destination, not \'live\'')
  {
    resetTestState()
    globalThis.__SCHED_T__.sites = [site({ deploy_destination: 'test' })]
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = false
    globalThis.__SCHED_T__.terminusHasUpdates = true

    await runUpstreamCheck()

    check('the booking check ran for (site-a, test)',
      globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls.some(c => c.site === 'site-a' && c.destination === 'test'),
      JSON.stringify(globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls))
    check('never asked about \'live\' for this site',
      !globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls.some(c => c.destination === 'live'),
      JSON.stringify(globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls))
    check('the created job carries the same non-default destination',
      globalThis.__SCHED_T__.createdJobs[0]?.deployDestination === 'test',
      JSON.stringify(globalThis.__SCHED_T__.createdJobs[0]))
  }

  console.log('\nrunPendingSecurityChecks — site has a non-default deploy_destination (\'test\') → booking check asks about THAT destination, not \'live\'')
  {
    resetTestState()
    globalThis.__SCHED_T__.sites = [site({ deploy_destination: 'test' })]
    globalThis.__SCHED_T__.pendingSecuritySites = [pendingSecuritySite()]
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = false
    globalThis.__SCHED_T__.terminusHasUpdates = true

    await runPendingSecurityChecks()

    check('the booking check ran for (site-a, test)',
      globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls.some(c => c.site === 'site-a' && c.destination === 'test'),
      JSON.stringify(globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls))
    check('never asked about \'live\' for this site',
      !globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls.some(c => c.destination === 'live'),
      JSON.stringify(globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls))
  }

  // ── Gap: every test above exercises runUpstreamCheck and runPendingSecurityChecks in
  // isolation, each with a FIXED mocked hasUnresolvedDeployment result for the whole call —
  // so none of them prove the two lanes actually interact through that shared signal the
  // way production does (lane A stages a site → its pipeline books a deploy → lane B, on
  // its own tick, must see that booking and stand down). This drives both lanes back to
  // back against the SAME site and site.
  //
  // SEAM: this suite fakes @/lib/supabase entirely (see file header), so createJob/executeJob
  // here are recorded, not run for real — runUpstreamCheck's simulated staging never actually
  // writes a scheduled_deployments row, so hasUnresolvedDeployment can't organically flip.
  // A fully-real version (stage → prebookDeployment → row written → next lane's SELECT sees
  // it) would need an integration test against a real or fully-faithful-fake Supabase table,
  // which this repo has neither of (dedupe-signal-check.ts's fake stubs the query-builder
  // shape, not persisted rows). Standing in for that write: flip hasUnresolvedDeploymentResult
  // to true between the two calls, representing "the booking runUpstreamCheck's job would
  // eventually create now exists" — and prove the second lane's call reacts to it.
  console.log('\nCross-lane: runUpstreamCheck stages a site, then runPendingSecurityChecks on the SAME site sees the resulting booking as unresolved and skips')
  {
    resetTestState()
    globalThis.__SCHED_T__.sites = [site()]
    globalThis.__SCHED_T__.pendingSecuritySites = [pendingSecuritySite()]
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = false
    globalThis.__SCHED_T__.terminusHasUpdates = true

    await runUpstreamCheck()
    check('runUpstreamCheck staged the site (no booking existed yet)',
      globalThis.__SCHED_T__.createdJobs.length === 1,
      JSON.stringify(globalThis.__SCHED_T__.createdJobs))

    // Simulate: staging's real pipeline (executeJob → prebookDeployment, not exercised by
    // this fake) has since written a pending scheduled_deployments row for (site-a, live).
    globalThis.__SCHED_T__.hasUnresolvedDeploymentResult = true

    await runPendingSecurityChecks()

    check('runPendingSecurityChecks did not re-stage the same site',
      globalThis.__SCHED_T__.createdJobs.length === 1, // still just the one from runUpstreamCheck
      JSON.stringify(globalThis.__SCHED_T__.createdJobs))
    check('terminus was not queried a second time',
      globalThis.__SCHED_T__.terminusCalls.length === 1,
      JSON.stringify(globalThis.__SCHED_T__.terminusCalls))
    check('the pending security flag was left set (deferred, not dropped)',
      globalThis.__SCHED_T__.clearedPending.length === 0)
    check('both lanes asked about the same (site, destination) the booking was made for',
      globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls.filter(c => c.site === 'site-a' && c.destination === 'live').length === 2,
      JSON.stringify(globalThis.__SCHED_T__.hasUnresolvedDeploymentCalls))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

await run()
