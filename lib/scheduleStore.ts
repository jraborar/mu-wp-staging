import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

function getClient(): SupabaseClient | null {
  if (!url || !key) return null
  return createClient(url, key)
}

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'bimonthly-week-of-15' | 'security-only' | 'once'

export interface StagingSchedule {
  id: string
  site: string
  site_name?: string
  cadence: Cadence
  // weekly / biweekly / monthly
  day_of_week?: number          // 0=Sun … 6=Sat
  week_of_month?: number        // 1–4, -1=last; monthly only
  biweekly_reference_date?: string  // ISO date anchor for biweekly parity
  // bimonthly-week-of-15
  bimonthly_ref_month?: number  // 1–12: first "on" month
  bimonthly_day_of_week?: number
  security_check_enabled: boolean
  security_check_pending: boolean
  deploy_days?: number
  deploy_destination?: string
  // options
  skip_upstream: boolean
  skip_plugins_themes: boolean
  active: boolean
  created_at: string
  last_staged_at?: string
  next_staging_at?: string
}

export async function listSchedules(): Promise<StagingSchedule[]> {
  const db = getClient()
  if (!db) return []
  const { data, error } = await db
    .from('staging_schedules')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) console.error('[supabase] listSchedules:', error.message)
  return data ?? []
}

export async function getSchedule(id: string): Promise<StagingSchedule | null> {
  const db = getClient()
  if (!db) return null
  const { data, error } = await db
    .from('staging_schedules')
    .select('*')
    .eq('id', id)
    .single()
  if (error) console.error('[supabase] getSchedule:', error.message)
  return data ?? null
}

export async function createSchedule(
  input: Omit<StagingSchedule, 'id' | 'created_at' | 'last_staged_at'>,
): Promise<StagingSchedule | null> {
  const db = getClient()
  if (!db) return null
  const { data, error } = await db
    .from('staging_schedules')
    .insert(input)
    .select()
    .single()
  if (error) console.error('[supabase] createSchedule:', error.message)
  return data ?? null
}

export async function updateSchedule(
  id: string,
  updates: Partial<Omit<StagingSchedule, 'id' | 'created_at'>>,
): Promise<StagingSchedule | null> {
  const db = getClient()
  if (!db) return null
  const { data, error } = await db
    .from('staging_schedules')
    .update(updates)
    .eq('id', id)
    .select()
    .single()
  if (error) console.error('[supabase] updateSchedule:', error.message)
  return data ?? null
}

export async function deleteSchedule(id: string): Promise<void> {
  const db = getClient()
  if (!db) return
  const { error } = await db.from('staging_schedules').delete().eq('id', id)
  if (error) console.error('[supabase] deleteSchedule:', error.message)
}

export async function getDueSchedules(): Promise<StagingSchedule[]> {
  const db = getClient()
  if (!db) return []
  const now = new Date().toISOString()
  const { data, error } = await db
    .from('staging_schedules')
    .select('*')
    .eq('active', true)
    .lte('next_staging_at', now)
    .not('cadence', 'eq', 'security-only')
  if (error) console.error('[supabase] getDueSchedules:', error.message)
  return data ?? []
}

export async function updateScheduleAfterRun(id: string, nextAt: Date | null): Promise<void> {
  const db = getClient()
  if (!db) return
  const { error } = await db
    .from('staging_schedules')
    .update({
      last_staged_at: new Date().toISOString(),
      next_staging_at: nextAt?.toISOString() ?? null,
    })
    .eq('id', id)
  if (error) console.error('[supabase] updateScheduleAfterRun:', error.message)
}

// For security check: sites eligible for early trigger (bimonthly-week-of-15 with security_check_enabled)
export async function getSecurityCheckSites(stagedWithinDays = 14): Promise<StagingSchedule[]> {
  const db = getClient()
  if (!db) return []
  const cutoff = new Date(Date.now() - stagedWithinDays * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await db
    .from('staging_schedules')
    .select('*')
    .eq('active', true)
    .in('cadence', ['bimonthly-week-of-15', 'security-only'])
    .eq('security_check_enabled', true)
    .or(`last_staged_at.is.null,last_staged_at.lt.${cutoff}`)
  if (error) console.error('[supabase] getSecurityCheckSites:', error.message)
  return data ?? []
}

export async function markSecurityCheckPending(id: string): Promise<void> {
  const db = getClient()
  if (!db) return
  await db.from('staging_schedules').update({ security_check_pending: true }).eq('id', id)
}

export async function clearSecurityCheckPending(id: string): Promise<void> {
  const db = getClient()
  if (!db) return
  await db.from('staging_schedules').update({ security_check_pending: false }).eq('id', id)
}

export async function getPendingSecuritySites(): Promise<StagingSchedule[]> {
  const db = getClient()
  if (!db) return []
  const { data, error } = await db
    .from('staging_schedules')
    .select('*')
    .eq('active', true)
    .eq('security_check_pending', true)
  if (error) console.error('[supabase] getPendingSecuritySites:', error.message)
  return data ?? []
}

export async function getSchedulerState(key: string): Promise<string | null> {
  const db = getClient()
  if (!db) return null
  const { data } = await db
    .from('scheduler_state')
    .select('value')
    .eq('key', key)
    .single()
  return data?.value ?? null
}

export async function setSchedulerState(key: string, value: string): Promise<void> {
  const db = getClient()
  if (!db) return
  await db
    .from('scheduler_state')
    .upsert({ key, value }, { onConflict: 'key' })
}
