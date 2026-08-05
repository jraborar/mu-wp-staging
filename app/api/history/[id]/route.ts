import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  if (!url || !key) return Response.json({ error: 'Supabase not configured' }, { status: 500 })

  const db = createClient(url, key)
  const { data, error } = await db
    .from('staging_history')
    .select('id, site_name, multidev, status, started_at, completed_at, logs')
    .eq('id', id)
    .single()

  if (error) return Response.json({ error: error.message }, { status: 404 })
  return Response.json(data)
}
