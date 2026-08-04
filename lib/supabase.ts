import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { UpdateSummary } from '@/lib/wordpress'

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
  upstream?: string
  upstream_updated: boolean
  upstream_skipped_reason?: string
  plugins_updated: UpdateSummary['updated']
  plugins_skipped: UpdateSummary['skipped']
  themes_updated: UpdateSummary['updated']
  themes_skipped: UpdateSummary['skipped']
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
    .select('id, site, site_name, multidev, upstream, upstream_updated, upstream_skipped_reason, plugins_updated, plugins_skipped, themes_updated, themes_skipped, status, started_at, completed_at')
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) console.error('[supabase] listStagingHistory:', error.message)
  return data ?? []
}
