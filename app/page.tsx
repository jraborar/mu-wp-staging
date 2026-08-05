'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Server, Terminal, Package, Layers, CheckCircle, AlertCircle,
  ChevronDown, ChevronUp, RefreshCw, Clock, ArrowRight, Radio,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

type Tab = 'run' | 'history'

interface LogEntry {
  type: 'log'
  logType: 'info' | 'status' | 'warn' | 'success' | 'error'
  message: string
  ts: number
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

// ── Log styling ────────────────────────────────────────────────────────────────

const LOG_STYLES: Record<string, { prefix: string; cls: string }> = {
  info:    { prefix: '›',  cls: 'text-slate-400' },
  status:  { prefix: '◈',  cls: 'text-yellow-400' },
  warn:    { prefix: '⚠',  cls: 'text-orange-400' },
  success: { prefix: '✦',  cls: 'text-green-400 font-semibold' },
  error:   { prefix: '✗',  cls: 'text-red-400' },
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
    running:   'border-yellow-500 text-yellow-400',
    completed: 'border-green-500 text-green-400',
    failed:    'border-red-500 text-red-400',
  }
  const dot: Record<string, string> = {
    running:   'bg-yellow-400 animate-pulse',
    completed: 'bg-green-400',
    failed:    'bg-red-400',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-xs ${map[status] ?? 'border-slate-600 text-slate-400'}`}>
      {dot[status] && <span className={`h-1.5 w-1.5 rounded-full ${dot[status]}`} />}
      {status}
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
            : !item.upstream_skipped_reason
              ? <span className="text-green-400/60 font-mono">upstream — no updates</span>
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
          ) : (
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400/50" />
              <span className="text-sm text-green-400/50 font-mono">Upstream — no updates</span>
            </div>
          )}
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

// ── Live job card with SSE stream ─────────────────────────────────────────────

function LiveJobCard({ job, onComplete }: { job: LiveJob; onComplete: () => void }) {
  const [logs, setLogs]       = useState<LogEntry[]>([])
  const [status, setStatus]   = useState<string>('running')
  const [snapshot, setSnapshot] = useState<{ plugins: UpdateSummary; themes: UpdateSummary; upstreamUpdated: boolean; upstreamConflict: boolean } | null>(null)
  const consoleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight
    }
  }, [logs])

  useEffect(() => {
    let cancelled = false

    const connect = async () => {
      const res = await fetch(`/api/staging?jobId=${job.id}`)
      if (!res.body || cancelled) return

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer    = ''

      const read = async (): Promise<void> => {
        if (cancelled) return
        const { done, value } = await reader.read()
        if (done) return
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
            } else if (ev.type === 'complete') {
              setStatus(ev.status)
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
              return
            }
          } catch {}
        }
        return read()
      }

      await read()
    }

    void connect()
    return () => { cancelled = true }
  }, [job.id, onComplete])

  const label = job.site_name ?? job.site

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
      </div>

      {/* Console */}
      <div
        ref={consoleRef}
        className="h-64 overflow-y-auto bg-slate-900 p-4 space-y-0.5"
      >
        {logs.length === 0 && (
          <p className="text-xs text-slate-600 font-mono">Connecting…</p>
        )}
        {logs.map((entry, i) => <LogLine key={i} entry={entry} />)}
        {status === 'running' && (
          <div className="flex gap-2 font-mono text-xs text-slate-600">
            <span className="animate-pulse">▋</span>
          </div>
        )}
      </div>

      {/* Results */}
      {snapshot && status !== 'running' && (
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
              <span>Deployment scheduled in mu-deployment — 2 business days · 9 AM PHT</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Page() {
  const [tab, setTab]           = useState<Tab>('run')
  const [site, setSite]         = useState('')
  const [multidev, setMultidev] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [liveJobs, setLiveJobs]       = useState<LiveJob[]>([])
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())
  const seenJobIds = useRef<Set<string>>(new Set())

  const [history, setHistory]             = useState<HistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Poll for running jobs — auto-switch to History when one appears
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

  const handleJobComplete = useCallback((id: string) => {
    setCompletedIds((prev) => new Set([...prev, id]))
    void loadHistory()
  }, [loadHistory])

  const startJob = useCallback(async () => {
    if (!site.trim() || !multidev.trim()) return
    setSubmitting(true)
    try {
      await fetch('/api/staging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site: site.trim(), multidev: multidev.trim() }),
      })
      setTab('history')
    } finally {
      setSubmitting(false)
    }
  }, [site, multidev])

  // Past jobs = history minus currently live
  const liveIds  = new Set(liveJobs.map((j) => j.id))
  const pastJobs = history.filter((h) => !liveIds.has(h.id))

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
          {(['run', 'history'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={[
                'relative px-4 py-2 text-sm font-medium transition-colors capitalize',
                tab === t
                  ? 'border-b-2 border-[#FFDC28] text-[#FFDC28]'
                  : 'text-slate-400 hover:text-slate-200',
              ].join(' ')}
            >
              {t}
              {t === 'history' && liveJobs.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-yellow-400 animate-pulse" />
              )}
            </button>
          ))}
        </div>

        {/* ── Run tab ── */}
        {tab === 'run' && (
          <Card>
            <CardHeader
              icon={<Server className="w-5 h-5" />}
              title="Target Environment"
              description="Enter the Pantheon site ID and multidev name to update"
            />
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400 font-mono">Multidev Name</label>
                  <input
                    type="text"
                    value={multidev}
                    onChange={(e) => setMultidev(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !submitting && startJob()}
                    placeholder="mu-260805"
                    disabled={submitting}
                    className="w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-[#FFDC28] focus:outline-none disabled:opacity-50"
                  />
                </div>
              </div>
              <button
                onClick={startJob}
                disabled={submitting || !site.trim() || !multidev.trim()}
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

            {/* Live section */}
            {liveJobs.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Radio className="w-4 h-4 text-yellow-400 animate-pulse" />
                  <h3 className="text-sm font-semibold text-yellow-400 uppercase tracking-widest">Live</h3>
                </div>
                {liveJobs.map((job) => (
                  <LiveJobCard
                    key={job.id}
                    job={job}
                    onComplete={() => handleJobComplete(job.id)}
                  />
                ))}
              </div>
            )}

            {/* Past section */}
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

      </div>
    </div>
  )
}
