'use client'

import { useState } from 'react'
import { resetPassword } from '@/app/auth/actions'

export default function ResetPasswordPage() {
  const [error, setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const inputCls = 'w-full rounded-lg border border-slate-600 bg-slate-700 px-3.5 py-2.5 font-mono text-sm text-white placeholder-slate-500 outline-none transition focus:border-[#FFDC28] focus:ring-1 focus:ring-[#FFDC28]'
  const btnCls   = 'w-full rounded-lg bg-[#FFDC28] px-4 py-2.5 font-mono text-sm font-semibold text-slate-900 hover:bg-[#E6C625] transition-colors disabled:opacity-50'

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null); setLoading(true)
    const result = await resetPassword(new FormData(e.currentTarget))
    if (result?.error) { setError(result.error); setLoading(false) }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-mono text-xl font-bold text-white">New password</h1>
        <p className="mt-1 font-mono text-sm text-slate-400">Choose a strong password</p>
      </div>

      {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 font-mono text-xs text-red-400">{error}</div>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <input name="password" type="password" required minLength={8} placeholder="New password (min 8 chars)" className={inputCls} />
        <button type="submit" disabled={loading} className={btnCls}>
          {loading ? 'Updating...' : 'Update password'}
        </button>
      </form>
    </div>
  )
}
