'use client'

import { useState } from 'react'
import { resetPassword } from '@/app/auth/actions'

export default function ResetPasswordPage() {
  const [error, setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const inputCls = 'w-full rounded-lg border border-pantheon-border-hi bg-pantheon-bg-elevated px-3.5 py-2.5 font-mono text-sm text-pantheon-text placeholder-pantheon-text-dim outline-none transition focus:border-pantheon-yellow focus:ring-1 focus:ring-pantheon-yellow'
  const btnCls   = 'w-full rounded-lg bg-pantheon-yellow px-4 py-2.5 font-mono text-sm font-semibold text-pantheon-bg hover:bg-pantheon-yellow-dark transition-colors disabled:opacity-50'

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

      {error && <div className="rounded-lg border border-pantheon-error/40 bg-pantheon-error/10 px-4 py-3 font-mono text-xs text-pantheon-error">{error}</div>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <input name="password" type="password" required minLength={8} placeholder="New password (min 8 chars)" className={inputCls} />
        <button type="submit" disabled={loading} className={btnCls}>
          {loading ? 'Updating...' : 'Update password'}
        </button>
      </form>
    </div>
  )
}
