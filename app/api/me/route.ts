import { createClient } from '@/utils/supabase/server'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ display: null })

    const provider = user.app_metadata?.provider as string | undefined
    const meta     = user.user_metadata ?? {}

    // GitHub → show username; Google/email → show email
    const display = provider === 'github'
      ? (meta.user_name ?? meta.preferred_username ?? user.email ?? null)
      : (user.email ?? null)

    return Response.json({ display })
  } catch {
    return Response.json({ display: null })
  }
}
