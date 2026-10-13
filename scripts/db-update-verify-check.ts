// Regression coverage for the `wp core update-db` soft-pass defect in lib/staging.ts
// (fix: dae4517, "fix(staging): fail closed when wp core update-db leaves schema
// incomplete"). The bug: a non-zero / killed `wp core update-db` (Exit 137 OOM on
// riverbed-new, mu-261013) was logged as a soft warning and the run STILL finalized
// `completed`, so an incomplete DB upgrade was reported green and its pre-booked deploy
// stayed armed.
//
// The fix (runStagingPipeline, the DB-update block gated on job.upstreamUpdated):
//   - exit 0                      → "Database updated", finalize completed (unchanged)
//   - exit non-zero, re-verify by comparing the code-required $wp_db_version
//     (`wp eval 'global $wp_db_version; echo $wp_db_version;'`) against the applied
//     db_version (`wp option get db_version`), parsed via parseDbVersion():
//       · versions equal          → success-with-warning, finalize completed
//       · versions differ OR a
//         verify we cannot read    → dbUpdateFailed → finalize FAILED, post a
//                                    "database update incomplete" Slack branch, and
//                                    cancel the pre-booked deploy (reconcileDeployment(job,false))
//
// There is no test runner in this app (see the sibling scripts/*-check.ts); this drives
// the REAL exported executeJob() → runStagingPipeline() with every I/O boundary faked
// (terminus run/runStream, jobStore finish/log, schedule reconcile, slack, supabase, vrt,
// sites), steering the terminus conversation by command match so the pipeline reaches the
// DB-update block with job.upstreamUpdated set — then observes exactly what it did: the
// terminal status handed to finishJob/finalizeStagingRecord, whether the DB schema was
// re-verified, the Slack branch fired, and the keep/cancel flag passed to
// reconcileDeployment. parseDbVersion is unit-tested directly (it is exported as a test
// seam). Nothing shells out to real terminus.
//
// No test runner: `npm run check:db-update-verify` (Node strips the types).
import { register } from 'node:module'

const ROOT = new URL('../', import.meta.url).href

declare global {
  // eslint-disable-next-line no-var
  var __STG_T__: {
    // scenario inputs (steer the terminus fake)
    updateDbCode: number
    requiredOut: string
    appliedOut: string
    // observed outputs
    runCalls: string[]
    runStreamCalls: string[]
    finishCalls: string[]
    reconcileCalls: Array<{ keep: boolean }>
    finalizeStatus: string[]
    threadSteps: string[]
    notifies: Array<{ text: string }>
    logs: Array<{ type: string; msg: string }>
  }
}

function resetTestState(): void {
  globalThis.__STG_T__ = {
    updateDbCode: 0,
    requiredOut: '',
    appliedOut: '',
    runCalls: [],
    runStreamCalls: [],
    finishCalls: [],
    reconcileCalls: [],
    finalizeStatus: [],
    threadSteps: [],
    notifies: [],
    logs: [],
  }
}
resetTestState()

// ── Fakes for every I/O boundary lib/staging.ts imports. Each reads/writes
// globalThis.__STG_T__ at CALL time, so one registered module instance is reused across
// every scenario via resetTestState(). parseWpJson is the REAL semantics (JSON.parse) so
// the pipeline's diffstat/upstream-list parsing behaves honestly.
const fakes: Record<string, string> = {
  '@/lib/terminus': `
    const T = () => globalThis.__STG_T__
    // Steer run() output by command substring. Order matters: the DB-verify eval contains
    // 'wp_db_version' (checked before the plain 'db_version' of option get).
    export function run(cmd) {
      T().runCalls.push(cmd)
      let stdout = ''
      if (cmd.includes('auth:whoami')) stdout = 'Logged in as: consultant@pantheon.io'
      else if (cmd.includes('connection_mode')) stdout = 'git'
      else if (cmd.includes('env:diffstat')) stdout = '[]'
      else if (cmd.includes('site:info')) stdout = JSON.stringify({ label: 'Riverbed New', max_num_cdes: 10, framework: 'wordpress', upstream_product_label: 'WordPress' })
      else if (cmd.includes('multidev:list')) stdout = ''
      else if (cmd.includes('env:info')) stdout = JSON.stringify({ initialized: true, php_version: '8.2' })
      else if (cmd.includes('upstream:updates:list')) stdout = JSON.stringify([{ message: 'Update WordPress to 6.9', hash: 'abc123' }])
      else if (cmd.includes('env:code-log')) stdout = JSON.stringify([{ hash: 'deadbeef' }])
      else if (cmd.includes('core version')) stdout = '6.9'
      else if (cmd.includes('wp_db_version')) stdout = T().requiredOut   // the code-required schema (wp eval)
      else if (cmd.includes('option get db_version')) stdout = T().appliedOut // the applied schema
      return Promise.resolve({ stdout, stderr: '', code: 0 })
    }
    export function runStream(cmd, onLine) {
      T().runStreamCalls.push(cmd)
      if (cmd.includes('core update-db')) {
        if (onLine) onLine('Running database update routines...')
        return Promise.resolve({ code: T().updateDbCode })
      }
      return Promise.resolve({ code: 0 }) // multidev:create, upstream apply, commits, cache flush
    }
    export function shellEscape(s) { return "'" + String(s).replace(/'/g, "'\\\\''") + "'" }
    export function cleanJson(s) { return s }
    export const terminusPhp = { enterWith() {}, run(_ctx, fn) { return fn() }, getStore() { return undefined } }
  `,
  '@/lib/jobStore': `
    export function appendLog(job, type, msg) { (job.logs ||= []).push({ type, msg }); globalThis.__STG_T__.logs.push({ type, msg }) }
    export function finishJob(job, status) { job.status = status; globalThis.__STG_T__.finishCalls.push(status) }
    export function setStep() {}
    export function waitForApproval() { return Promise.resolve(true) }
  `,
  '@/lib/sites': `
    export function getSite() { return Promise.resolve({ site: 'riverbed-new', machine_name: 'riverbed-new', platform: 'wp-single', php_version: '8.2', deploy_destination: 'live' }) }
    export function updateSite() { return Promise.resolve() }
  `,
  '@/lib/schedule': `
    export function prebookDeployment() { return Promise.resolve() }
    export function reconcileDeployment(job, keep) { globalThis.__STG_T__.reconcileCalls.push({ keep }); return Promise.resolve() }
    export function cancelStaleBooking() { return Promise.resolve() }
  `,
  '@/lib/multidevCleanup': `
    export function selectStaleMultidevs() { return [] }
  `,
  '@/lib/wordpress': `
    export function buildCommitMessage() { return 'msg' }
    export function parseWpJson(s) { return JSON.parse(s) }
    export function parseWpJsonStrict(s) { return JSON.parse(s) }
  `,
  '@/lib/supabase': `
    export function createStagingRecord() { return Promise.resolve() }
    export function finalizeStagingRecord(id, rec) { globalThis.__STG_T__.finalizeStatus.push(rec.status); return Promise.resolve() }
    export function getSiteUpdatePrefs() { return Promise.resolve(null) }
    export function getSiteVrtEnabled() { return Promise.resolve(false) }
  `,
  '@/lib/vrt': `
    export function startBaseline() { return Promise.resolve(null) }
    export function finishCompare() { return Promise.resolve(null) }
  `,
  '@/lib/slack': `
    export function startStagingThread() { return Promise.resolve('THREAD_TS') }
    export function postThreadStep(ts, msg) { globalThis.__STG_T__.threadSteps.push(msg); return Promise.resolve() }
    export function postThreadBlocks() { return Promise.resolve() }
    export function notifyInThread(ts, blocks, text) { globalThis.__STG_T__.notifies.push({ text }); return Promise.resolve() }
    export function buildApprovalBlocks() { return {} }
    export function buildCompleteBlocks() { return { kind: 'complete' } }
    export function buildFailedBlocks() { return { kind: 'failed' } }
    export function buildPausedBlocks() { return {} }
    export function buildCancelledBlocks() { return {} }
    export function buildLongRunningBlocks() { return {} }
    export function buildMultidevReadyBlocks() { return { kind: 'multidev' } }
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

const { executeJob, parseDbVersion } = await import('../lib/staging.ts')

// Env the pipeline hard-requires. No TERMINUS_TOKEN so the auth:login call is skipped;
// PANTHEON_SSH_KEY must be truthy or the pipeline throws before any WP step.
delete process.env.TERMINUS_TOKEN
process.env.PANTHEON_SSH_KEY = 'test-key'

// ── fixtures ─────────────────────────────────────────────────────────────────
// A WP-single job already past upstream-apply: skipUpstream false so the real upstream
// branch sets job.upstreamUpdated = true (gating the DB-update block); skipPluginsThemes
// true so the plugin/theme sub-pipeline is bypassed and the only terminus steering needed
// is for the DB block. deployDestination 'live' so reconcileDeployment is actually called.
function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    site: 'riverbed-new',
    multidev: 'mu-261013',
    startedAt: Date.now(),
    status: 'running',
    logs: [] as Array<{ type: string; msg: string }>,
    skipUpstream: false,
    skipPluginsThemes: true,
    acceptUpstream: false,
    upstreamUpdated: false,
    upstreamConflict: false,
    upstreamConflictFiles: [] as string[],
    upstreamUpdates: [] as unknown[],
    plugins: { updated: [] as string[], skipped: [] as string[], checkFailed: false },
    themes: { updated: [] as string[], skipped: [] as string[], checkFailed: false },
    deployDestination: 'live',
    securityFastTrack: false,
    cancelRequested: false,
    ...overrides,
  }
}

const DB_INCOMPLETE = 'database update incomplete'

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`) }
}
const verifyAsked = () => globalThis.__STG_T__.runCalls.some(c => c.includes('wp_db_version'))

async function run() {
  console.log('\nexit 0 → completed, DB schema never re-verified (happy path, unchanged)')
  {
    resetTestState()
    globalThis.__STG_T__.updateDbCode = 0
    await executeJob(job() as never)

    check('finalized completed', globalThis.__STG_T__.finishCalls.at(-1) === 'completed',
      JSON.stringify(globalThis.__STG_T__.finishCalls))
    check('staging record saved completed', globalThis.__STG_T__.finalizeStatus.at(-1) === 'completed',
      JSON.stringify(globalThis.__STG_T__.finalizeStatus))
    check('logged "Database updated"', globalThis.__STG_T__.logs.some(l => l.msg === 'Database updated'))
    check('no schema re-verify was performed on a clean exit', !verifyAsked(),
      JSON.stringify(globalThis.__STG_T__.runCalls.filter(c => c.includes('db_version'))))
    check('pre-booked deploy kept (reconcile keep=true)',
      globalThis.__STG_T__.reconcileCalls.at(-1)?.keep === true,
      JSON.stringify(globalThis.__STG_T__.reconcileCalls))
  }

  console.log('\nexit non-zero + applied schema already matches required → completed-with-warning (riverbed-new Exit 137)')
  {
    resetTestState()
    globalThis.__STG_T__.updateDbCode = 137
    globalThis.__STG_T__.requiredOut = '61833'
    globalThis.__STG_T__.appliedOut = '61833'
    await executeJob(job() as never)

    check('the schema WAS re-verified (new behavior — old code never looked)', verifyAsked())
    check('both versions were read (eval + option get)',
      globalThis.__STG_T__.runCalls.some(c => c.includes('wp_db_version')) &&
      globalThis.__STG_T__.runCalls.some(c => c.includes('option get db_version')),
      JSON.stringify(globalThis.__STG_T__.runCalls.filter(c => c.includes('db_version'))))
    check('finalized completed (upgrade landed despite the kill)',
      globalThis.__STG_T__.finishCalls.at(-1) === 'completed', JSON.stringify(globalThis.__STG_T__.finishCalls))
    check('logged the "despite non-zero exit — treating as updated" warning',
      globalThis.__STG_T__.logs.some(l => l.msg.includes('despite non-zero exit')))
    check('no "database update incomplete" Slack branch fired',
      !globalThis.__STG_T__.notifies.some(n => n.text.includes(DB_INCOMPLETE)))
    check('pre-booked deploy kept (reconcile keep=true)',
      globalThis.__STG_T__.reconcileCalls.at(-1)?.keep === true,
      JSON.stringify(globalThis.__STG_T__.reconcileCalls))
  }

  console.log('\nexit non-zero + applied schema BELOW required → fail closed (the core regression)')
  {
    resetTestState()
    globalThis.__STG_T__.updateDbCode = 137
    globalThis.__STG_T__.requiredOut = '61833'
    globalThis.__STG_T__.appliedOut = '60421'
    await executeJob(job() as never)

    check('finalized FAILED, not completed (old soft-pass would say completed)',
      globalThis.__STG_T__.finishCalls.at(-1) === 'failed', JSON.stringify(globalThis.__STG_T__.finishCalls))
    check('staging record saved failed', globalThis.__STG_T__.finalizeStatus.at(-1) === 'failed',
      JSON.stringify(globalThis.__STG_T__.finalizeStatus))
    check('"database update incomplete" Slack branch fired',
      globalThis.__STG_T__.notifies.some(n => n.text.includes(DB_INCOMPLETE)),
      JSON.stringify(globalThis.__STG_T__.notifies))
    check('a failed-staging step was posted to the thread',
      globalThis.__STG_T__.threadSteps.some(s => s.includes(DB_INCOMPLETE)))
    check('pre-booked deploy CANCELLED (reconcile keep=false) — incomplete schema never promoted',
      globalThis.__STG_T__.reconcileCalls.at(-1)?.keep === false,
      JSON.stringify(globalThis.__STG_T__.reconcileCalls))
  }

  console.log('\nexit non-zero + verify output unreadable (parseDbVersion → null) → fail closed')
  {
    resetTestState()
    globalThis.__STG_T__.updateDbCode = 137
    globalThis.__STG_T__.requiredOut = ''                 // empty → null
    globalThis.__STG_T__.appliedOut = 'Error: could not connect'  // no integer → null
    await executeJob(job() as never)

    check('finalized FAILED (unreadable verify must not pass)',
      globalThis.__STG_T__.finishCalls.at(-1) === 'failed', JSON.stringify(globalThis.__STG_T__.finishCalls))
    check('"database update incomplete" Slack branch fired',
      globalThis.__STG_T__.notifies.some(n => n.text.includes(DB_INCOMPLETE)))
    check('pre-booked deploy CANCELLED (reconcile keep=false)',
      globalThis.__STG_T__.reconcileCalls.at(-1)?.keep === false,
      JSON.stringify(globalThis.__STG_T__.reconcileCalls))
  }

  // ── parseDbVersion unit tests (exported as a test seam) ──────────────────────
  console.log('\nparseDbVersion — the parser that decides equal / differ / unreadable')
  {
    check('a bare integer line parses', parseDbVersion('61833') === 61833)
    check('an integer trailing PHP deprecation/notice noise parses (WP-CLI prints notices first)',
      parseDbVersion('PHP Deprecated:  Return type ... in /code/wp-includes/x.php on line 42\nNotice: undefined\n61833') === 61833,
      String(parseDbVersion('PHP Deprecated:  ...\nNotice: undefined\n61833')))
    check('whitespace around the integer is tolerated', parseDbVersion('   61833  \n') === 61833)
    check('output with no integer → null (fails closed)',
      parseDbVersion('Error establishing a database connection') === null)
    check('empty output → null (fails closed)', parseDbVersion('') === null)
    check('a version string like 6.9.1 is NOT misread as an integer → null',
      parseDbVersion('6.9.1') === null, String(parseDbVersion('6.9.1')))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

await run()
