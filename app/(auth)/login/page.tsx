'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { login } from '@/app/auth/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Notice } from '../_components/Notice'
import { OAuthButtons } from '../_components/OAuthButtons'

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // The callback redirects here with ?error= on a failed exchange or a provider
  // error. Read off window rather than useSearchParams, which would need a
  // Suspense boundary around the whole page.
  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get('error')
    if (err) setError(err)
  }, [])

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const result = await login(new FormData(e.currentTarget))
    if (result?.error) { setError(result.error); setLoading(false) }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-xl font-bold text-pantheon-text">Sign in</h1>
        <p className="mt-1 font-mono text-sm text-pantheon-text-muted">Access the staging console</p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input name="email" type="email" required placeholder="Email" autoComplete="email" className="font-mono" />
        <Input name="password" type="password" required placeholder="Password" autoComplete="current-password" className="font-mono" />
        <Button type="submit" disabled={loading} className="w-full font-mono font-semibold">
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <div className="relative">
        <Separator />
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-pantheon-bg px-3 font-mono text-xs text-pantheon-text-dim">
          or continue with
        </span>
      </div>

      <OAuthButtons onError={setError} />

      <p className="text-center font-mono text-xs text-pantheon-text-muted">
        No account?{' '}
        <Link href="/signup" className="text-pantheon-yellow hover:underline">Sign up</Link>
        {' · '}
        <Link href="/forgot-password" className="text-pantheon-yellow hover:underline">Forgot password?</Link>
      </p>
    </div>
  )
}
