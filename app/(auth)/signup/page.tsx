'use client'

import { useState } from 'react'
import Link from 'next/link'
import { signup, signInWithOAuth } from '@/app/auth/actions'

export default function SignupPage() {
  const [error, setError]     = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const inputCls = 'w-full rounded-lg border border-pantheon-border-hi bg-pantheon-bg-elevated px-3.5 py-2.5 font-mono text-sm text-pantheon-text placeholder-pantheon-text-dim outline-none transition focus:border-pantheon-yellow focus:ring-1 focus:ring-pantheon-yellow'
  const btnCls   = 'w-full rounded-lg bg-pantheon-yellow px-4 py-2.5 font-mono text-sm font-semibold text-pantheon-bg hover:bg-pantheon-yellow-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
  const oauthCls = 'flex w-full items-center justify-center gap-2 rounded-lg border border-pantheon-border-hi bg-pantheon-bg-elevated px-4 py-2.5 font-mono text-sm text-pantheon-text hover:border-pantheon-text-dim hover:bg-pantheon-bg-neutral transition-colors'

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null); setSuccess(null); setLoading(true)
    const result = await signup(new FormData(e.currentTarget))
    if (result?.error)   { setError(result.error) }
    if (result?.success) { setSuccess(result.success) }
    setLoading(false)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-xl font-bold text-pantheon-text">Create account</h1>
        <p className="mt-1 font-mono text-sm text-pantheon-text-muted">Join the staging console</p>
      </div>

      {error   && <div className="rounded-lg border border-pantheon-error/40 bg-pantheon-error/10 px-4 py-3 font-mono text-xs text-pantheon-error">{error}</div>}
      {success && <div className="rounded-lg border border-pantheon-success/40 bg-pantheon-success/10 px-4 py-3 font-mono text-xs text-pantheon-success">{success}</div>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <input name="full_name" type="text" required placeholder="Full name" className={inputCls} />
        <input name="email"    type="email"    required placeholder="Email"    className={inputCls} />
        <input name="password" type="password" required placeholder="Password (min 8 chars)" minLength={8} className={inputCls} />
        <button type="submit" disabled={loading} className={btnCls}>
          {loading ? 'Creating account...' : 'Create account'}
        </button>
      </form>

      <div className="relative">
        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-pantheon-border-hi" /></div>
        <div className="relative flex justify-center"><span className="bg-pantheon-bg-card px-3 font-mono text-xs text-pantheon-text-dim">or continue with</span></div>
      </div>

      <div className="space-y-2">
        <button
          onClick={async () => { const r = await signInWithOAuth('github'); if (r?.url) window.location.href = r.url; if (r?.error) setError(r.error) }}
          className={oauthCls}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" /></svg>
          GitHub
        </button>
        <button
          onClick={async () => { const r = await signInWithOAuth('google'); if (r?.url) window.location.href = r.url; if (r?.error) setError(r.error) }}
          className={oauthCls}
        >
          <svg width="16" height="16" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          Google
        </button>
      </div>

      <p className="text-center font-mono text-xs text-pantheon-text-muted">
        Already have an account?{' '}
        <Link href="/login" className="text-pantheon-yellow hover:underline">Sign in</Link>
      </p>
    </div>
  )
}
