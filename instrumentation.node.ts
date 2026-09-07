import { cleanupStaleRunningRecords } from '@/lib/supabase'
import { getAllJobs } from '@/lib/jobStore'
import { startSocketMode } from '@/lib/socketMode'
import { startScheduler } from '@/lib/scheduler'

/**
 * Startup side effects, and how to opt out of them.
 *
 * `DISABLE_BACKGROUND_JOBS=1` skips all three. Set it for ANY instance that is
 * not the one production instance — local `npm run dev`, a preview deploy, a
 * one-off container — because every one of these reaches straight into the
 * shared production Supabase:
 *
 *   - startScheduler() calls runDueJobs() IMMEDIATELY, with no delay, then
 *     every 5 minutes. A second instance is a second scheduler: two processes
 *     racing to stage the same site. mu-staging has no atomic claim, so both
 *     can win.
 *   - startSocketMode() opens a second Slack Socket Mode client on the same
 *     channel, so every interaction is delivered twice.
 *   - cleanupStaleRunningRecords() is the sharp one — see below.
 *
 * Before this flag existed there was no way to run this app locally without
 * becoming a second production scheduler. Running `npm run dev` against
 * .env.local was enough.
 */
export async function register() {
  if (process.env.DISABLE_BACKGROUND_JOBS === '1') {
    console.log(
      '[startup] DISABLE_BACKGROUND_JOBS=1 — skipping scheduler, Slack Socket Mode ' +
        'and stale-record cleanup. This instance will not act on its own.',
    )
    return
  }

  // NOTE: this marks every `running` row older than STALE_GRACE_MINUTES (5) as
  // failed, excluding only the ids in THIS process's in-memory job store. On a
  // fresh process that store is empty, so the exclusion does nothing and the
  // grace period is the only protection — against real runs whose median is 12
  // minutes and whose p90 is 48. A restart mid-run therefore marks a live run
  // failed. Pre-existing and NOT fixed here; it needs an owner column or a
  // heartbeat, not a longer timeout. Tracked in the PR that added this flag.
  const activeIds = getAllJobs()
    .filter((j) => j.status === 'running')
    .map((j) => j.id)

  await cleanupStaleRunningRecords(activeIds)

  void startSocketMode()
  startScheduler()
}
