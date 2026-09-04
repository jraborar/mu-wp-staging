'use client'

import { useState } from 'react'
import Link from 'next/link'
import { forgotPassword } from '@/app/auth/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Notice } from '../_components/Notice'

export default function ForgotPasswordPage() {
  const [error, setError]     = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null); setSuccess(null); setLoading(true)
    const result = await forgotPassword(new FormData(e.currentTarget))
    if (result?.error)   setError(result.error)
    if (result?.success) setSuccess(result.success)
    setLoading(false)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-xl font-bold text-pantheon-text">Reset password</h1>
        <p className="mt-1 font-mono text-sm text-pantheon-text-muted">We&apos;ll send you a reset link</p>
      </div>
      {error   && <Notice tone="error">{error}</Notice>}
      {success && <Notice tone="success">{success}</Notice>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input name="email" type="email" required placeholder="Email" autoComplete="email" className="font-mono" />
        <Button type="submit" disabled={loading} className="w-full font-mono font-semibold">
          {loading ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>

      <p className="text-center font-mono text-xs text-pantheon-text-muted">
        <Link href="/login" className="text-pantheon-yellow hover:underline">Back to sign in</Link>
      </p>
    </div>
  )
}
