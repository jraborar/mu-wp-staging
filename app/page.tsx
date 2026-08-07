'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Server, Terminal, Package, Layers, CheckCircle, AlertCircle,
  ChevronDown, ChevronUp, RefreshCw, Clock, ArrowRight, Radio,
  Calendar, CalendarClock, Trash2, Plus, Pause, X, Check,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

type Tab = 'stage' | 'history' | 'schedule' | 'upcoming'

type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'bimonthly-week-of-15' | 'security-only'

interface LogEntry {
  type: 'log'
  logType: 'info' | 'status' | 'warn' | 'success' | 'error' | 'delete' | 'deleted' | 'create'
  message: string
  ts: number
}

interface ApprovalPayload {
  approvalType: string
  message: string
  approveLabel: string
  rejectLabel: string
}

interface UpdatedItem { name: string; title: string; from: string; to: string }
interface SkippedItem { name: string; title: string; reason: string }
interface UpdateSummary { updated: UpdatedItem[]; skipped: SkippedItem[] }

interface LiveJob {
  id: string
  site: string
  site_name?: string
  multidev: string
  status: string
  startedAt: number
}

interface HistoryItem {
  id: string
  site: string
  site_name?: string
  multidev: string
  upstream?: string
  upstream_updated: boolean
  upstream_skipped_reason?: string
  plugins_updated: UpdatedItem[]
  plugins_skipped: SkippedItem[]
  themes_updated: UpdatedItem[]
  themes_skipped: SkippedItem[]
  status: string
  started_at: string
  completed_at: string | null
}

interface StagingSchedule {
  id: string
  site: string
  site_name?: string
  cadence: Cadence
  day_of_week?: number
  week_of_month?: number
  biweekly_reference_date?: string
  bimonthly_ref_month?: number
  bimonthly_day_of_week?: number
  security_check_enabled: boolean
  skip_upstream: boolean
  skip_plugins_themes: boolean
  active: boolean
  created_at: string
  last_staged_at?: string
  next_staging_at?: string
}

interface UpcomingEntry {
  id: string
  site: string
  site_name?: string
  cadence: string
  at: string
  skip_upstream: boolean
  skip_plugins_themes: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEKS = [{ v: 1, l: '1st' }, { v: 2, l: '2nd' }, { v: 3, l: '3rd' }, { v: 4, l: '4th' }, { v: -1, l: 'Last' }]
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const CADENCE_LABELS: Record<Cadence, string> = {
  'weekly': 'Weekly',
  'biweekly': 'Bi-weekly',
  'monthly': 'Monthly',
  'bimonthly-week-of-15': 'Every other month (week of 15th)',
  'security-only': 'Security updates only',
}

// ── Log styling ────────────────────────────────────────────────────────────────

const LOG_STYLES: Record<string, { prefix: string; cls: string }> = {
  info:    { prefix: '›',  cls: 'text-slate-400' },
  status:  { prefix: '◈',  cls: 'text-yellow-400' },
  warn:    { prefix: '⚠',  cls: 'text-orange-400' },
  success: { prefix: '✦',  cls: 'text-green-400 font-semibold' },
  error:   { prefix: '✗',  cls: 'text-red-400' },
  delete:  { prefix: '🗑',  cls: 'text-orange-400' },
  deleted: { prefix: '✓',  cls: 'text-orange-300' },
  create:  { prefix: '◈',  cls: 'text-blue-400' },
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function LogLine({ entry }: { entry: LogEntry }) {
  const style = LOG_STYLES[entry.logType] ?? LOG_STYLES.info
  return (
    <div className={`flex gap-2 font-mono text-xs leading-relaxed ${style.cls}`}>
      <span className="shrink-0 w-3 select-none">{style.prefix}</span>
      <span className="break-all">{entry.message}</span>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    running:            'border-yellow-500 text-yellow-400',
    'awaiting-approval':'border-purple-500 text-purple-400',
    completed:          'border-green-500 text-green-400',
    failed:             'border-red-500 text-red-400',
    paused:             'border-blue-500 text-blue-400',
    cancelled:          'border-slate-600 text-slate-400',
  }
  const dot: Record<string, string> = {
    running:            'bg-yellow-400 animate-pulse',
    'awaiting-approval':'bg-purple-400 animate-pulse',
    completed:          'bg-green-400',
    failed:             'bg-red-400',
    paused:             'bg-blue-400',
  }
  const label: Record<string, string> = {
    completed:          'staged',
    'awaiting-approval':'waiting',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-xs ${map[status] ?? 'border-slate-600 text-slate-400'}`}>
      {dot[status] && <span className={`h-1.5 w-1.5 rounded-full ${dot[status]}`} />}
      {label[status] ?? status}
    </span>
  )
}

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-700 bg-slate-800 ${className}`}>
      {children}
    </div>
  )
}

function CardHeader({ icon, title, description }: {
  icon: React.ReactNode; title: string; description?: string
}) {
  return (
    <div className="px-6 py-5 border-b border-slate-700">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[#FFDC28]">{icon}</span>
        <h2 className="text-white font-semibold">{title}</h2>
      </div>
      {description && <p className="text-slate-400 text-sm">{description}</p>}
    </div>
  )
}

function UpdateSection({ label, updated, skipped }: {
  label: string; updated: UpdatedItem[]; skipped: SkippedItem[]
}) {
  if (updated.length === 0 && skipped.length === 0) return null
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest">{label}</p>
      {updated.map((u) => (
        <div key={u.name} className="flex items-center gap-2 pl-2">
          <CheckCircle className="w-3 h-3 text-green-400 shrink-0" />
          <span className="text-xs font-mono text-slate-200">{u.title}</span>
          <span className="text-xs text-slate-500">{u.from}</span>
          <ArrowRight className="w-3 h-3 text-slate-500" />
          <span className="text-xs text-green-400">{u.to}</span>
        </div>
      ))}
      {skipped.map((s) => (
        <div key={s.name} className="flex items-start gap-2 pl-2">
          <AlertCircle className="w-3 h-3 text-orange-400 shrink-0 mt-0.5" />
          <span className="text-xs font-mono text-slate-400">
            {s.title} <span className="text-slate-500">— {s.reason}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

function HistoryRow({ item }: { item: HistoryItem }) {
  const [open, setOpen] = useState(false)
  const startDate = new Date(item.started_at)
  const dateStr   = startDate.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' })
  const timeStr   = startDate.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' })
  const updatedCount = item.plugins_updated.length + item.themes_updated.length
  const skippedCount = item.plugins_skipped.length + item.themes_skipped.length

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-slate-700/50 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <StatusBadge status={item.status} />
        <div className="flex-1 min-w-0">
          <span className="font-mono text-sm text-white truncate">{item.site_name ?? item.site}</span>
          <span className="text-slate-500 mx-2">·</span>
          <span className="font-mono text-xs text-[#FFDC28]">{item.multidev}</span>
        </div>
        <div className="hidden sm:flex items-center gap-3 text-xs shrink-0">
          {item.upstream_updated
            ? <span className="text-green-400 font-mono">upstream ✓</span>
            : item.upstream_skipped_reason
              ? <span className="text-orange-400 font-mono">upstream — skipped</span>
              : null}
          {updatedCount > 0  && <span className="text-green-400">{updatedCount} updated</span>}
          {skippedCount > 0  && <span className="text-orange-400">{skippedCount} skipped</span>}
        </div>
        <div className="flex items-center gap-1 text-slate-500 text-xs shrink-0">
          <Clock className="w-3 h-3" />
          <span>{dateStr} {timeStr} PHT</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-slate-700 px-5 py-4 space-y-4 bg-slate-800/60">
          {item.upstream_updated ? (
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <span className="text-sm text-green-400 font-mono">Upstream updated</span>
            </div>
          ) : item.upstream_skipped_reason ? (
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-orange-400" />
              <span className="text-sm text-orange-400 font-mono">Upstream skipped — {item.upstream_skipped_reason}</span>
            </div>
          ) : null}
          <UpdateSection label="Plugins" updated={item.plugins_updated} skipped={item.plugins_skipped} />
          <UpdateSection label="Themes"  updated={item.themes_updated}  skipped={item.themes_skipped} />
          {!item.upstream_updated && updatedCount === 0 && (
            <p className="text-xs text-slate-500 font-mono">Nothing was updated</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Live job card with SSE stream + approval UI ───────────────────────────────

function LiveJobCard({ job, onComplete }: { job: LiveJob; onComplete: () => void }) {
  const [logs, setLogs]             = useState<LogEntry[]>([])
  const [status, setStatus]         = useState<string>(job.status)
  const [approval, setApproval]     = useState<ApprovalPayload | null>(null)
  const [approving, setApproving]   = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [snapshot, setSnapshot]     = useState<{
    plugins: UpdateSummary; themes: UpdateSummary
    upstreamUpdated: boolean; upstreamConflict: boolean
  } | null>(null)
  const [step, setStep]           = useState<{ name: string; index: number; total: number } | null>(null)
  const [disconnected, setDisconnected] = useState(false)
  const statusRef  = useRef(status)
  const abortRef   = useRef<AbortController | null>(null)
  const consoleRef = useRef<HTMLDivElement>(null)

  useEffect(() => { statusRef.current = status }, [status])

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight
  }, [logs])

  const readStream = useCallback(async (res: Response): Promise<'done' | 'dropped'> => {
    if (!res.body) return 'dropped'
    const reader  = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer    = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) return 'dropped'
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.replace(/^data: /, '').trim()
        if (!line) continue
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'log') {
            setLogs((p) => [...p, ev as LogEntry])
          } else if (ev.type === 'step') {
            setStep({ name: ev.name, index: ev.index, total: ev.total })
          } else if (ev.type === 'awaiting-approval') {
            setStatus('awaiting-approval')
            setApproval({
              approvalType: ev.approvalType,
              message: ev.message,
              approveLabel: ev.approveLabel,
              rejectLabel: ev.rejectLabel,
            })
          } else if (ev.type === 'complete') {
            setStatus(ev.status)
            setApproval(null)
            const r = await fetch(`/api/staging/${job.id}`)
            if (r.ok) {
              const j = await r.json()
              setSnapshot({
                plugins:          j.plugins  ?? { updated: [], skipped: [] },
                themes:           j.themes   ?? { updated: [], skipped: [] },
                upstreamUpdated:  j.upstreamUpdated  ?? false,
                upstreamConflict: j.upstreamConflict ?? false,
              })
            }
            onComplete()
            return 'done'
          }
        } catch {}
      }
    }
  }, [job.id, onComplete])

  const streamWithAutoReconnect = useCallback(async (initialRes: Response) => {
    let res = initialRes
    let attempts = 0
    const MAX = 8

    while (attempts <= MAX) {
      const result = await readStream(res)
      if (result === 'done') { setDisconnected(false); return }
      if (!['running', 'awaiting-approval'].includes(statusRef.current)) return
      if (abortRef.current?.signal.aborted) return

      attempts++
      const delay = Math.min(1000 * 2 ** attempts, 30_000)
      await new Promise(r => setTimeout(r, delay))
      if (abortRef.current?.signal.aborted) return

      try {
        res = await fetch(`/api/staging?jobId=${job.id}`, { signal: abortRef.current?.signal })
        if (!res.ok) break
        setDisconnected(false)
      } catch { break }
    }

    if (['running', 'awaiting-approval'].includes(statusRef.current)) setDisconnected(true)
  }, [job.id, readStream])

  useEffect(() => {
    abortRef.current = new AbortController()
    const ctrl = abortRef.current

    const connect = async () => {
      try {
        const res = await fetch(`/api/staging?jobId=${job.id}`, { signal: ctrl.signal })
        if (!res.ok || ctrl.signal.aborted) return
        await streamWithAutoReconnect(res)
      } catch {}
    }

    void connect()
    return () => ctrl.abort()
  }, [job.id, streamWithAutoReconnect])

  const manualReconnect = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setDisconnected(false)
    try {
      const res = await fetch(`/api/staging?jobId=${job.id}`, { signal: abortRef.current.signal })
      if (!res.ok) { setDisconnected(true); return }
      await streamWithAutoReconnect(res)
    } catch { setDisconnected(true) }
  }, [job.id, streamWithAutoReconnect])

  const sendApproval = async (approved: boolean) => {
    setApproving(true)
    try {
      await fetch(`/api/staging/${job.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved }),
      })
      setApproval(null)
      setStatus('running')
    } finally {
      setApproving(false)
    }
  }

  const cancelJob = async () => {
    setCancelling(true)
    try {
      await fetch(`/api/staging/${job.id}/cancel`, { method: 'POST' })
    } finally {
      setCancelling(false)
    }
  }

  const label        = job.site_name ?? job.site
  const elapsedMins  = Math.floor((Date.now() - job.startedAt) / 60000)
  const isActive     = ['running', 'awaiting-approval'].includes(status)
  const isLongRunning = elapsedMins >= 30 && status === 'running'
  const pct          = step ? Math.round((step.index / step.total) * 100) : 0

  return (
    <div className="rounded-xl border border-yellow-500/30 bg-slate-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-700 bg-slate-800">
        <Radio className="w-4 h-4 text-yellow-400 animate-pulse" />
        <div className="flex-1 min-w-0">
          <span className="font-mono text-sm text-white">{label}</span>
          <span className="text-slate-500 mx-2">·</span>
          <span className="font-mono text-xs text-[#FFDC28]">{job.multidev}</span>
        </div>
        <StatusBadge status={status} />
        {isActive && (
          <button
            onClick={cancelJob}
            disabled={cancelling}
            title="Cancel staging"
            className="flex items-center gap-1 rounded border border-red-700 px-2 py-0.5 text-xs text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-40"
          >
            <X className="w-3 h-3" />
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>

      {/* Progress bar */}
      {step && status === 'running' && (
        <div className="px-5 pt-3 pb-1 space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-300 font-mono">{step.name}</span>
            <span className="text-slate-500">{step.index}/{step.total}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-700 overflow-hidden">
            <div
              className="h-full rounded-full bg-[#FFDC28] transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Approval prompt */}
      {approval && status === 'awaiting-approval' && (
        <div className="mx-5 mt-3 rounded-lg border border-purple-500/40 bg-purple-900/20 p-4 space-y-3">
          <p className="text-sm text-purple-300 font-mono">{approval.message}</p>
          <div className="flex gap-2">
            <button
              onClick={() => sendApproval(true)}
              disabled={approving}
              className="flex items-center gap-1.5 rounded-lg bg-green-700 hover:bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-40"
            >
              <Check className="w-3.5 h-3.5" />
              {approval.approveLabel}
            </button>
            <button
              onClick={() => sendApproval(false)}
              disabled={approving}
              className="flex items-center gap-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors disabled:opacity-40"
            >
              <Pause className="w-3.5 h-3.5" />
              {approval.rejectLabel}
            </button>
          </div>
        </div>
      )}

      {/* Reconnect banner */}
      {disconnected && (
        <div className="mx-5 mt-3 flex items-center justify-between gap-3 rounded-lg border border-slate-600 bg-slate-700/50 px-4 py-2.5">
          <span className="text-xs text-slate-400">Stream disconnected — job may still be running</span>
          <button
            onClick={manualReconnect}
            className="flex items-center gap-1.5 rounded-lg bg-[#FFDC28] hover:bg-[#E6C625] px-3 py-1 text-xs font-semibold text-slate-900 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Reconnect
          </button>
        </div>
      )}

      {/* Long-running warning */}
      {isLongRunning && (
        <div className="mx-5 mt-2 flex items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-900/20 px-3 py-2">
          <Clock className="w-3.5 h-3.5 text-orange-400 shrink-0" />
          <span className="text-xs text-orange-400">
            Staging is taking longer than usual — {elapsedMins} min elapsed
          </span>
        </div>
      )}

      {/* Console */}
      <div ref={consoleRef} className="h-64 overflow-y-auto bg-slate-900 p-4 space-y-0.5">
        {logs.length === 0 && <p className="text-xs text-slate-600 font-mono">Connecting…</p>}
        {logs.map((entry, i) => <LogLine key={i} entry={entry} />)}
        {status === 'running' && (
          <div className="flex gap-2 font-mono text-xs text-slate-600">
            <span className="animate-pulse">▋</span>
          </div>
        )}
      </div>

      {/* Results */}
      {snapshot && !isActive && (
        <div className="border-t border-slate-700 px-5 py-4 space-y-3">
          {snapshot.upstreamUpdated && (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-green-900/20 border border-green-700/40">
              <CheckCircle className="w-4 h-4 text-green-400" />
              <span className="text-sm text-green-400 font-mono">Upstream updated</span>
            </div>
          )}
          {snapshot.upstreamConflict && (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-orange-900/20 border border-orange-700/40">
              <AlertCircle className="w-4 h-4 text-orange-400" />
              <span className="text-sm text-orange-400 font-mono">Upstream skipped — merge conflict</span>
            </div>
          )}
          <UpdateSection label="Plugins" updated={snapshot.plugins.updated} skipped={snapshot.plugins.skipped} />
          <UpdateSection label="Themes"  updated={snapshot.themes.updated}  skipped={snapshot.themes.skipped} />
          {!snapshot.upstreamUpdated && snapshot.plugins.updated.length === 0 && snapshot.themes.updated.length === 0 && (
            <p className="text-sm text-slate-500 font-mono">Nothing was updated</p>
          )}
          {status === 'completed' && (
            <div className="flex items-center gap-2 pt-2 border-t border-slate-700 text-xs text-slate-400">
              <Clock className="w-3.5 h-3.5" />
              <span>Deployment scheduled in mu-deployment — check History for the exact time</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Schedule Tab ──────────────────────────────────────────────────────────────

function ScheduleTab() {
  const [schedules, setSchedules]   = useState<StagingSchedule[]>([])
  const [loading, setLoading]       = useState(true)
  const [showForm, setShowForm]     = useState(false)
  const [saving, setSaving]         = useState(false)

  // Form state
  const [site, setSite]             = useState('')
  const [cadence, setCadence]       = useState<Cadence>('weekly')
  const [dayOfWeek, setDayOfWeek]   = useState(1) // Monday default
  const [weekOfMonth, setWeekOfMonth] = useState(1)
  const [biweeklyRef, setBiweeklyRef] = useState('')
  const [bimonthlyRefMonth, setBimonthlyRefMonth] = useState(1)
  const [bimonthlyDow, setBimonthlyDow] = useState(2) // Tuesday default
  const [skipUpstream, setSkipUpstream] = useState(false)
  const [skipPluginsThemes, setSkipPluginsThemes] = useState(false)
  const [deployDays, setDeployDays] = useState(2)
  const [destination, setDestination] = useState('live')

  const loadSchedules = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/schedules')
      if (res.ok) setSchedules(await res.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadSchedules() }, [loadSchedules])

  const saveSchedule = async () => {
    if (!site.trim()) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        site: site.trim(), cadence, skip_upstream: skipUpstream,
        skip_plugins_themes: skipPluginsThemes,
        deploy_days: deployDays,
        deploy_destination: destination,
      }
      if (cadence === 'weekly') { body.day_of_week = dayOfWeek }
      if (cadence === 'biweekly') { body.day_of_week = dayOfWeek; body.biweekly_reference_date = biweeklyRef }
      if (cadence === 'monthly') { body.day_of_week = dayOfWeek; body.week_of_month = weekOfMonth }
      if (cadence === 'bimonthly-week-of-15') {
        body.bimonthly_ref_month = bimonthlyRefMonth
        body.bimonthly_day_of_week = bimonthlyDow
        body.security_check_enabled = true
      }
      if (cadence === 'security-only') {
        body.security_check_enabled = true
      }
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        setSite(''); setShowForm(false)
        await loadSchedules()
      }
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (id: string, active: boolean) => {
    await fetch(`/api/schedules/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !active }),
    })
    await loadSchedules()
  }

  const deleteSchedule = async (id: string) => {
    await fetch(`/api/schedules/${id}`, { method: 'DELETE' })
    await loadSchedules()
  }

  const formatCadenceDetail = (s: StagingSchedule) => {
    if (s.cadence === 'weekly' && s.day_of_week != null)
      return `Every ${DAYS[s.day_of_week]}`
    if (s.cadence === 'biweekly' && s.day_of_week != null)
      return `Every other ${DAYS[s.day_of_week]}`
    if (s.cadence === 'monthly' && s.day_of_week != null && s.week_of_month != null)
      return `${WEEKS.find(w => w.v === s.week_of_month)?.l ?? ''} ${DAYS[s.day_of_week]} of month`
    if (s.cadence === 'bimonthly-week-of-15' && s.bimonthly_ref_month != null && s.bimonthly_day_of_week != null)
      return `${DAYS[s.bimonthly_day_of_week]} · week of 15th · every other month (from ${MONTHS[(s.bimonthly_ref_month - 1) % 12]})`
    if (s.cadence === 'security-only')
      return 'Manual / security updates only'
    return CADENCE_LABELS[s.cadence]
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">Site Schedules</h3>
        </div>
        <button
          onClick={() => setShowForm((f) => !f)}
          className="flex items-center gap-1.5 rounded-lg bg-[#FFDC28] hover:bg-[#E6C625] px-3 py-1.5 text-xs font-semibold text-slate-900 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Schedule
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <Card className="overflow-visible">
          <CardHeader icon={<Calendar className="w-5 h-5" />} title="New Schedule" />
          <div className="px-6 py-5 space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs text-slate-400 font-mono">Site ID</label>
              <input
                type="text"
                value={site}
                onChange={(e) => setSite(e.target.value)}
                placeholder="my-site-name"
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-[#FFDC28] focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-slate-400 font-mono">Cadence</label>
              <select
                value={cadence}
                onChange={(e) => {
                  const c = e.target.value as Cadence
                  setCadence(c)
                  if (c === 'security-only') setDeployDays(1)
                  else if (deployDays === 1) setDeployDays(2)
                }}
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white focus:border-[#FFDC28] focus:outline-none"
              >
                {(Object.keys(CADENCE_LABELS) as Cadence[]).map(c => (
                  <option key={c} value={c}>{CADENCE_LABELS[c]}</option>
                ))}
              </select>
            </div>

            {/* Conditional cadence fields */}
            {(cadence === 'weekly' || cadence === 'biweekly' || cadence === 'monthly') && (
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400 font-mono">Day of week</label>
                <select
                  value={dayOfWeek}
                  onChange={(e) => setDayOfWeek(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white focus:border-[#FFDC28] focus:outline-none"
                >
                  {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </div>
            )}

            {cadence === 'monthly' && (
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400 font-mono">Which occurrence</label>
                <select
                  value={weekOfMonth}
                  onChange={(e) => setWeekOfMonth(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white focus:border-[#FFDC28] focus:outline-none"
                >
                  {WEEKS.map(w => <option key={w.v} value={w.v}>{w.l}</option>)}
                </select>
              </div>
            )}

            {cadence === 'biweekly' && (
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400 font-mono">Reference date (week 1 anchor)</label>
                <input
                  type="date"
                  value={biweeklyRef}
                  onChange={(e) => setBiweeklyRef(e.target.value)}
                  className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white focus:border-[#FFDC28] focus:outline-none"
                />
              </div>
            )}

            {cadence === 'bimonthly-week-of-15' && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400 font-mono">First &quot;on&quot; month</label>
                  <select
                    value={bimonthlyRefMonth}
                    onChange={(e) => setBimonthlyRefMonth(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white focus:border-[#FFDC28] focus:outline-none"
                  >
                    {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400 font-mono">Day of week (in week of 15th)</label>
                  <select
                    value={bimonthlyDow}
                    onChange={(e) => setBimonthlyDow(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white focus:border-[#FFDC28] focus:outline-none"
                  >
                    {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </div>
              </div>
            )}

            {/* Options */}
            <div className="space-y-2 pt-1 border-t border-slate-700">
              <p className="text-xs text-slate-400 font-mono pt-1">Update options</p>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipUpstream}
                  onChange={(e) => setSkipUpstream(e.target.checked)}
                  className="rounded border-slate-600 bg-slate-700 accent-[#FFDC28]"
                />
                Skip upstream updates
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={skipPluginsThemes}
                  onChange={(e) => setSkipPluginsThemes(e.target.checked)}
                  className="rounded border-slate-600 bg-slate-700 accent-[#FFDC28]"
                />
                Skip plugins &amp; themes
              </label>
            </div>

            {/* Deploy destination + days */}
            <div className="space-y-1.5 pt-1 border-t border-slate-700">
              <label className="text-xs text-slate-400 font-mono pt-1">Deploy to</label>
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white focus:border-[#FFDC28] focus:outline-none"
              >
                <option value="live">Live</option>
                <option value="test">Test</option>
                <option value="dev">Dev</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-slate-400 font-mono">Schedule deployment after (business days)</label>
              <select
                value={deployDays}
                onChange={(e) => setDeployDays(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white focus:border-[#FFDC28] focus:outline-none"
              >
                <option value={1}>1 business day (e.g. stage Friday → deploy Monday)</option>
                <option value={2}>2 business days (default)</option>
                <option value={3}>3 business days</option>
                <option value={5}>5 business days (1 week)</option>
                <option value={3}>Pause until approved (schedules 3 days out — edit in mu-deployment)</option>
              </select>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={saveSchedule}
                disabled={saving || !site.trim()}
                className="flex-1 rounded-lg bg-[#FFDC28] hover:bg-[#E6C625] px-4 py-2.5 text-sm font-semibold text-slate-900 transition-colors disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save Schedule'}
              </button>
              <button
                onClick={() => setShowForm(false)}
                className="px-4 py-2.5 text-sm text-slate-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* Schedule list */}
      {loading && schedules.length === 0 && (
        <p className="text-sm text-slate-500 font-mono text-center py-6">Loading…</p>
      )}
      {!loading && schedules.length === 0 && (
        <div className="text-center py-8 space-y-2">
          <CalendarClock className="w-8 h-8 text-slate-600 mx-auto" />
          <p className="text-sm text-slate-500">No schedules yet — add one above</p>
        </div>
      )}

      {schedules.map((s) => {
        const nextDate = s.next_staging_at ? new Date(s.next_staging_at) : null
        const nextStr  = nextDate
          ? nextDate.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric' })
          : '—'
        const lastDate = s.last_staged_at ? new Date(s.last_staged_at) : null
        const lastStr  = lastDate
          ? lastDate.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' })
          : 'Never'

        return (
          <div key={s.id} className={`rounded-xl border bg-slate-800 overflow-hidden ${s.active ? 'border-slate-700' : 'border-slate-700/50 opacity-60'}`}>
            <div className="flex items-center gap-3 px-5 py-3">
              <div className="flex-1 min-w-0">
                <span className="font-mono text-sm text-white">{s.site_name ?? s.site}</span>
                <p className="text-xs text-slate-400 mt-0.5">{formatCadenceDetail(s)}</p>
              </div>
              <div className="hidden sm:flex flex-col items-end text-xs text-slate-500">
                <span>Next: <span className="text-slate-300">{nextStr}</span></span>
                <span>Last: {lastStr}</span>
              </div>
              <button
                onClick={() => toggleActive(s.id, s.active)}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${s.active ? 'border-green-700 text-green-400 hover:bg-green-900/30' : 'border-slate-600 text-slate-500 hover:bg-slate-700'}`}
              >
                {s.active ? 'Active' : 'Paused'}
              </button>
              <button
                onClick={() => deleteSchedule(s.id)}
                className="text-red-500 hover:text-red-400 transition-colors"
                title="Delete schedule"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            {(s.skip_upstream || s.skip_plugins_themes) && (
              <div className="px-5 pb-3 flex gap-2">
                {s.skip_upstream && <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-400">skip upstream</span>}
                {s.skip_plugins_themes && <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-400">skip plugins/themes</span>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Upcoming Tab ──────────────────────────────────────────────────────────────

function UpcomingTab() {
  const [upcoming, setUpcoming]   = useState<UpcomingEntry[]>([])
  const [loading, setLoading]     = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/upcoming')
      if (res.ok) setUpcoming(await res.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">Upcoming Stagings</h3>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-[#FFDC28] transition-colors disabled:opacity-40"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {loading && upcoming.length === 0 && (
        <p className="text-sm text-slate-500 font-mono text-center py-6">Loading…</p>
      )}
      {!loading && upcoming.length === 0 && (
        <div className="text-center py-8 space-y-2">
          <CalendarClock className="w-8 h-8 text-slate-600 mx-auto" />
          <p className="text-sm text-slate-500">No upcoming stagings — add schedules in the Schedule tab</p>
        </div>
      )}

      {upcoming.map((u, i) => {
        const d = new Date(u.at)
        const dateStr = d.toLocaleDateString('en-PH', {
          timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        })
        const isToday = new Date().toDateString() === new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Manila' })).toDateString()

        return (
          <div key={`${u.id}-${i}`} className="rounded-xl border border-slate-700 bg-slate-800 px-5 py-4 flex items-center gap-4">
            <div className={`w-2 h-2 rounded-full shrink-0 ${isToday ? 'bg-yellow-400' : 'bg-slate-600'}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-white">{u.site_name ?? u.site}</span>
                {(u.skip_upstream || u.skip_plugins_themes) && (
                  <span className="text-xs rounded bg-slate-700 px-1.5 py-0.5 text-slate-400">
                    {u.skip_upstream && u.skip_plugins_themes ? 'upstream + plugins/themes skipped' : u.skip_upstream ? 'upstream skipped' : 'plugins/themes skipped'}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">{CADENCE_LABELS[u.cadence as Cadence] ?? u.cadence}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm text-slate-200">{dateStr}</p>
              {isToday && <span className="text-xs text-yellow-400">Today</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Page() {
  const [tab, setTab]               = useState<Tab>('stage')
  const [site, setSite]             = useState('')
  const [skipUpstream, setSkipUpstream] = useState(false)
  const [skipPluginsThemes, setSkipPluginsThemes] = useState(false)
  const [stageDeployDays, setStageDeployDays] = useState(1)
  const [stageDestination, setStageDestination] = useState('live')
  const [submitting, setSubmitting] = useState(false)

  const [liveJobs, setLiveJobs]             = useState<LiveJob[]>([])
  const [history, setHistory]               = useState<HistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const seenJobIds = useRef<Set<string>>(new Set())

  // Poll for running jobs
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/jobs')
        if (!res.ok) return
        const jobs: LiveJob[] = await res.json()
        const newJobs = jobs.filter((j) => !seenJobIds.current.has(j.id))
        if (newJobs.length > 0) {
          newJobs.forEach((j) => seenJobIds.current.add(j.id))
          setTab('history')
        }
        setLiveJobs(jobs)
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const res = await fetch('/api/history')
      if (res.ok) setHistory(await res.json())
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'history') void loadHistory()
  }, [tab, loadHistory])

  const handleJobComplete = useCallback(() => {
    void loadHistory()
  }, [loadHistory])

  const startJob = useCallback(async () => {
    if (!site.trim()) return
    setSubmitting(true)
    try {
      await fetch('/api/staging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site: site.trim(),
          skipUpstream,
          skipPluginsThemes,
          deployDays: stageDeployDays,
          deployDestination: stageDestination,
        }),
      })
      setTab('history')
    } finally {
      setSubmitting(false)
    }
  }, [site, skipUpstream, skipPluginsThemes, stageDeployDays, stageDestination])

  const liveIds  = new Set(liveJobs.map((j) => j.id))
  const pastJobs = history.filter((h) => !liveIds.has(h.id))

  const TABS: { key: Tab; label: string }[] = [
    { key: 'stage',    label: 'Stage' },
    { key: 'schedule', label: 'Schedule' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'history',  label: 'History' },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="container mx-auto px-4 py-8 max-w-3xl space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#FFDC28] flex items-center justify-center shrink-0">
            <Terminal className="w-5 h-5 text-slate-900" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">WP Staging</h1>
            <p className="text-slate-400 text-sm">Automated upstream, plugin &amp; theme updates for Pantheon multidevs</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-slate-700">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={[
                'relative px-4 py-2 text-sm font-medium transition-colors',
                tab === key
                  ? 'border-b-2 border-[#FFDC28] text-[#FFDC28]'
                  : 'text-slate-400 hover:text-slate-200',
              ].join(' ')}
            >
              {label}
              {key === 'history' && liveJobs.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-yellow-400 animate-pulse" />
              )}
            </button>
          ))}
        </div>

        {/* ── Run tab ── */}
        {tab === 'stage' && (
          <Card>
            <CardHeader
              icon={<Server className="w-5 h-5" />}
              title="Run Staging"
              description="A new mu-YYMMDD multidev will be created in Manila time. Any existing mu-YYMMDD for this site will be replaced."
            />
            <div className="px-6 py-5 space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400 font-mono">Site ID</label>
                <input
                  type="text"
                  value={site}
                  onChange={(e) => setSite(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !submitting && startJob()}
                  placeholder="my-site-name"
                  disabled={submitting}
                  className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-[#FFDC28] focus:outline-none disabled:opacity-50"
                />
              </div>

              <div className="space-y-2 pt-1 border-t border-slate-700">
                <p className="text-xs text-slate-400 font-mono pt-1">Update options</p>
                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={skipUpstream}
                    onChange={(e) => setSkipUpstream(e.target.checked)}
                    className="rounded border-slate-600 bg-slate-700 accent-[#FFDC28]"
                  />
                  Skip upstream updates
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={skipPluginsThemes}
                    onChange={(e) => setSkipPluginsThemes(e.target.checked)}
                    className="rounded border-slate-600 bg-slate-700 accent-[#FFDC28]"
                  />
                  Skip plugins &amp; themes
                </label>
              </div>

              <div className="space-y-1.5 pt-1 border-t border-slate-700">
                <label className="text-xs text-slate-400 font-mono pt-1">Deploy to</label>
                <select
                  value={stageDestination}
                  onChange={(e) => setStageDestination(e.target.value)}
                  className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white focus:border-[#FFDC28] focus:outline-none"
                >
                  <option value="live">Live</option>
                  <option value="test">Test</option>
                  <option value="dev">Dev</option>
                  <option value="multidev">Keep in Multidev — client promotes</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-slate-400 font-mono">Schedule deployment after</label>
                <select
                  value={stageDeployDays}
                  onChange={(e) => setStageDeployDays(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 text-sm text-white focus:border-[#FFDC28] focus:outline-none"
                >
                  <option value={1}>1 business day (e.g. stage Friday → deploy Monday)</option>
                  <option value={2}>2 business days</option>
                  <option value={3}>3 business days</option>
                  <option value={5}>5 business days (1 week)</option>
                  <option value={3}>Pause until approved (schedules 3 days out — edit in mu-deployment)</option>
                </select>
              </div>

              <button
                onClick={startJob}
                disabled={submitting || !site.trim()}
                className="w-full rounded-lg bg-[#FFDC28] hover:bg-[#E6C625] px-4 py-2.5 text-sm font-semibold text-slate-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-900 border-t-transparent" />
                    Starting…
                  </span>
                ) : 'Run Staging Updates'}
              </button>
            </div>
          </Card>
        )}

        {/* ── History tab ── */}
        {tab === 'history' && (
          <div className="space-y-6">
            {liveJobs.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Radio className="w-4 h-4 text-yellow-400 animate-pulse" />
                  <h3 className="text-sm font-semibold text-yellow-400 uppercase tracking-widest">Live</h3>
                </div>
                {liveJobs.map((job) => (
                  <LiveJobCard key={job.id} job={job} onComplete={handleJobComplete} />
                ))}
              </div>
            )}

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-slate-400" />
                  <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">Past</h3>
                </div>
                <button
                  onClick={loadHistory}
                  disabled={historyLoading}
                  className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-[#FFDC28] transition-colors disabled:opacity-40"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${historyLoading ? 'animate-spin' : ''}`} />
                  {historyLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>

              {historyLoading && pastJobs.length === 0 && (
                <p className="text-sm text-slate-500 font-mono text-center py-6">Loading…</p>
              )}
              {!historyLoading && pastJobs.length === 0 && liveJobs.length === 0 && (
                <div className="text-center py-8 space-y-2">
                  <Package className="w-8 h-8 text-slate-600 mx-auto" />
                  <p className="text-sm text-slate-500">No staging runs yet</p>
                </div>
              )}

              {pastJobs.map((item) => <HistoryRow key={item.id} item={item} />)}
            </div>
          </div>
        )}

        {/* ── Schedule tab ── */}
        {tab === 'schedule' && <ScheduleTab />}

        {/* ── Upcoming tab ── */}
        {tab === 'upcoming' && <UpcomingTab />}

      </div>
    </div>
  )
}
