'use client'

import { useState } from 'react'
import Link from 'next/link'
import { signup } from '@/app/auth/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Notice } from '../_components/Notice'
import { OAuthButtons } from '../_components/OAuthButtons'

export default function SignupPage() {
  const [error, setError]     = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null); setSuccess(null); setLoading(true)
    const result = await signup(new FormData(e.currentTarget))
    if (result?.error)   setError(result.error)
    if (result?.success) setSuccess(result.success)
    setLoading(false)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-xl font-bold text-pantheon-text">Create account</h1>
        <p className="mt-1 font-mono text-sm text-pantheon-text-muted">Join the staging console</p>
      </div>
      {error   && <Notice tone="error">{error}</Notice>}
      {success && <Notice tone="success">{success}</Notice>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input name="full_name" type="text" required placeholder="Full name" autoComplete="name" className="font-mono" />
        <Input name="email" type="email" required placeholder="Email" autoComplete="email" className="font-mono" />
        <Input name="password" type="password" required minLength={8} placeholder="Password (min 8 chars)" autoComplete="new-password" className="font-mono" />
        <Button type="submit" disabled={loading} className="w-full font-mono font-semibold">
          {loading ? 'Creating account…' : 'Create account'}
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
        Have an account?{' '}
        <Link href="/login" className="text-pantheon-yellow hover:underline">Sign in</Link>
      </p>
    </div>
  )
}
