// mu-vrt client for Model-B (staging) before/after visual regression.
//
// The staging engine calls startBaseline() right after the multidev is created
// (fresh from live, pre-update) and finishCompare() after all updates are
// committed. mu-vrt captures the SAME multidev twice and diffs after-vs-before,
// so the result isolates exactly what the updates changed — self-calibrated per
// run on the multidev env (no live→multidev threshold transfer).
//
// Every function is best-effort: any failure returns null and is logged, never
// thrown, so a VRT hiccup can never break or block a staging run.

const MU_VRT_URL = (process.env.NEXT_PUBLIC_MU_VRT_URL || 'https://mu-vrt-production.up.railway.app').replace(/\/$/, '')

export interface VrtRunResult {
  path: string
  label: string
  threshold: number
  mismatch_pct: number | null
  flagged: boolean
  baseline_url: string | null
  candidate_url: string | null
  diff_url: string | null
  error: string | null
  note?: string | null   // e.g. "page height changed 3054px → 3210px"
}

export interface VrtRun {
  id: string
  site: string
  status: 'running' | 'awaiting_candidate' | 'completed' | 'failed'
  results: VrtRunResult[]
  flagged_count: number
  report_url: string
}

// Pantheon multidev URL: https://<multidev>-<machineName>.pantheonsite.io
// NOTE: the hostname uses the Pantheon MACHINE NAME, never the site UUID (the
// registry key). Terminus accepts UUIDs; pantheonsite.io hostnames do not.
export function multidevUrl(machineName: string, multidev: string): string {
  return `https://${multidev}-${machineName}.pantheonsite.io`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Phase 1 — capture the multidev BEFORE updates. Returns { run_id, report_url }
// or null. Non-blocking on mu-vrt's side (202); the capture runs in background
// there and is finished well before we reach the compare phase.
export async function startBaseline(
  site: string,          // registry key (UUID) — how mu-vrt looks up VRT config
  multidev: string,
  machineName: string,   // Pantheon machine name — for the capture URL host
): Promise<{ run_id: string; report_url: string } | null> {
  const base = multidevUrl(machineName, multidev)
  try {
    const r = await fetch(`${MU_VRT_URL}/api/baseline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site, multidev, base }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok || !data?.run_id) {
      console.error('[vrt] baseline failed:', data?.error || r.status)
      return null
    }
    return { run_id: data.run_id, report_url: data.report_url }
  } catch (e) {
    console.error('[vrt] baseline error:', e instanceof Error ? e.message : String(e))
    return null
  }
}

// Expire a report: tell mu-vrt to purge the run's screenshots + row. Best-effort;
// a 404 (already gone) counts as success. Returns true if it's gone afterwards.
export async function deleteVrtRun(runId: string): Promise<boolean> {
  try {
    const r = await fetch(`${MU_VRT_URL}/api/runs/${runId}`, { method: 'DELETE' })
    if (r.ok || r.status === 404) return true
    console.error('[vrt] deleteVrtRun failed:', r.status)
    return false
  } catch (e) {
    console.error('[vrt] deleteVrtRun error:', e instanceof Error ? e.message : String(e))
    return false
  }
}

// Extract the run id from a stored report URL (…/report/<id>).
export function runIdFromReportUrl(url: string): string | null {
  const m = url.match(/\/report\/([0-9a-f-]{6,})/i)
  return m ? m[1] : null
}

async function getRun(runId: string): Promise<VrtRun | null> {
  try {
    const r = await fetch(`${MU_VRT_URL}/api/runs/${runId}`, { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as VrtRun
  } catch {
    return null
  }
}

// How long to wait scales with the site's path count, because that is what the
// work scales with: mu-vrt captures every path (twice for a baseline, to measure
// the per-run noise floor) sequentially in one browser, and concurrent runs each
// launch their own. A flat 120s was fine for a 5-path site running alone; it gave
// up on apexorderpickup's 13 paths while eleven staging runs and a 13-path
// calibration shared the worker, and the run was reported 'incomplete' even
// though the baseline finished moments later.
const BASELINE_MS_PER_PATH = 45_000
const COMPARE_MS_PER_PATH  = 60_000
const MIN_WAIT_MS =  2 * 60_000
const MAX_WAIT_MS = 20 * 60_000

function budgetFor(paths: number, msPerPath: number): number {
  if (paths <= 0) return MIN_WAIT_MS
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, paths * msPerPath))
}

async function waitForStatus(
  runId: string,
  want: VrtRun['status'] | VrtRun['status'][],
  { msPerPath, everyMs = 5_000 }: { msPerPath: number; everyMs?: number },
): Promise<VrtRun | null> {
  const wants = Array.isArray(want) ? want : [want]
  // Start on the floor, then re-budget once the run tells us how many paths it
  // has — the row exists from the moment phase 1 is created, so this is known on
  // the first poll and costs no extra request.
  let deadline = Date.now() + MIN_WAIT_MS
  let sized = false
  while (Date.now() < deadline) {
    const run = await getRun(runId)
    if (run && !sized) {
      const paths = run.results?.length ?? 0
      if (paths > 0) {
        deadline = Date.now() + budgetFor(paths, msPerPath)
        sized = true
      }
    }
    if (run && wants.includes(run.status)) return run
    if (run?.status === 'failed') return run
    await sleep(everyMs)
  }
  return null
}

// Phase 2 — capture the multidev AFTER updates and diff vs the stored baseline.
// Waits for the baseline to be ready, kicks the compare, then polls to completion.
// Returns the finalized run (with per-path results) or null.
export async function finishCompare(multidev: string, machineName: string, runId: string): Promise<VrtRun | null> {
  // The baseline capture almost always finished during the (multi-minute) update
  // cycle, but confirm it reached awaiting_candidate before comparing.
  const ready = await waitForStatus(runId, 'awaiting_candidate', { msPerPath: BASELINE_MS_PER_PATH })
  if (!ready) {
    console.error('[vrt] baseline never reported a terminal status — skipping compare')
    return null
  }
  if (ready.status !== 'awaiting_candidate') {
    // mu-vrt finalizes a baseline that captured NOTHING as 'failed' rather than
    // parking it. Hand that run back (not null) so the caller can report why no
    // comparison ran, per path, instead of implying one succeeded.
    console.error(`[vrt] baseline ended '${ready.status}' — skipping compare`)
    return ready
  }

  const base = multidevUrl(machineName, multidev)
  try {
    const r = await fetch(`${MU_VRT_URL}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: runId, base }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      console.error('[vrt] compare failed:', data?.error || r.status)
      return null
    }
  } catch (e) {
    console.error('[vrt] compare error:', e instanceof Error ? e.message : String(e))
    return null
  }

  return waitForStatus(runId, ['completed', 'failed'], { msPerPath: COMPARE_MS_PER_PATH })
}
