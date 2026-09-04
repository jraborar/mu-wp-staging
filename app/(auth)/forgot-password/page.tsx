'use client'

import { useState } from 'react'
import Link from 'next/link'
import { forgotPassword } from '@/app/auth/actions'

export default function ForgotPasswordPage() {
  const [error, setError]     = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const inputCls = 'w-full rounded-lg border border-pantheon-border-hi bg-pantheon-bg-elevated px-3.5 py-2.5 font-mono text-sm text-pantheon-text placeholder-pantheon-text-dim outline-none transition focus:border-pantheon-yellow focus:ring-1 focus:ring-pantheon-yellow'
  const btnCls   = 'w-full rounded-lg bg-pantheon-yellow px-4 py-2.5 font-mono text-sm font-semibold text-pantheon-bg hover:bg-pantheon-yellow-dark transition-colors disabled:opacity-50'

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

      {error   && <div className="rounded-lg border border-pantheon-error/40 bg-pantheon-error/10 px-4 py-3 font-mono text-xs text-pantheon-error">{error}</div>}
      {success && <div className="rounded-lg border border-pantheon-success/40 bg-pantheon-success/10 px-4 py-3 font-mono text-xs text-pantheon-success">{success}</div>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <input name="email" type="email" required placeholder="Email" className={inputCls} />
        <button type="submit" disabled={loading} className={btnCls}>
          {loading ? 'Sending...' : 'Send reset link'}
        </button>
      </form>

      <p className="text-center font-mono text-xs text-pantheon-text-muted">
        <Link href="/login" className="text-pantheon-yellow hover:underline">Back to sign in</Link>
      </p>
    </div>
  )
}
