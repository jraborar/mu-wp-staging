'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { login, signInWithOAuth } from '@/app/auth/actions'

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Surface errors handed back via ?error= (e.g. from the OAuth callback)
  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get('error')
    if (err) setError(err)
  }, [])

  const inputCls = 'w-full rounded-lg border border-slate-600 bg-slate-700 px-3.5 py-2.5 font-mono text-sm text-white placeholder-slate-500 outline-none transition focus:border-[#FFDC28] focus:ring-1 focus:ring-[#FFDC28]'
  const btnCls   = 'w-full rounded-lg bg-[#FFDC28] px-4 py-2.5 font-mono text-sm font-semibold text-slate-900 hover:bg-[#E6C625] transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
  const oauthCls = 'flex w-full items-center justify-center gap-2 rounded-lg border border-slate-600 bg-slate-700 px-4 py-2.5 font-mono text-sm text-white hover:border-slate-500 hover:bg-slate-600 transition-colors'

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
        <h1 className="font-mono text-xl font-bold text-white">Sign in</h1>
        <p className="mt-1 font-mono text-sm text-slate-400">Access the staging console</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 font-mono text-xs text-red-400">{error}</div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <input name="email" type="email" required placeholder="Email" className={inputCls} />
        <input name="password" type="password" required placeholder="Password" className={inputCls} />
        <button type="submit" disabled={loading} className={btnCls}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>

      <div className="relative">
        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-600" /></div>
        <div className="relative flex justify-center"><span className="bg-slate-800 px-3 font-mono text-xs text-slate-500">or continue with</span></div>
      </div>

      <button
        onClick={async () => { const r = await signInWithOAuth('github'); if (r?.url) window.location.href = r.url; if (r?.error) setError(r.error) }}
        className={oauthCls}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" /></svg>
        GitHub
      </button>

      <p className="text-center font-mono text-xs text-slate-400">
        No account?{' '}
        <Link href="/signup" className="text-[#FFDC28] hover:underline">Sign up</Link>
        {' · '}
        <Link href="/forgot-password" className="text-[#FFDC28] hover:underline">Forgot password?</Link>
      </p>
    </div>
  )
}
