'use client'

import { useState } from 'react'
import { resetPassword } from '@/app/auth/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Notice } from '../_components/Notice'

export default function ResetPasswordPage() {
  const [error, setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null); setLoading(true)
    const result = await resetPassword(new FormData(e.currentTarget))
    if (result?.error) { setError(result.error); setLoading(false) }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-xl font-bold text-pantheon-text">New password</h1>
        <p className="mt-1 font-mono text-sm text-pantheon-text-muted">Choose a strong password</p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input name="password" type="password" required minLength={8} placeholder="New password (min 8 chars)" autoComplete="new-password" className="font-mono" />
        <Button type="submit" disabled={loading} className="w-full font-mono font-semibold">
          {loading ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </div>
  )
}
