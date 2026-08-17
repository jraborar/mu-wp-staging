'use client'

import { useState } from 'react'
import Link from 'next/link'
import { forgotPassword } from '@/app/auth/actions'

export default function ForgotPasswordPage() {
  const [error, setError]     = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const inputCls = 'w-full rounded-lg border border-slate-600 bg-slate-700 px-3.5 py-2.5 font-mono text-sm text-white placeholder-slate-500 outline-none transition focus:border-[#FFDC28] focus:ring-1 focus:ring-[#FFDC28]'
  const btnCls   = 'w-full rounded-lg bg-[#FFDC28] px-4 py-2.5 font-mono text-sm font-semibold text-slate-900 hover:bg-[#E6C625] transition-colors disabled:opacity-50'

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
        <h1 className="font-mono text-xl font-bold text-white">Reset password</h1>
        <p className="mt-1 font-mono text-sm text-slate-400">We&apos;ll send you a reset link</p>
      </div>

      {error   && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 font-mono text-xs text-red-400">{error}</div>}
      {success && <div className="rounded-lg border border-green-500/40 bg-green-500/10 px-4 py-3 font-mono text-xs text-green-400">{success}</div>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <input name="email" type="email" required placeholder="Email" className={inputCls} />
        <button type="submit" disabled={loading} className={btnCls}>
          {loading ? 'Sending...' : 'Send reset link'}
        </button>
      </form>

      <p className="text-center font-mono text-xs text-slate-400">
        <Link href="/login" className="text-[#FFDC28] hover:underline">Back to sign in</Link>
      </p>
    </div>
  )
}
