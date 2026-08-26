import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { UpdateSummary } from '@/lib/wordpress'
import type { SecurityAdvisory } from '@/lib/jobStore'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

export function isConfigured(): boolean {
  return Boolean(url && key)
}

let _client: SupabaseClient | null = null
function getClient(): SupabaseClient | null {
  if (!isConfigured()) return null
  if (!_client) _client = createClient(url, key)
  return _client
}

export interface StagingRecord {
  id: string
  site: string
  site_name?: string
  multidev: string
  platform?: string
  upstream?: string
  upstream_updated: boolean
  upstream_skipped_reason?: string
  // Paths the upstream merge could not reconcile — the list we hand the customer.
  upstream_conflict_files?: string[]
  upstream_updates?: Array<{ message: string; hash?: string }>
  upstream_old_version?: string
  upstream_new_version?: string
  plugins_updated: UpdateSummary['updated']
  plugins_skipped: UpdateSummary['skipped']
  themes_updated: UpdateSummary['updated']
  themes_skipped: UpdateSummary['skipped']
  // Drupal only — see sql/014. Modules/themes reuse plugins_/themes_updated above.
  composer_deps_updated?: UpdateSummary['updated']
  security_advisories?: SecurityAdvisory[]
  vrt_report_url?: string | null
  vrt_flagged_count?: number | null
  vrt_status?: string | null
  status: string
  started_at: string
  completed_at: string | null
  logs?: object[]
}

export async function createStagingRecord(
  id: string,
  data: Pick<StagingRecord, 'site' | 'multidev' | 'status' | 'started_at'>,
): Promise<void> {
  const db = getClient()
  if (!db) return
  const { error } = await db.from('staging_history').insert({
    id,
    ...data,
    upstream_updated: false,
    plugins_updated: [],
    plugins_skipped: [],
    themes_updated: [],
    themes_skipped: [],
    completed_at: null,
    logs: [],
  })
  if (error) console.error('[supabase] createStagingRecord:', error.message)
}

export async function finalizeStagingRecord(
  id: string,
  updates: Partial<Omit<StagingRecord, 'id' | 'site' | 'multidev' | 'started_at'>>,
): Promise<void> {
  const db = getClient()
  if (!db) return
  const { error } = await db.from('staging_history').update(updates).eq('id', id)
  if (error) console.error('[supabase] finalizeStagingRecord:', error.message)
}

const STALE_GRACE_MINUTES = 5
export async function cleanupStaleRunningRecords(activeJobIds: string[] = []): Promise<void> {
  const db = getClient()
  if (!db) return
  const cutoff = new Date(Date.now() - STALE_GRACE_MINUTES * 60 * 1000).toISOString()
  let query = db
    .from('staging_history')
    .update({ status: 'failed', completed_at: new Date().toISOString() })
    .eq('status', 'running')
    .is('completed_at', null)
    .lt('started_at', cutoff)
  if (activeJobIds.length > 0) {
    query = query.not('id', 'in', `(${activeJobIds.join(',')})`)
  }
  const { error } = await query
  if (error) console.error('[supabase] cleanupStaleRunningRecords:', error.message)
}

export async function listStagingHistory(limit = 30): Promise<Omit<StagingRecord, 'logs'>[]> {
  const db = getClient()
  if (!db) return []
  const { data, error } = await db
    .from('staging_history')
    .select('id, site, site_name, multidev, platform, upstream, upstream_updated, upstream_skipped_reason, upstream_conflict_files, upstream_old_version, upstream_new_version, upstream_updates, plugins_updated, plugins_skipped, themes_updated, themes_skipped, composer_deps_updated, security_advisories, vrt_report_url, vrt_flagged_count, vrt_status, status, started_at, completed_at')
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) console.error('[supabase] listStagingHistory:', error.message)
  return data ?? []
}

// True if a staging run already exists for this site + multidev name. Used by the
// auto upstream scan to avoid a duplicate run when the site was already staged
// today (manual, scheduled, or security — all now use the same mu-YYMMDD name).
export async function hasRunForMultidev(site: string, multidev: string): Promise<boolean> {
  const db = getClient()
  if (!db) return false
  const { data } = await db
    .from('staging_history')
    .select('id')
    .eq('site', site)
    .eq('multidev', multidev)
    .limit(1)
  return (data?.length ?? 0) > 0
}

// ── VRT report link expiry ──────────────────────────────────────────────────
// Runs with a shareable VRT report, newest first, for the cleanup sweep.
export async function listStagingWithVrt(): Promise<
  { id: string; site: string; started_at: string; vrt_report_url: string }[]
> {
  const db = getClient()
  if (!db) return []
  const { data, error } = await db
    .from('staging_history')
    .select('id, site, started_at, vrt_report_url')
    .not('vrt_report_url', 'is', null)
    .order('started_at', { ascending: false })
  if (error) { console.error('[supabase] listStagingWithVrt:', error.message); return [] }
  return (data ?? []) as { id: string; site: string; started_at: string; vrt_report_url: string }[]
}

// Null out the VRT link fields once the report is expired + its screenshots purged.
export async function clearStagingVrt(id: string): Promise<void> {
  const db = getClient()
  if (!db) return
  const { error } = await db
    .from('staging_history')
    .update({ vrt_report_url: null, vrt_flagged_count: null, vrt_status: null })
    .eq('id', id)
  if (error) console.error('[supabase] clearStagingVrt:', error.message)
}

// ── Per-site update preferences ───────────────────────────────────────────────

export interface SiteUpdatePrefs {
  site: string
  plugin_skips: string[]
  theme_skips: string[]
  updated_at: string
}

export async function getSiteUpdatePrefs(site: string): Promise<SiteUpdatePrefs | null> {
  const db = getClient()
  if (!db) return null
  const { data } = await db.from('site_update_prefs').select('*').eq('site', site).single()
  return data ?? null
}

export async function saveSiteUpdatePrefs(site: string, pluginSkips: string[], themeSkips: string[]): Promise<void> {
  const db = getClient()
  if (!db) return
  const { error } = await db.from('site_update_prefs').upsert({
    site, plugin_skips: pluginSkips, theme_skips: themeSkips, updated_at: new Date().toISOString(),
  }, { onConflict: 'site' })
  if (error) console.error('[supabase] saveSiteUpdatePrefs:', error.message)
}

// ── VRT gate ──────────────────────────────────────────────────────────────────
// Reads the shared `sites` registry (also written by mu-vrt) to decide whether a
// staging run should trigger a Model-B before/after VRT comparison. Returns false
// on any error so VRT is strictly opt-in and never blocks staging.
export async function getSiteVrtEnabled(site: string): Promise<boolean> {
  const db = getClient()
  if (!db) return false
  const { data, error } = await db
    .from('sites')
    .select('vrt_enabled, vrt_targets')
    .eq('site', site)
    .single()
  if (error || !data) return false
  const hasTargets = Array.isArray(data.vrt_targets) && data.vrt_targets.some((t: { path?: string }) => t?.path?.trim())
  return Boolean(data.vrt_enabled) && hasTargets
}

// ── Queries the shared scheduled_deployments table (mu_deployment uses same Supabase project)
// and returns the scheduled_for timestamps of all pending deployments on the given Manila date.
export async function getScheduledDeploymentTimes(manilaDateStr: string): Promise<string[]> {
  const db = getClient()
  if (!db) return []
  const dayStart = `${manilaDateStr}T00:00:00+08:00`
  const dayEnd   = `${manilaDateStr}T23:59:59+08:00`
  const { data, error } = await db
    .from('scheduled_deployments')
    .select('scheduled_for')
    .eq('status', 'pending')
    .gte('scheduled_for', dayStart)
    .lte('scheduled_for', dayEnd)
  if (error) console.error('[supabase] getScheduledDeploymentTimes:', error.message)
  return (data ?? []).map((r) => r.scheduled_for as string)
}
