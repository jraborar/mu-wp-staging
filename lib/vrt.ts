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
}

export interface VrtRun {
  id: string
  site: string
  status: 'running' | 'awaiting_candidate' | 'completed' | 'failed'
  results: VrtRunResult[]
  flagged_count: number
  report_url: string
}

// Pantheon multidev URL: https://<multidev>-<site>.pantheonsite.io
export function multidevUrl(site: string, multidev: string): string {
  return `https://${multidev}-${site}.pantheonsite.io`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Phase 1 — capture the multidev BEFORE updates. Returns { run_id, report_url }
// or null. Non-blocking on mu-vrt's side (202); the capture runs in background
// there and is finished well before we reach the compare phase.
export async function startBaseline(
  site: string,
  multidev: string,
): Promise<{ run_id: string; report_url: string } | null> {
  const base = multidevUrl(site, multidev)
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

async function waitForStatus(
  runId: string,
  want: VrtRun['status'] | VrtRun['status'][],
  { timeoutMs = 180_000, everyMs = 5_000 }: { timeoutMs?: number; everyMs?: number } = {},
): Promise<VrtRun | null> {
  const wants = Array.isArray(want) ? want : [want]
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await getRun(runId)
    if (run && wants.includes(run.status)) return run
    if (run?.status === 'failed') return run
    await sleep(everyMs)
  }
  return null
}

// Phase 2 — capture the multidev AFTER updates and diff vs the stored baseline.
// Waits for the baseline to be ready, kicks the compare, then polls to completion.
// Returns the finalized run (with per-path results) or null.
export async function finishCompare(site: string, multidev: string, runId: string): Promise<VrtRun | null> {
  // The baseline capture almost always finished during the (multi-minute) update
  // cycle, but confirm it reached awaiting_candidate before comparing.
  const ready = await waitForStatus(runId, 'awaiting_candidate', { timeoutMs: 120_000 })
  if (!ready || ready.status !== 'awaiting_candidate') {
    console.error('[vrt] baseline never reached awaiting_candidate — skipping compare')
    return null
  }

  const base = multidevUrl(site, multidev)
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

  return waitForStatus(runId, ['completed', 'failed'], { timeoutMs: 300_000 })
}
