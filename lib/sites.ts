import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { run, cleanJson } from '@/lib/terminus'

// Shared Sites registry client. Identical contract in mu-wp-staging + mu-deployment
// (Option A: each app writes directly to the shared `sites` table; guardrails live
// in Postgres). Keep this file in sync across both apps.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

function getClient(): SupabaseClient | null {
  if (!url || !key) return null
  return createClient(url, key)
}

export type Platform = 'wp-single' | 'wp-multisite' | 'drupal'
export type DeployDestination = 'dev' | 'test' | 'live' | 'multidev'

export interface Site {
  site: string
  site_name?: string | null
  platform: Platform
  parent_site?: string | null
  php_version?: string | null
  upstream?: string | null
  skip_upstream: boolean
  skip_plugins_themes: boolean
  deploy_days: number
  deploy_destination: DeployDestination
  vrt_paths: string[]
  active: boolean
  notes?: string | null
  created_at?: string
  updated_at?: string
}

// Pantheon machine-name shape (also allows UUIDs)
const SITE_RE = /^[a-z0-9.\-_]+$/i

export const MAX_VRT_PATHS = 70

// Normalize + validate VRT paths: trim, drop blanks, dedupe, cap at MAX_VRT_PATHS.
function cleanVrtPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  const cleaned = Array.from(
    new Set(paths.map((p) => String(p).trim()).filter(Boolean)),
  )
  if (cleaned.length > MAX_VRT_PATHS) {
    throw new Error(`Too many VRT paths (${cleaned.length}); max is ${MAX_VRT_PATHS}`)
  }
  return cleaned
}

export async function listSites(): Promise<Site[]> {
  const db = getClient()
  if (!db) return []
  const { data, error } = await db.from('sites').select('*').order('site', { ascending: true })
  if (error) console.error('[supabase] listSites:', error.message)
  return data ?? []
}

export async function getSite(site: string): Promise<Site | null> {
  const db = getClient()
  if (!db) return null
  const { data, error } = await db.from('sites').select('*').eq('site', site).single()
  if (error && error.code !== 'PGRST116') console.error('[supabase] getSite:', error.message)
  return data ?? null
}

// Best-effort resolve of site_name / upstream / php_version from terminus.
export async function resolveSiteMeta(
  site: string,
): Promise<{ site_name?: string; upstream?: string; php_version?: string }> {
  if (!SITE_RE.test(site)) return {}
  const meta: { site_name?: string; upstream?: string; php_version?: string } = {}
  try {
    const token = process.env.TERMINUS_TOKEN
    if (token) await run(`terminus auth:login --machine-token="${token}" 2>&1`)

    const info = await run(`terminus site:info ${site} --format=json 2>&1`)
    try {
      const d = JSON.parse(cleanJson(info.stdout))
      meta.site_name = d?.label ?? d?.name ?? undefined
      meta.upstream  = d?.upstream_product_label ?? d?.upstream ?? undefined
    } catch {}

    const envInfo = await run(`terminus env:info ${site}.dev --format=json 2>&1`)
    try {
      const e = JSON.parse(cleanJson(envInfo.stdout))
      if (e?.php_version) meta.php_version = String(e.php_version)
    } catch {}
  } catch {}
  return meta
}

// Idempotent create/refresh. Resolves terminus metadata but never clobbers
// existing user-set defaults — safe to call again as a "re-sync from Pantheon".
export async function registerSite(input: Partial<Site> & { site: string }): Promise<Site | null> {
  const db = getClient()
  if (!db) return null
  const site = input.site.trim()
  if (!SITE_RE.test(site)) throw new Error('Invalid site machine-name')

  const existing = await getSite(site)
  const meta = await resolveSiteMeta(site)

  const row = {
    site,
    site_name:           input.site_name          ?? meta.site_name   ?? existing?.site_name   ?? null,
    platform:            input.platform           ?? existing?.platform ?? 'wp-single',
    parent_site:         input.parent_site        ?? existing?.parent_site ?? null,
    php_version:         input.php_version        ?? meta.php_version ?? existing?.php_version ?? null,
    upstream:            input.upstream           ?? meta.upstream    ?? existing?.upstream    ?? null,
    skip_upstream:       input.skip_upstream       ?? existing?.skip_upstream       ?? false,
    skip_plugins_themes: input.skip_plugins_themes ?? existing?.skip_plugins_themes ?? false,
    deploy_days:         input.deploy_days         ?? existing?.deploy_days         ?? 1,
    deploy_destination:  input.deploy_destination  ?? existing?.deploy_destination  ?? 'live',
    vrt_paths:           input.vrt_paths !== undefined
                           ? cleanVrtPaths(input.vrt_paths)
                           : existing?.vrt_paths ?? [],
    active:              input.active              ?? existing?.active              ?? true,
    notes:               input.notes               ?? existing?.notes               ?? null,
  }

  const { data, error } = await db.from('sites').upsert(row, { onConflict: 'site' }).select().single()
  if (error) { console.error('[supabase] registerSite:', error.message); throw new Error(error.message) }
  return data ?? null
}

export async function updateSite(site: string, patch: Partial<Site>): Promise<Site | null> {
  const db = getClient()
  if (!db) return null
  const allowed: (keyof Site)[] = [
    'site_name', 'platform', 'parent_site', 'php_version', 'upstream',
    'skip_upstream', 'skip_plugins_themes', 'deploy_days', 'deploy_destination',
    'vrt_paths', 'active', 'notes',
  ]
  const updates: Record<string, unknown> = {}
  for (const k of allowed) if (k in patch && patch[k] !== undefined) updates[k] = patch[k]
  if ('vrt_paths' in updates) updates.vrt_paths = cleanVrtPaths(updates.vrt_paths)
  const { data, error } = await db.from('sites').update(updates).eq('site', site).select().single()
  if (error) { console.error('[supabase] updateSite:', error.message); throw new Error(error.message) }
  return data ?? null
}

export async function deleteSite(site: string): Promise<void> {
  const db = getClient()
  if (!db) return
  const { error } = await db.from('sites').delete().eq('site', site)
  if (error) console.error('[supabase] deleteSite:', error.message)
}

// One-time: fill php_version for any registered site missing it, via terminus.
export async function backfillPhpVersions(): Promise<{ site: string; php_version: string }[]> {
  const db = getClient()
  if (!db) return []
  const sites = await listSites()
  const filled: { site: string; php_version: string }[] = []
  for (const s of sites) {
    if (s.php_version) continue
    const meta = await resolveSiteMeta(s.site)
    if (meta.php_version) {
      await db.from('sites').update({ php_version: meta.php_version }).eq('site', s.site)
      filled.push({ site: s.site, php_version: meta.php_version })
    }
  }
  return filled
}
