import { NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'
import { publicOrigin } from '@/lib/publicOrigin'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'
  const origin = publicOrigin(request)

  // Supabase may redirect here with a provider error instead of a code
  const providerError = searchParams.get('error_description') || searchParams.get('error')

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${next}`)
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`)
  }

  const msg = providerError || 'No authorization code was returned from the provider'
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(msg)}`)
}
