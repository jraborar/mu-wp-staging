import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

function getDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  return { db: url && key ? createClient(url, key) : null }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { db } = getDb()
  if (!db) return Response.json({ error: 'Supabase not configured' }, { status: 500 })

  const { data, error } = await db
    .from('staging_history')
    .select('id, site_name, multidev, status, started_at, completed_at, logs')
    .eq('id', id)
    .single()

  if (error) return Response.json({ error: error.message }, { status: 404 })
  return Response.json(data)
}

// Cancel a paused history record that has fallen out of the in-memory job store
// (e.g. after a server restart). The live cancel route requires jobStore presence;
// this route bypasses it by writing directly to Supabase.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { db } = getDb()
  if (!db) return Response.json({ error: 'Supabase not configured' }, { status: 500 })

  const body = await request.json().catch(() => null)
  if (body?.action !== 'cancel') return Response.json({ error: 'unsupported action' }, { status: 400 })

  const { data: existing, error: fetchErr } = await db
    .from('staging_history').select('status').eq('id', id).single()
  if (fetchErr || !existing) return Response.json({ error: 'Record not found' }, { status: 404 })
  if (existing.status !== 'paused') {
    return Response.json({ error: `Record is not paused (status: ${existing.status})` }, { status: 409 })
  }

  const { data, error } = await db
    .from('staging_history')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, status, completed_at').single()

  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json(data)
}
