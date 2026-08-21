'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Server, Terminal, Package, Layers, CheckCircle, AlertCircle,
  ChevronDown, ChevronUp, RefreshCw, Clock, ArrowRight, Radio,
  Calendar, CalendarClock, Trash2, Plus, Pause, X, Check, Globe, ExternalLink,
} from 'lucide-react'
import Header from '@/app/components/Header'

// mu-vrt hosts the per-site VRT config (paths + threshold). The registry rows
// link out to it; override per environment if the service URL changes.
const MU_VRT_URL = process.env.NEXT_PUBLIC_MU_VRT_URL || 'https://mu-vrt-production.up.railway.app'

// ── Types ──────────────────────────────────────────────────────────────────────

type Tab = 'sites' | 'stage' | 'schedule' | 'upcoming' | 'history'

type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'bimonthly-week-of-15' | 'security-only' | 'once'

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

interface UpstreamUpdateEntry { message: string; hash?: string }

interface HistoryItem {
  id: string
  site: string
  machine_name?: string
  site_name?: string
  multidev: string
  upstream?: string
  upstream_updated: boolean
  upstream_skipped_reason?: string
  upstream_conflict_files?: string[]
  upstream_updates?: UpstreamUpdateEntry[]
  upstream_old_version?: string
  upstream_new_version?: string
  plugins_updated: UpdatedItem[]
  plugins_skipped: SkippedItem[]
  themes_updated: UpdatedItem[]
  themes_skipped: SkippedItem[]
  vrt_report_url?: string | null
  vrt_flagged_count?: number | null
  vrt_status?: string | null
  status: string
  started_at: string
  completed_at: string | null
}

interface StagingSchedule {
  id: string
  site: string
  site_name?: string
  machine_name?: string | null
  cadence: Cadence
  day_of_week?: number
  week_of_month?: number
  biweekly_reference_date?: string
  bimonthly_ref_month?: number
  bimonthly_day_of_week?: number
  security_check_enabled: boolean
  skip_upstream: boolean
  skip_plugins_themes: boolean
  deploy_days?: number
  deploy_destination?: string
  active: boolean
  created_at: string
  last_staged_at?: string
  next_staging_at?: string
}

interface UpcomingEntry {
  id: string
  site: string
  site_name?: string
  machine_name?: string | null
  cadence: string
  at: string
  due_now?: boolean   // slot already passed inside an on-cadence week — fires next tick
  skip_upstream: boolean
  skip_plugins_themes: boolean
}

type Platform = 'wp-single' | 'wp-multisite' | 'drupal'
type UpdateMode = 'upstream' | 'composer' | 'none'

interface Site {
  site: string
  machine_name?: string | null
  site_name?: string | null
  site_uuid?: string | null
  platform: Platform
  parent_site?: string | null
  php_version?: string | null
  upstream?: string | null
  update_mode: UpdateMode
  skip_upstream: boolean
  skip_plugins_themes: boolean
  deploy_days: number
  deploy_destination: 'dev' | 'test' | 'live' | 'multidev'
  deploy_approval?: 'manual' | 'auto'
  security_deploy_hours?: number
  vrt_paths: string[]
  active: boolean
  auto_stage?: boolean
  notes?: string | null
  last_deployment?: string | null
  created_at?: string
  updated_at?: string
}

const UPDATE_MODE_LABELS: Record<UpdateMode, string> = {
  upstream: 'Pantheon upstream',
  composer: 'Composer-managed',
  none:     'No core updates',
}

const PLATFORM_LABELS: Record<Platform, string> = {
  'wp-single':    'WordPress',
  'wp-multisite': 'WP Multisite',
  'drupal':       'Drupal',
}

// US Pacific date string YYMMDD — matches how multidevs are named (see lib/timezone)
function getPacificYYMMDD(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: '2-digit', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${get('year')}${get('month')}${get('day')}`
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
  'once': 'One-off',
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

function HistoryRow({ item, vrtVisible }: { item: HistoryItem; vrtVisible: boolean }) {
  const machineName = item.machine_name ?? item.site
  const [open, setOpen] = useState(false)

  const statusColors: Record<string, string> = {
    completed:  'text-green-400',
    failed:     'text-red-400',
    paused:     'text-blue-400',
    cancelled:  'text-slate-500',
    running:    'text-yellow-400',
  }
  const siteColor  = statusColors[item.status] ?? 'text-slate-400'
  const statusLabel: Record<string, string> = { completed: 'staged' }
  const endLabel   = item.status === 'failed' ? 'Failed:' : item.status === 'cancelled' ? 'Cancelled:' : 'Completed:'

  const fmt = (ts: string) =>
    new Date(ts).toLocaleString('en-PH', {
      timeZone: 'Asia/Manila', month: 'short', day: 'numeric',
      year: 'numeric', hour: 'numeric', minute: '2-digit',
    })

  const updatedCount = item.plugins_updated.length + item.themes_updated.length
  const skippedCount = item.plugins_skipped.length + item.themes_skipped.length
  const hasDetails   = updatedCount > 0 || skippedCount > 0 || item.upstream_updated || !!item.upstream_skipped_reason

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4 space-y-1.5">

      {/* Row 1: Site name + status */}
      <div className="flex items-start justify-between gap-3">
        <div className="truncate">
          <span className={`font-mono text-sm font-semibold ${siteColor}`}>
            {item.site_name ?? machineName}
          </span>
          {item.site_name && (
            <span className="ml-1.5 font-mono font-normal text-slate-500 text-xs">· {machineName}</span>
          )}
        </div>
        <span className={`font-mono text-xs font-semibold shrink-0 ${siteColor}`}>
          {statusLabel[item.status] ?? item.status}
        </span>
      </div>

      {/* Row 2: Multidev + summary chips */}
      <div className="font-mono text-xs flex items-center flex-wrap gap-x-2 gap-y-0.5">
        <span className="text-[#FFDC28]">{item.multidev}</span>
        {item.upstream && (
          item.upstream_updated
            ? <><span className="text-slate-600">·</span><span className="text-green-400">upstream ✓</span></>
            : item.upstream_skipped_reason
              ? <><span className="text-slate-600">·</span><span className="text-orange-400">upstream skipped</span></>
              : <><span className="text-slate-600">·</span><span className="text-slate-500">upstream — no updates</span></>
        )}
        {(updatedCount > 0 || skippedCount > 0) && (
          <>
            <span className="text-slate-600">·</span>
            <span className="text-green-400">{updatedCount} updated</span>
            {skippedCount > 0 && (
              <><span className="text-slate-600">·</span><span className="text-orange-400">{skippedCount} skipped</span></>
            )}
          </>
        )}
        {!item.upstream && updatedCount === 0 && skippedCount === 0 && item.status === 'completed' && (
          <><span className="text-slate-600">·</span><span className="text-slate-500">nothing updated</span></>
        )}
        {vrtVisible && item.vrt_report_url && (
          <>
            <span className="text-slate-600">·</span>
            <a
              href={item.vrt_report_url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open the shareable visual-regression report (safe to send to the customer)"
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors ${
                (item.vrt_flagged_count ?? 0) > 0
                  ? 'text-orange-400 hover:bg-orange-400/10'
                  : item.vrt_status === 'completed'
                    ? 'text-green-400 hover:bg-green-400/10'
                    : 'text-slate-400 hover:bg-slate-400/10'
              }`}
            >
              🔍 VRT: {(item.vrt_flagged_count ?? 0) > 0
                ? `${item.vrt_flagged_count} flagged`
                : item.vrt_status === 'completed'
                  ? 'all clear'
                  : 'report'}
              <ExternalLink className="w-3 h-3" />
            </a>
          </>
        )}
      </div>

      {/* Row 3: Timestamps */}
      <div className="flex flex-wrap gap-x-4 font-mono text-xs text-slate-400">
        <span>Started: {fmt(item.started_at)}</span>
        <span>{endLabel} {item.completed_at ? fmt(item.completed_at) : '—'}</span>
      </div>

      {/* Expandable detail */}
      {hasDetails && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 font-mono text-xs text-slate-500 hover:text-slate-300 transition-colors pt-0.5"
        >
          {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {open ? 'Hide details' : 'Show details'}
        </button>
      )}

      {open && hasDetails && (
        <div className="border-t border-slate-700 pt-3 space-y-3">
          {/* Upstream Update/s */}
          {(item.upstream_updated || item.upstream_skipped_reason) && (
            <div className="space-y-0.5 font-mono text-xs">
              <p className="text-slate-400 font-semibold">Upstream Update/s:</p>
              {item.upstream_updated && (item.upstream_updates?.length ?? 0) > 0
                ? item.upstream_updates!.map((u, i) => (
                    <div key={i} className="pl-2 space-y-0.5">
                      <p className="text-green-400">- {u.message}</p>
                      {i === 0 && item.upstream_old_version && item.upstream_new_version && (
                        <p className="pl-2 text-slate-500">WordPress ({item.upstream_old_version} to {item.upstream_new_version})</p>
                      )}
                    </div>
                  ))
                : item.upstream_updated
                  ? <div className="pl-2 space-y-0.5">
                      <p className="text-green-400">- Applied successfully</p>
                      {item.upstream_old_version && item.upstream_new_version && (
                        <p className="pl-2 text-slate-500">WordPress ({item.upstream_old_version} to {item.upstream_new_version})</p>
                      )}
                    </div>
                  : null}
              {item.upstream_skipped_reason && (
                <p className="pl-2 text-orange-400">- Skipped — {item.upstream_skipped_reason}</p>
              )}
              {/* The conflicting paths, verbatim, so they can be handed to the
                  customer's developers — we never force-overwrite customizations. */}
              {(item.upstream_conflict_files?.length ?? 0) > 0 && (
                <div className="pl-2 space-y-0.5">
                  <p className="text-slate-500">Conflicting files (reverted — nothing was changed):</p>
                  <pre className="max-h-40 overflow-auto rounded border border-slate-700 bg-slate-900/60 p-2 text-[0.7rem] text-orange-300 whitespace-pre-wrap select-all">
{item.upstream_conflict_files!.join('\n')}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Plugin/s — updated only, with count */}
          {item.plugins_updated.length > 0 && (
            <div className="space-y-0.5 font-mono text-xs">
              <p className="text-slate-400 font-semibold">
                Plugin/s <span className="text-green-400">({item.plugins_updated.length} updated):</span>
              </p>
              {item.plugins_updated.map((p) => (
                <p key={p.name} className="pl-2 text-slate-200">
                  - {p.title} <span className="text-slate-500">({p.from} to {p.to})</span>
                </p>
              ))}
            </div>
          )}

          {/* Theme/s — updated only, with count */}
          {item.themes_updated.length > 0 && (
            <div className="space-y-0.5 font-mono text-xs">
              <p className="text-slate-400 font-semibold">
                Theme/s <span className="text-green-400">({item.themes_updated.length} updated):</span>
              </p>
              {item.themes_updated.map((t) => (
                <p key={t.name} className="pl-2 text-slate-200">
                  - {t.title} <span className="text-slate-500">({t.from} to {t.to})</span>
                </p>
              ))}
            </div>
          )}

          {/* Skipped — plugins + themes combined, with count */}
          {(item.plugins_skipped.length > 0 || item.themes_skipped.length > 0) && (
            <div className="space-y-0.5 font-mono text-xs">
              <p className="text-slate-400 font-semibold">
                Skipped <span className="text-orange-400">({item.plugins_skipped.length + item.themes_skipped.length}):</span>
              </p>
              {item.plugins_skipped.map((p) => (
                <p key={p.name} className="pl-2 text-orange-400">
                  - {p.title} <span className="text-orange-500/70">— {p.reason}</span>
                </p>
              ))}
              {item.themes_skipped.map((t) => (
                <p key={t.name} className="pl-2 text-orange-400">
                  - {t.title} <span className="text-orange-500/70">— {t.reason}</span>
                </p>
              ))}
            </div>
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
  const isPaused     = status === 'paused'
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
        {isPaused && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={async () => {
                await fetch('/api/staging', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ site: job.site }),
                })
              }}
              title="Restart staging from scratch"
              className="flex items-center gap-1 rounded border border-[#FFDC28]/40 px-2 py-0.5 text-xs text-[#FFDC28] hover:bg-[#FFDC28]/10 transition-colors"
            >
              ↺ Restart
            </button>
            <button
              onClick={cancelJob}
              disabled={cancelling}
              title="Cancel and dismiss"
              className="flex items-center gap-1 rounded border border-red-700 px-2 py-0.5 text-xs text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-40"
            >
              <X className="w-3 h-3" />
              {cancelling ? '…' : 'Cancel'}
            </button>
          </div>
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

// ── Sites Registry Tab ──────────────────────────────────────────────────────

type UiCadence = 'weekly' | 'biweekly' | 'monthly' | 'custom'

const UI_CADENCE_LABELS: Record<UiCadence, string> = {
  weekly:   'Weekly',
  biweekly: 'Bi-weekly',
  monthly:  'Monthly',
  custom:   'Custom (every other month, week of the 15th)',
}

// The standing-schedule store cadence 'bimonthly-week-of-15' is surfaced as "Custom".
function storeToUiCadence(c?: string): UiCadence {
  if (c === 'weekly' || c === 'biweekly' || c === 'monthly') return c
  return 'custom' // bimonthly-week-of-15 (and any legacy) → Custom
}
function uiToStoreCadence(u: UiCadence): Cadence {
  return u === 'custom' ? 'bimonthly-week-of-15' : u
}

// Manila-time helpers for schedule anchoring
function manilaTodayDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
}
function manilaMonth(): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', month: 'numeric' }).format(new Date()))
}

// One-line summary of a site's standing schedule (for the card)
function formatStandingSchedule(s: StagingSchedule): string {
  if (s.cadence === 'weekly' && s.day_of_week != null)   return `Weekly · ${DAYS[s.day_of_week]}`
  if (s.cadence === 'biweekly' && s.day_of_week != null) return `Bi-weekly · ${DAYS[s.day_of_week]}`
  if (s.cadence === 'monthly' && s.day_of_week != null && s.week_of_month != null)
    return `Monthly · ${WEEKS.find(w => w.v === s.week_of_month)?.l ?? ''} ${DAYS[s.day_of_week]}`
  if (s.cadence === 'bimonthly-week-of-15' && s.bimonthly_day_of_week != null)
    return `Custom · ${DAYS[s.bimonthly_day_of_week]} · every other month`
  return CADENCE_LABELS[s.cadence] ?? s.cadence
}

interface SiteFormState {
  site: string
  platform: Platform
  // update policy — SITE FACTS (write to the registry; read by runUpstreamCheck)
  update_mode: UpdateMode
  skip_upstream: boolean
  skip_plugins_themes: boolean
  auto_stage: boolean
  vrt_paths_text: string
  notes: string
  // standing schedule (timing) — writes to staging_schedules
  managed: boolean
  cadence: UiCadence
  day_of_week: number
  week_of_month: number
  deploy_days: number
  deploy_destination: 'dev' | 'test' | 'live' | 'multidev'
  scheduleId: string | null
  biweekly_reference_date: string
  last_deployment: string          // YYYY-MM-DD — cadence anchor (last completed cycle)
}

const emptySiteForm: SiteFormState = {
  site: '', platform: 'wp-single', update_mode: 'upstream',
  skip_upstream: false, skip_plugins_themes: false, auto_stage: false, vrt_paths_text: '', notes: '',
  managed: false, cadence: 'weekly', day_of_week: 1, week_of_month: 1,
  deploy_days: 1, deploy_destination: 'live',
  scheduleId: null, biweekly_reference_date: '', last_deployment: '',
}

function SitesTab() {
  const [sites, setSites]         = useState<Site[]>([])
  const [schedules, setSchedules] = useState<StagingSchedule[]>([])
  const [loading, setLoading]     = useState(true)
  const [editing, setEditing]     = useState<string | null>(null) // site machine-name, or '__new__'
  const [optionsFor, setOptionsFor] = useState<Site | null>(null)
  const [form, setForm]           = useState<SiteFormState>(emptySiteForm)
  const [saving, setSaving]       = useState(false)
  const [busy, setBusy]           = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)

  const inputCls  = 'w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-[#FFDC28] focus:outline-none'
  const labelCls  = 'text-xs text-slate-400 font-mono'

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [sr, cr] = await Promise.all([fetch('/api/sites'), fetch('/api/schedules')])
      if (sr.ok) setSites(await sr.json())
      if (cr.ok) setSchedules(await cr.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadAll() }, [loadAll])

  // The standing schedule for a site (≤1 active per managed site under this model)
  const scheduleForSite = useCallback(
    (site: string) => schedules.find(s => s.site === site && s.active !== false),
    [schedules],
  )

  // Read-only display of the VRT paths (owned by the VRT app). Not written from here.
  const vrtPaths = form.vrt_paths_text.split('\n').map(p => p.trim()).filter(Boolean)

  const openNew  = () => { setForm(emptySiteForm); setEditing('__new__'); setError(null) }
  const openEdit = (s: Site) => {
    // find any schedule row (even paused) so re-enabling reuses it instead of duplicating
    const sched = schedules.find(x => x.site === s.site)
    setForm({
      site: s.site, platform: s.platform,
      update_mode: s.update_mode ?? 'upstream',
      skip_upstream: s.skip_upstream ?? false,          // site fact (registry)
      skip_plugins_themes: s.skip_plugins_themes ?? false,
      auto_stage: s.auto_stage ?? false,
      vrt_paths_text: (s.vrt_paths ?? []).join('\n'), notes: s.notes ?? '',
      managed: Boolean(sched) && sched?.active !== false,
      cadence: storeToUiCadence(sched?.cadence),
      day_of_week: sched?.day_of_week ?? sched?.bimonthly_day_of_week ?? 1,
      week_of_month: sched?.week_of_month ?? 1,
      deploy_days: sched?.deploy_days ?? 1,
      deploy_destination: (sched?.deploy_destination as SiteFormState['deploy_destination']) ?? 'live',
      scheduleId: sched?.id ?? null,
      biweekly_reference_date: sched?.biweekly_reference_date ?? '',
      last_deployment: (s.last_deployment ?? '').slice(0, 10),
    })
    setEditing(s.site); setError(null)
  }

  const save = async () => {
    if (!form.site.trim()) return
    setSaving(true); setError(null)
    try {
      const site = form.site.trim()
      const isNew = editing === '__new__'

      // 1) Site facts + update policy (skip flags are site facts read by runUpstreamCheck)
      const siteRes = await fetch(isNew ? '/api/sites' : `/api/sites/${encodeURIComponent(site)}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site, platform: form.platform,
          update_mode: form.update_mode,
          skip_upstream: form.skip_upstream, skip_plugins_themes: form.skip_plugins_themes,
          // auto_stage from #148; vrt_paths deliberately NOT sent — the VRT app
          // owns that config now and this form only displays it.
          auto_stage: form.auto_stage,
          notes: form.notes.trim() || null,
          last_deployment: form.last_deployment ? new Date(form.last_deployment).toISOString() : null,
        }),
      })
      if (!siteRes.ok) { setError((await siteRes.json().catch(() => ({}))).error ?? `Site save failed (HTTP ${siteRes.status})`); return }

      // 2) Standing schedule — TIMING only (skip flags live on the site, above)
      if (form.managed) {
        const store = uiToStoreCadence(form.cadence)
        const body: Record<string, unknown> = {
          site, cadence: store, active: true,
          deploy_days: form.deploy_days, deploy_destination: form.deploy_destination,
        }
        if (store === 'weekly' || store === 'biweekly' || store === 'monthly') body.day_of_week = form.day_of_week
        if (store === 'monthly') body.week_of_month = form.week_of_month
        // Anchor biweekly parity on the real last-deployment week when known,
        // so a back-dated site lands on the correct next week (not registration day).
        if (store === 'biweekly') body.biweekly_reference_date = form.biweekly_reference_date || form.last_deployment || manilaTodayDate()
        if (store === 'bimonthly-week-of-15') { body.bimonthly_ref_month = manilaMonth(); body.bimonthly_day_of_week = form.day_of_week }

        const schedRes = form.scheduleId
          ? await fetch(`/api/schedules/${form.scheduleId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          : await fetch('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (!schedRes.ok) { setError((await schedRes.json().catch(() => ({}))).error ?? `Schedule save failed (HTTP ${schedRes.status})`); return }
      } else if (form.scheduleId) {
        // Managed turned off — deactivate the standing schedule (preserve history)
        await fetch(`/api/schedules/${form.scheduleId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) })
      }

      setEditing(null); await loadAll()
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (s: Site) => {
    setBusy(s.site)
    try {
      await fetch(`/api/sites/${encodeURIComponent(s.site)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !s.active }),
      })
      await loadAll()
    } finally { setBusy(null) }
  }

  const reSync = async (s: Site) => {
    setBusy(s.site)
    try {
      // POST re-runs terminus resolve without clobbering user-set defaults
      await fetch('/api/sites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site: s.site }),
      })
      await loadAll()
    } finally { setBusy(null) }
  }

  const remove = async (s: Site) => {
    setBusy(s.site)
    try {
      await fetch(`/api/sites/${encodeURIComponent(s.site)}`, { method: 'DELETE' })
      await loadAll()
    } finally { setBusy(null) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">Sites Registry</h3>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 rounded-lg bg-[#FFDC28] hover:bg-[#E6C625] px-3 py-1.5 text-xs font-semibold text-slate-900 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Register Site
        </button>
      </div>

      <p className="text-xs text-slate-500">
        Shared with mu-deployment — register or edit here or there, same data.
      </p>

      {/* Register / edit form */}
      {editing && (
        <Card className="overflow-visible">
          <CardHeader
            icon={<Globe className="w-5 h-5" />}
            title={editing === '__new__' ? 'Register Site' : `Edit ${form.site}`}
            description={editing === '__new__' ? 'Name, PHP version & upstream are auto-resolved from Pantheon.' : undefined}
          />
          <div className="px-6 py-5 space-y-4">
            {editing === '__new__' && (
              <div className="space-y-1.5">
                <label className={labelCls}>Site ID <span className="text-slate-600 normal-case">(Pantheon machine name)</span></label>
                <input type="text" value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))}
                  placeholder="my-site-name" className={inputCls} />
              </div>
            )}

            <div className="space-y-1.5">
              <label className={labelCls}>Platform</label>
              <select value={form.platform} onChange={e => setForm(f => ({ ...f, platform: e.target.value as Platform }))}
                className={inputCls}>
                {(Object.keys(PLATFORM_LABELS) as Platform[]).map(p => (
                  <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>
                ))}
              </select>
            </div>

            {/* ── Update policy (site facts — apply to every run, scheduled or ad-hoc) ── */}
            <div className="space-y-3 pt-1 border-t border-slate-700">
              <p className="font-mono text-xs uppercase tracking-widest text-slate-400 pt-1">Update policy</p>
              <div className="space-y-1.5">
                <label className={labelCls}>Core updates</label>
                <select value={form.update_mode} onChange={e => setForm(f => ({ ...f, update_mode: e.target.value as UpdateMode }))}
                  className={inputCls}>
                  {(Object.keys(UPDATE_MODE_LABELS) as UpdateMode[]).map(m => (
                    <option key={m} value={m}>{UPDATE_MODE_LABELS[m]}</option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={form.skip_upstream} onChange={e => setForm(f => ({ ...f, skip_upstream: e.target.checked }))}
                  className="rounded border-slate-600 bg-slate-700 accent-[#FFDC28]" />
                Skip upstream updates
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={form.skip_plugins_themes} onChange={e => setForm(f => ({ ...f, skip_plugins_themes: e.target.checked }))}
                  className="rounded border-slate-600 bg-slate-700 accent-[#FFDC28]" />
                Skip plugins &amp; themes
              </label>
              <label className="flex items-start gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={form.auto_stage} onChange={e => setForm(f => ({ ...f, auto_stage: e.target.checked }))}
                  className="mt-0.5 rounded border-slate-600 bg-slate-700 accent-[#FFDC28]" />
                <span>Enable auto-staging
                  <span className="block text-[0.7rem] text-slate-500 font-mono">Off = registered but never auto-staged (scan / schedule / security). Turn on only when the site is ready.</span>
                </span>
              </label>
            </div>

            {/* ── Standing schedule ── */}
            <div className="space-y-3 pt-1 border-t border-slate-700">
              <label className="flex items-center gap-2 cursor-pointer pt-1">
                <input type="checkbox" checked={form.managed} onChange={e => setForm(f => ({ ...f, managed: e.target.checked }))}
                  className="rounded border-slate-600 bg-slate-700 accent-[#FFDC28]" />
                <span className="font-mono text-xs uppercase tracking-widest text-slate-400">Standing schedule — recurring staging</span>
              </label>

              {form.managed && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className={labelCls}>Cadence</label>
                      <select value={form.cadence} onChange={e => setForm(f => ({ ...f, cadence: e.target.value as UiCadence }))}
                        className={inputCls}>
                        {(Object.keys(UI_CADENCE_LABELS) as UiCadence[]).map(c => (
                          <option key={c} value={c}>{c === 'custom' ? 'Custom' : UI_CADENCE_LABELS[c]}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className={labelCls}>Day of week</label>
                      <select value={form.day_of_week} onChange={e => setForm(f => ({ ...f, day_of_week: Number(e.target.value) }))}
                        className={inputCls}>
                        {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                      </select>
                    </div>
                  </div>

                  {form.cadence === 'monthly' && (
                    <div className="space-y-1.5">
                      <label className={labelCls}>Which occurrence</label>
                      <select value={form.week_of_month} onChange={e => setForm(f => ({ ...f, week_of_month: Number(e.target.value) }))}
                        className={inputCls}>
                        {WEEKS.map(w => <option key={w.v} value={w.v}>{w.l}</option>)}
                      </select>
                      <p className="text-xs text-slate-500">e.g. &quot;Last&quot; + &quot;Thursday&quot; = last Thursday of each month.</p>
                    </div>
                  )}

                  {form.cadence === 'custom' && (
                    <p className="text-xs text-slate-500">Runs on the chosen day in the week of the 15th, every other month.</p>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className={labelCls}>Deploy to</label>
                      <select value={form.deploy_destination} onChange={e => setForm(f => ({ ...f, deploy_destination: e.target.value as SiteFormState['deploy_destination'] }))}
                        className={inputCls}>
                        <option value="live">Live</option>
                        <option value="test">Test</option>
                        <option value="dev">Dev</option>
                        <option value="multidev">Multidev (no deploy)</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className={labelCls}>Deploy after</label>
                      <select value={form.deploy_days} onChange={e => setForm(f => ({ ...f, deploy_days: Number(e.target.value) }))}
                        className={inputCls}>
                        <option value={1}>1 business day</option>
                        <option value={2}>2 business days</option>
                        <option value={3}>3 business days</option>
                        <option value={5}>5 business days</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1.5 pt-1 border-t border-slate-700">
              <label className={labelCls}>
                VRT paths <span className="text-slate-600 normal-case">(managed in the VRT app — read-only here)</span>
              </label>
              {vrtPaths.length > 0 ? (
                <div className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 font-mono text-xs text-slate-300 max-h-32 overflow-y-auto space-y-0.5">
                  {vrtPaths.map((p, i) => <div key={i}>{p}</div>)}
                </div>
              ) : (
                <p className="font-mono text-xs text-slate-500">No VRT paths configured.</p>
              )}
              {editing !== '__new__' && (
                <a href={`${MU_VRT_URL}/vrt/${encodeURIComponent(form.site)}`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-[#FFDC28] hover:underline">
                  Edit paths, thresholds &amp; exclusions in the VRT app <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>

            <div className="space-y-1.5">
              <label className={labelCls}>Last deployment <span className="text-slate-600 normal-case">(optional — cadence anchor)</span></label>
              <input type="date" value={form.last_deployment} onChange={e => setForm(f => ({ ...f, last_deployment: e.target.value }))}
                className={inputCls} />
              <p className="text-[0.7rem] text-slate-500 font-mono">When this site was last deployed. The recurring cadence counts ISO weeks from this one — set it for sites deployed before onboarding so the first run lands on the right week. Left blank, the cycle counts from the schedule&apos;s creation week, which (with auto-staging on) can mean a run today.</p>
            </div>

            <div className="space-y-1.5">
              <label className={labelCls}>Notes <span className="text-slate-600 normal-case">(optional)</span></label>
              <input type="text" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="anything worth noting" className={inputCls} />
            </div>

            {error && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-400">{error}</div>
            )}

            <div className="flex gap-2 pt-2">
              <button onClick={save} disabled={saving || !form.site.trim()}
                className="flex-1 rounded-lg bg-[#FFDC28] hover:bg-[#E6C625] px-4 py-2.5 text-sm font-semibold text-slate-900 transition-colors disabled:opacity-40">
                {saving ? 'Saving…' : editing === '__new__' ? 'Register Site' : 'Save Changes'}
              </button>
              <button onClick={() => setEditing(null)} className="px-4 py-2.5 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
            </div>
          </div>
        </Card>
      )}

      {/* Site list */}
      {loading && sites.length === 0 && (
        <p className="text-sm text-slate-500 font-mono text-center py-6">Loading…</p>
      )}
      {!loading && sites.length === 0 && (
        <div className="text-center py-8 space-y-2">
          <Globe className="w-8 h-8 text-slate-600 mx-auto" />
          <p className="text-sm text-slate-500">No sites registered yet — add one above</p>
          <p className="text-xs text-slate-600">(If you just created the table, run the backfill in Supabase.)</p>
        </div>
      )}

      {sites.map((s) => (
        <div key={s.site} className={`rounded-xl border bg-slate-800 overflow-hidden ${s.active ? 'border-slate-700' : 'border-slate-700/50 opacity-60'}`}>
          <div className="flex items-center gap-3 px-5 py-3">
            <div className="flex-1 min-w-0">
              <span className="font-mono text-sm text-white">{s.site_name ?? s.machine_name ?? s.site}</span>
              {s.site_name && <span className="ml-2 text-xs text-slate-500 font-mono">{s.machine_name ?? s.site}</span>}
              <div className="flex flex-wrap gap-1.5 mt-1">
                <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-300">{PLATFORM_LABELS[s.platform]}</span>
                {s.auto_stage
                  ? <span className="text-xs rounded bg-green-500/15 px-2 py-0.5 text-green-400">auto-stage on</span>
                  : <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-500">auto-stage off</span>}
                {s.php_version && <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-400">PHP {s.php_version}</span>}
                {s.upstream && <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-400">{s.upstream}</span>}
                {(() => {
                  const sched = scheduleForSite(s.site)
                  return sched ? (
                    <>
                      <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-300">{formatStandingSchedule(sched)}</span>
                      <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-400">→ {sched.deploy_destination ?? 'live'} · +{sched.deploy_days ?? 1}bd</span>
                    </>
                  ) : (
                    <span className="text-xs rounded bg-slate-700/50 px-2 py-0.5 text-slate-500">no schedule</span>
                  )
                })()}
                {(s.vrt_paths?.length ?? 0) > 0 && <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-400">{s.vrt_paths.length} VRT</span>}
              </div>
            </div>
            <button onClick={() => reSync(s)} disabled={busy === s.site}
              className="text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-40" title="Re-sync from Pantheon">
              <RefreshCw className={`w-4 h-4 ${busy === s.site ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={() => openEdit(s)} className="text-xs text-slate-400 hover:text-white transition-colors">Edit</button>
            <button onClick={() => setOptionsFor(s)}
              className="text-xs text-slate-400 hover:text-white transition-colors" title="Plugins and themes to skip on this site">Options</button>
            <a href={`${MU_VRT_URL}/vrt/${encodeURIComponent(s.site)}`} target="_blank" rel="noopener noreferrer"
              className="text-xs text-slate-400 hover:text-sky-300 transition-colors inline-flex items-center gap-1" title="Configure VRT (paths + threshold)">
              <Globe className="w-3.5 h-3.5" /> VRT
            </a>
            <button onClick={() => toggleActive(s)} disabled={busy === s.site}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${s.active ? 'border-green-700 text-green-400 hover:bg-green-900/30' : 'border-slate-600 text-slate-500 hover:bg-slate-700'}`}>
              {s.active ? 'Active' : 'Paused'}
            </button>
            <button onClick={() => remove(s)} disabled={busy === s.site}
              className="text-red-500 hover:text-red-400 transition-colors disabled:opacity-40" title="Remove from registry">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}

      {optionsFor && (
        <Modal
          title={optionsFor.machine_name ?? optionsFor.site_name ?? optionsFor.site}
          onClose={() => setOptionsFor(null)}
        >
          <UpdateOptionsTab site={optionsFor.site} />
        </Modal>
      )}
    </div>
  )
}

function ScheduleTab() {
  const [jobs, setJobs]         = useState<StagingSchedule[]>([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [busy, setBusy]         = useState<string | null>(null)

  const [site, setSite]                 = useState('')
  const [when, setWhen]                 = useState(() => `${manilaTodayDate()}T15:00`)
  const [destination, setDestination]   = useState('live')
  const [deployDays, setDeployDays]     = useState(2)
  const [skipUpstream, setSkipUpstream] = useState(false)
  const [skipPluginsThemes, setSkipPluginsThemes] = useState(false)

  const inputCls = 'w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-[#FFDC28] focus:outline-none'
  const labelCls = 'text-xs text-slate-400 font-mono'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/schedules')
      if (res.ok) {
        const all: StagingSchedule[] = await res.json()
        setJobs(all.filter(s => s.cadence === 'once' && s.active !== false)
                   .sort((a, b) => (a.next_staging_at ?? '').localeCompare(b.next_staging_at ?? '')))
      }
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (!site.trim() || !when) return
    setSaving(true); setError(null)
    try {
      // The picker value is bare local time; interpret it as Manila (+08:00).
      const iso = new Date(`${when}:00+08:00`).toISOString()
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site: site.trim(), cadence: 'once', scheduled_for: iso,
          deploy_destination: destination, deploy_days: deployDays,
          skip_upstream: skipUpstream, skip_plugins_themes: skipPluginsThemes,
        }),
      })
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? `Failed (HTTP ${res.status})`); return }
      setSite(''); setShowForm(false); await load()
    } finally { setSaving(false) }
  }

  const cancelJob = async (id: string) => {
    setBusy(id)
    try { await fetch(`/api/schedules/${id}`, { method: 'DELETE' }); await load() }
    finally { setBusy(null) }
  }

  const runNow = async (j: StagingSchedule) => {
    setBusy(j.id)
    try {
      await fetch('/api/staging', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site: j.site, deployDestination: j.deploy_destination ?? 'live', deployDays: j.deploy_days ?? 2,
          skipUpstream: j.skip_upstream, skipPluginsThemes: j.skip_plugins_themes,
        }),
      })
      // Running now consumes the one-off — remove it from the queue.
      await fetch(`/api/schedules/${j.id}`, { method: 'DELETE' })
      await load()
    } finally { setBusy(null) }
  }

  const fmt = (iso?: string) => iso
    ? new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '—'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">One-off Stagings</h3>
        </div>
        <button
          onClick={() => setShowForm(f => !f)}
          className="flex items-center gap-1.5 rounded-lg bg-[#FFDC28] hover:bg-[#E6C625] px-3 py-1.5 text-xs font-semibold text-slate-900 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Schedule One-off
        </button>
      </div>

      <p className="text-xs text-slate-500">
        Ad-hoc, single staging runs. For recurring schedules, use a site&apos;s Standing schedule in the Sites tab.
      </p>

      {showForm && (
        <Card className="overflow-visible">
          <CardHeader icon={<Calendar className="w-5 h-5" />} title="Schedule a one-off staging" description="Runs once at the chosen Manila time, then clears itself." />
          <div className="px-6 py-5 space-y-4">
            <div className="space-y-1.5">
              <label className={labelCls}>Site ID <span className="text-slate-600 normal-case">(Pantheon machine name or UUID)</span></label>
              <input type="text" value={site} onChange={e => setSite(e.target.value)} placeholder="my-site-name" className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Stage at <span className="text-slate-600 normal-case">(Manila time)</span></label>
              <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className={labelCls}>Deploy to</label>
                <select value={destination} onChange={e => setDestination(e.target.value)} className={inputCls}>
                  <option value="live">Live</option>
                  <option value="test">Test</option>
                  <option value="dev">Dev</option>
                  <option value="multidev">Multidev (no deploy)</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className={labelCls}>Deploy after</label>
                <select value={deployDays} onChange={e => setDeployDays(Number(e.target.value))} className={inputCls}>
                  <option value={1}>1 business day</option>
                  <option value={2}>2 business days</option>
                  <option value={3}>3 business days</option>
                  <option value={5}>5 business days</option>
                </select>
              </div>
            </div>
            <div className="space-y-2 pt-1 border-t border-slate-700">
              <p className="text-xs text-slate-400 font-mono pt-1">Update options</p>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={skipUpstream} onChange={e => setSkipUpstream(e.target.checked)} className="rounded border-slate-600 bg-slate-700 accent-[#FFDC28]" />
                Skip upstream updates
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={skipPluginsThemes} onChange={e => setSkipPluginsThemes(e.target.checked)} className="rounded border-slate-600 bg-slate-700 accent-[#FFDC28]" />
                Skip plugins &amp; themes
              </label>
            </div>
            {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-400">{error}</div>}
            <div className="flex gap-2 pt-2">
              <button onClick={save} disabled={saving || !site.trim() || !when}
                className="flex-1 rounded-lg bg-[#FFDC28] hover:bg-[#E6C625] px-4 py-2.5 text-sm font-semibold text-slate-900 transition-colors disabled:opacity-40">
                {saving ? 'Saving…' : 'Schedule'}
              </button>
              <button onClick={() => setShowForm(false)} className="px-4 py-2.5 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
            </div>
          </div>
        </Card>
      )}

      {loading && jobs.length === 0 && (
        <p className="text-sm text-slate-500 font-mono text-center py-6">Loading…</p>
      )}
      {!loading && jobs.length === 0 && (
        <div className="text-center py-8 space-y-2">
          <CalendarClock className="w-8 h-8 text-slate-600 mx-auto" />
          <p className="text-sm text-slate-500">No one-off stagings queued</p>
        </div>
      )}

      {jobs.map(j => (
        <div key={j.id} className="rounded-xl border border-slate-700 bg-slate-800 overflow-hidden">
          <div className="flex items-center gap-3 px-5 py-3">
            <div className="flex-1 min-w-0">
              <span className="font-mono text-sm text-white">{j.site_name ?? j.machine_name ?? j.site}</span>
              <p className="text-xs text-slate-400 mt-0.5">
                {fmt(j.next_staging_at)} · → {j.deploy_destination ?? 'live'} · +{j.deploy_days ?? 2}bd
                {(j.skip_upstream || j.skip_plugins_themes) ? ` · ${[j.skip_upstream && 'skip upstream', j.skip_plugins_themes && 'skip plugins/themes'].filter(Boolean).join(' · ')}` : ''}
              </p>
            </div>
            <button onClick={() => runNow(j)} disabled={busy === j.id}
              className="rounded-lg bg-[#FFDC28] hover:bg-[#E6C625] px-2.5 py-1.5 text-xs font-semibold text-slate-900 transition-colors disabled:opacity-40">
              Run now
            </button>
            <button onClick={() => cancelJob(j.id)} disabled={busy === j.id}
              className="text-red-500 hover:text-red-400 transition-colors disabled:opacity-40" title="Cancel">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function toManilaDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

function UpcomingTab() {
  const [upcoming, setUpcoming]   = useState<UpcomingEntry[]>([])
  const [loading, setLoading]     = useState(true)
  const [editingKey, setEditingKey]       = useState<string | null>(null)   // `${id}-${i}`
  const [editFor, setEditFor]             = useState('')
  const [applyScope, setApplyScope]       = useState<'this' | 'all' | null>(null)
  const [skippingKey, setSkippingKey]     = useState<string | null>(null)
  const [runningId, setRunningId]         = useState<string | null>(null)
  const [saving, setSaving]               = useState(false)

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

  const startEdit = (u: UpcomingEntry, i: number) => {
    setEditingKey(`${u.id}-${i}`)
    setEditFor(toManilaDatetimeLocal(u.at))
    setApplyScope(i === 0 ? null : 'this')   // first entry prompts, rest default to this-only
  }

  const saveEdit = async (u: UpcomingEntry) => {
    if (!editFor) return
    setSaving(true)
    try {
      const newIso = new Date(editFor + ':00+08:00').toISOString()
      if (applyScope === 'all') {
        // Update the schedule's next_staging_at AND shift reference — PATCH schedule
        await fetch(`/api/schedules/${u.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ next_staging_at: newIso, shift_reference: true }),
        })
      } else {
        // Just update next_staging_at for this occurrence
        await fetch(`/api/schedules/${u.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ next_staging_at: newIso }),
        })
      }
      setEditingKey(null)
      setApplyScope(null)
      void load()
    } finally {
      setSaving(false)
    }
  }

  const skipOccurrence = async (u: UpcomingEntry) => {
    // Skip the ISO week this occurrence falls in — cadence parity is untouched, so the
    // cycle resumes on its next on-parity week. Sending the occurrence lets a later
    // entry (not just the first) be the one skipped.
    setSaving(true)
    try {
      await fetch(`/api/schedules/${u.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skip_next: true, occurrence_at: u.at }),
      })
      setSkippingKey(null)
      void load()
    } finally {
      setSaving(false)
    }
  }

  const runNow = async (u: UpcomingEntry) => {
    setRunningId(u.id)
    try {
      await fetch('/api/staging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site: u.site }),
      })
    } finally {
      setRunningId(null)
    }
  }

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('en-PH', {
      timeZone: 'Asia/Manila', weekday: 'short', month: 'short',
      day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    })

  return (
    <div className="space-y-3">
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
        const key      = `${u.id}-${i}`
        const isFirst  = i === 0
        const isEditing   = editingKey === key
        const isSkipping  = skippingKey === key
        const isRunningNow = runningId === u.id

        return (
          <div key={key} className="rounded-lg border border-slate-700 bg-slate-800 p-4 space-y-3">
            {/* Row: site + datetime + actions */}
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-sm font-semibold text-white">{u.site_name ?? u.machine_name ?? u.site}</span>
                  {u.due_now ? (
                    <span className="text-xs rounded border border-green-500/40 text-green-400 px-1.5 py-0.5 font-mono">due now</span>
                  ) : isFirst && (
                    <span className="text-xs rounded border border-yellow-500/40 text-yellow-400 px-1.5 py-0.5 font-mono">next</span>
                  )}
                  {(u.skip_upstream || u.skip_plugins_themes) && (
                    <span className="text-xs rounded bg-slate-700 px-1.5 py-0.5 text-slate-400 font-mono">
                      {u.skip_upstream && u.skip_plugins_themes ? 'upstream+plugins skipped' : u.skip_upstream ? 'upstream skipped' : 'plugins/themes skipped'}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 font-mono mt-0.5">{CADENCE_LABELS[u.cadence as Cadence] ?? u.cadence}</p>

                {isEditing ? (
                  <div className="mt-2 space-y-2">
                    <input
                      type="datetime-local"
                      value={editFor}
                      onChange={e => setEditFor(e.target.value)}
                      className="rounded border border-slate-600 bg-slate-700 px-2 py-1 font-mono text-xs text-white focus:border-[#FFDC28] focus:outline-none"
                    />
                    {/* Apply scope prompt — only for earliest entry */}
                    {isFirst && (
                      <div className="space-y-1.5">
                        <p className="text-xs text-slate-400 font-mono">Apply this change to:</p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setApplyScope('this')}
                            className={`rounded border px-2.5 py-1 font-mono text-xs transition-colors ${applyScope === 'this' ? 'border-[#FFDC28] text-[#FFDC28] bg-[#FFDC28]/10' : 'border-slate-600 text-slate-400 hover:border-slate-400'}`}
                          >
                            This occurrence only
                          </button>
                          <button
                            onClick={() => setApplyScope('all')}
                            className={`rounded border px-2.5 py-1 font-mono text-xs transition-colors ${applyScope === 'all' ? 'border-[#FFDC28] text-[#FFDC28] bg-[#FFDC28]/10' : 'border-slate-600 text-slate-400 hover:border-slate-400'}`}
                          >
                            All future occurrences
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveEdit(u)}
                        disabled={saving || !editFor || (isFirst && !applyScope)}
                        className="rounded border border-green-500/40 px-2.5 py-1 font-mono text-xs text-green-400 hover:bg-green-400/10 disabled:opacity-40 transition-colors"
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingKey(null); setApplyScope(null) }}
                        className="rounded border border-slate-600 px-2.5 py-1 font-mono text-xs text-slate-400 hover:bg-slate-700 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-200 font-mono mt-1">{fmt(u.at)}</p>
                )}
              </div>

              {/* Action buttons */}
              {!isEditing && (
                <div className="flex items-center gap-1.5 shrink-0">
                  {isSkipping ? (
                    <>
                      <span className="font-mono text-xs text-orange-400 mr-1">Skip this?</span>
                      <button
                        onClick={() => skipOccurrence(u)}
                        disabled={saving}
                        className="rounded border border-orange-500/40 px-2 py-1 font-mono text-xs text-orange-400 hover:bg-orange-400/10 disabled:opacity-40 transition-colors"
                      >Yes</button>
                      <button
                        onClick={() => setSkippingKey(null)}
                        className="rounded border border-slate-600 px-2 py-1 font-mono text-xs text-slate-400 hover:bg-slate-700 transition-colors"
                      >No</button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => runNow(u)}
                        disabled={!!isRunningNow}
                        title="Run Now"
                        className="rounded border border-[#FFDC28]/40 px-2.5 py-1 font-mono text-xs text-[#FFDC28] hover:bg-[#FFDC28]/10 disabled:opacity-40 transition-colors"
                      >
                        {isRunningNow ? '…' : '▶'}
                      </button>
                      <button
                        onClick={() => startEdit(u, i)}
                        title="Edit"
                        className="rounded border border-slate-600 px-2.5 py-1 font-mono text-xs text-slate-400 hover:border-slate-400 hover:text-white transition-colors"
                      >✎</button>
                      <button
                        onClick={() => setSkippingKey(key)}
                        title="Skip this occurrence"
                        className="rounded border border-orange-500/40 px-2.5 py-1 font-mono text-xs text-orange-400 hover:bg-orange-400/10 transition-colors"
                      >✕</button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Update Options tab ────────────────────────────────────────────────────────

// ── Reusable accordion section for one type (plugins OR themes) ───────────────

function ItemAccordion({
  label, items, skips, setSkips, onDirty,
}: {
  label: string
  items: { name: string; title: string }[]
  skips: Set<string>
  setSkips: (s: Set<string>) => void
  onDirty: () => void
}) {
  type InnerTab = 'update' | 'skipped'
  const [open, setOpen]         = useState(true)
  const [innerTab, setInnerTab] = useState<InnerTab>('update')
  const [search, setSearch]     = useState('')

  const matches = (item: { name: string; title: string }) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return item.title.toLowerCase().includes(q) || item.name.toLowerCase().includes(q)
  }

  const forUpdate = items.filter(i => !skips.has(i.name) && matches(i))
  const skipped   = items.filter(i =>  skips.has(i.name) && matches(i))

  const toggle = (name: string) => {
    const next = new Set(skips)
    next.has(name) ? next.delete(name) : next.add(name)
    setSkips(next)
    onDirty()
  }

  const skipAllMatching = () => {
    const next = new Set(skips)
    forUpdate.forEach(i => next.add(i.name))
    setSkips(next); onDirty()
  }

  const restoreAllMatching = () => {
    const next = new Set(skips)
    skipped.forEach(i => next.delete(i.name))
    setSkips(next); onDirty()
  }

  const totalSkipped = items.filter(i => skips.has(i.name)).length

  return (
    <div className="rounded-xl border border-slate-700 overflow-hidden">
      {/* Accordion header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-5 py-3.5 bg-slate-800 hover:bg-slate-700/50 transition-colors text-left"
      >
        {open ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
        <span className="font-mono text-sm font-semibold text-white">{label}</span>
        <span className="text-xs text-slate-500 font-mono">{items.length} total</span>
        {totalSkipped > 0 && (
          <span className="ml-auto text-xs font-mono text-orange-400">{totalSkipped} skipped</span>
        )}
      </button>

      {open && (
        <div className="border-t border-slate-700 bg-slate-800/40 p-4 space-y-3">
          {/* Search */}
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}… (by name or slug)`}
              className="w-full rounded-lg border border-slate-600 bg-slate-700 pl-3 pr-8 py-1.5 font-mono text-xs text-white placeholder-slate-500 focus:border-[#FFDC28] focus:outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Sub-tabs */}
          <div className="flex gap-1 border-b border-slate-700">
            {([['update', `For Update (${forUpdate.length})`], ['skipped', `Skipped (${skipped.length})`]] as [InnerTab, string][]).map(([t, lbl]) => (
              <button key={t} onClick={() => setInnerTab(t)}
                className={`px-3 py-1.5 text-xs font-mono font-medium transition-colors ${
                  innerTab === t ? 'border-b-2 border-[#FFDC28] text-[#FFDC28]' : 'text-slate-400 hover:text-slate-200'
                }`}>
                {lbl}
              </button>
            ))}
            <div className="flex-1" />
            {innerTab === 'update' && forUpdate.length > 0 && search && (
              <button onClick={skipAllMatching}
                className="px-2.5 py-1 text-xs font-mono text-orange-400 hover:text-orange-300 border border-orange-500/30 rounded mb-1 transition-colors">
                Skip all ({forUpdate.length})
              </button>
            )}
            {innerTab === 'skipped' && skipped.length > 0 && search && (
              <button onClick={restoreAllMatching}
                className="px-2.5 py-1 text-xs font-mono text-green-400 hover:text-green-300 border border-green-500/30 rounded mb-1 transition-colors">
                Restore all ({skipped.length})
              </button>
            )}
          </div>

          {/* Items */}
          <div className="max-h-64 overflow-y-auto space-y-0.5">
            {innerTab === 'update' && (
              forUpdate.length === 0
                ? <p className="text-xs text-slate-600 font-mono text-center py-6">
                    {search ? `No ${label.toLowerCase()} matching "${search}" in For Update` : `All ${label.toLowerCase()} are in the Skipped list`}
                  </p>
                : forUpdate.map(i => (
                    <div key={i.name} onClick={() => toggle(i.name)}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-700/50 cursor-pointer transition-colors">
                      <div className="w-4 h-4 rounded border border-[#FFDC28]/60 bg-[#FFDC28]/10 flex items-center justify-center shrink-0">
                        <Check className="w-2.5 h-2.5 text-[#FFDC28]" />
                      </div>
                      <span className="text-xs font-mono text-slate-200 flex-1">{i.title}</span>
                      <span className="text-xs text-slate-600 font-mono">{i.name}</span>
                    </div>
                  ))
            )}
            {innerTab === 'skipped' && (
              skipped.length === 0
                ? <p className="text-xs text-slate-600 font-mono text-center py-6">
                    {search ? `No ${label.toLowerCase()} matching "${search}" in Skipped` : `No ${label.toLowerCase()} skipped — all will be updated`}
                  </p>
                : skipped.map(i => (
                    <div key={i.name} onClick={() => toggle(i.name)}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-700/50 cursor-pointer transition-colors">
                      <div className="w-4 h-4 rounded border border-orange-500/60 bg-orange-900/20 flex items-center justify-center shrink-0">
                        <X className="w-2.5 h-2.5 text-orange-400" />
                      </div>
                      <span className="text-xs font-mono text-slate-500 line-through flex-1">{i.title}</span>
                      <span className="text-xs text-slate-600 font-mono">{i.name}</span>
                    </div>
                  ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Per-site update policy opens OVER whatever you were doing. It used to be a tab,
// which meant leaving the Stage form (and your typed site ID) to go and look.
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/70 p-4 sm:p-8"
      role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="w-full max-w-3xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-4 border-b border-slate-700 px-5 py-3">
          <h2 className="font-mono text-sm text-white">{title}</h2>
          <button onClick={onClose} autoFocus
            className="rounded border border-slate-600 px-2 py-1 font-mono text-xs text-slate-400 hover:border-slate-400 hover:text-white transition-colors">
            Close
          </button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  )
}

function UpdateOptionsTab({ site }: { site: string }) {
  const [loading, setLoading]         = useState(false)
  const [saving, setSaving]           = useState(false)
  const [saved, setSaved]             = useState(false)
  const [plugins, setPlugins]         = useState<{ name: string; title: string }[]>([])
  const [themes, setThemes]           = useState<{ name: string; title: string }[]>([])
  const [pluginSkips, setPluginSkips] = useState<Set<string>>(new Set())
  const [themeSkips, setThemeSkips]   = useState<Set<string>>(new Set())
  const [loaded, setLoaded]           = useState(false)
  const [savedSite, setSavedSite]     = useState('')

  const load = useCallback(async () => {
    if (!site.trim()) return
    setLoading(true)
    setSaved(false)
    try {
      const [pluginsRes, prefsRes] = await Promise.all([
        fetch(`/api/site-plugins?site=${encodeURIComponent(site.trim())}`),
        fetch(`/api/prefs/${encodeURIComponent(site.trim())}`),
      ])
      if (pluginsRes.ok) {
        const data = await pluginsRes.json()
        setPlugins(data.plugins ?? [])
        setThemes(data.themes ?? [])
      }
      if (prefsRes.ok) {
        const prefs = await prefsRes.json()
        setPluginSkips(new Set(prefs.plugin_skips ?? []))
        setThemeSkips(new Set(prefs.theme_skips ?? []))
      }
      setSavedSite(site.trim())
      setLoaded(true)
    } finally {
      setLoading(false)
    }
  }, [site])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    setSaving(true)
    try {
      await fetch(`/api/prefs/${encodeURIComponent(savedSite)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin_skips: [...pluginSkips], theme_skips: [...themeSkips] }),
      })
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          icon={<Package className="w-5 h-5" />}
          title="Update Options"
          description="Configure which plugins and themes to skip. Applies to all staging runs — manual, scheduled, and automated."
        />
        <div className="px-6 py-5 space-y-4">

          {/* Read-only site ID */}
          <div className="space-y-1">
            <label className="text-xs text-slate-500 font-mono">Site ID (set in Stage tab)</label>
            <input type="text" value={site || '—'} readOnly
              className="w-full rounded-lg border border-slate-700 bg-slate-700/40 px-3 py-2 font-mono text-sm text-slate-500 cursor-not-allowed" />
          </div>

          {!site.trim() && (
            <p className="text-sm text-slate-500 font-mono text-center py-4">Enter a site ID in the Stage tab first</p>
          )}
          {loading && (
            <p className="text-sm text-slate-500 font-mono text-center py-4">Loading plugin list from live…</p>
          )}

          {loaded && !loading && (
            <>
              {/* Plugins accordion */}
              <ItemAccordion
                label="Plugins"
                items={plugins}
                skips={pluginSkips}
                setSkips={setPluginSkips}
                onDirty={() => setSaved(false)}
              />

              {/* Themes accordion */}
              {themes.length > 0 && (
                <ItemAccordion
                  label="Themes"
                  items={themes}
                  skips={themeSkips}
                  setSkips={setThemeSkips}
                  onDirty={() => setSaved(false)}
                />
              )}

              {/* Save */}
              <div className="flex items-center gap-3 pt-2 border-t border-slate-700">
                <button onClick={save} disabled={saving}
                  className="rounded-lg bg-[#FFDC28] hover:bg-[#E6C625] px-4 py-2 text-sm font-semibold text-slate-900 transition-colors disabled:opacity-40">
                  {saving ? 'Saving…' : 'Save Preferences'}
                </button>
                <button onClick={load} disabled={loading}
                  className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors disabled:opacity-40">
                  Refresh
                </button>
                {saved && <span className="text-xs text-green-400 font-mono">✦ Saved</span>}
              </div>
            </>
          )}
        </div>
      </Card>
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
  const [securityFastTrack, setSecurityFastTrack] = useState(false)
  const [testMode, setTestMode]               = useState(false)
  const [showOptions, setShowOptions]         = useState(false)
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
      const body: Record<string, unknown> = {
        site: site.trim(),
        skipUpstream,
        // Fast-track implies upstream-only; the route enforces it too.
        skipPluginsThemes: securityFastTrack ? true : skipPluginsThemes,
        securityFastTrack,
        deployDays: stageDeployDays,
        deployDestination: stageDestination,
      }
      // Test mode: server appends -t to today's date → mu-YYMMDD-t (never deletes production env)
      if (testMode) body.testMode = true
      await fetch('/api/staging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setTab('history')
    } finally {
      setSubmitting(false)
    }
  }, [site, skipUpstream, skipPluginsThemes, securityFastTrack, stageDeployDays, stageDestination, testMode])

  const liveIds  = new Set(liveJobs.map((j) => j.id))
  const pastJobs = history.filter((h) => !liveIds.has(h.id))

  const TABS: { key: Tab; label: string }[] = [
    { key: 'sites',    label: 'Sites' },
    { key: 'stage',    label: 'Stage' },
    { key: 'schedule', label: 'Schedule' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'history',  label: 'History' },
  ]

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      <div className="container mx-auto px-4 py-8 max-w-3xl space-y-6">

        {/* Shared MU header — brand block + context-aware app switcher */}
        <Header current="staging" />

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
                <label className="text-xs text-slate-400 font-mono">Site ID <span className="text-slate-600 normal-case">(Pantheon machine name or UUID — not display name)</span></label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={site}
                    onChange={(e) => setSite(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !submitting && startJob()}
                    placeholder="my-site-name"
                    disabled={submitting}
                    className="flex-1 rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-[#FFDC28] focus:outline-none disabled:opacity-50"
                  />
                  <button
                    onClick={() => site.trim() && setShowOptions(true)}
                    disabled={!site.trim() || submitting}
                    title="Plugins and themes to skip on this site"
                    className="rounded-lg border border-slate-600 px-3 py-2 text-xs font-mono text-slate-400 hover:border-[#FFDC28] hover:text-[#FFDC28] transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                  >
                    More Options
                  </button>
                </div>
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
                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={securityFastTrack}
                    onChange={(e) => setSecurityFastTrack(e.target.checked)}
                    className="rounded border-slate-600 bg-slate-700 accent-[#FFDC28]"
                  />
                  Security / core update only
                </label>
                {securityFastTrack && (
                  <p className="text-[0.7rem] text-slate-500 font-mono pl-6">
                    Upstream only. Deploys on the 24-hour security window instead of the usual wait,
                    and does not move the site&apos;s staging cadence.
                  </p>
                )}
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

              {/* Test mode toggle */}
              <div className="flex items-center justify-between rounded-lg border border-slate-700 px-4 py-3">
                <div>
                  <p className="text-xs font-semibold text-slate-300 font-mono">Test Mode</p>
                  <p className="text-xs text-slate-500 font-mono mt-0.5">
                    {testMode
                      ? `Uses mu-${getPacificYYMMDD()}-t — production mu-${getPacificYYMMDD()} stays untouched`
                      : 'Off — uses standard mu-YYMMDD (client-facing)'}
                  </p>
                </div>
                <button
                  onClick={() => setTestMode(t => !t)}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 transition-colors ${
                    testMode ? 'border-[#FFDC28] bg-[#FFDC28]/20' : 'border-slate-600 bg-slate-700'
                  }`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${
                    testMode ? 'translate-x-5' : 'translate-x-0.5'
                  }`} />
                </button>
              </div>

              <button
                onClick={startJob}
                disabled={submitting || !site.trim()}
                className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  testMode
                    ? 'bg-slate-600 hover:bg-slate-500 text-white border border-slate-500'
                    : 'bg-[#FFDC28] hover:bg-[#E6C625] text-slate-900'
                }`}
              >
                {submitting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Starting…
                  </span>
                ) : testMode ? `Run Test Staging (mu-${getPacificYYMMDD()}-t)` : 'Run Staging Updates'}
              </button>

              {showOptions && site.trim() && (
                <Modal title={site.trim()} onClose={() => setShowOptions(false)}>
                  <UpdateOptionsTab site={site.trim()} />
                </Modal>
              )}
            </div>
          </Card>
        )}

        {/* ── Update Options tab ── */}
        {tab === 'sites' && <SitesTab />}


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

              {(() => {
                // A VRT link stays visible only on the newest run per site and for
                // 14 days — older/superseded reports are purged by the cleanup sweep.
                const TTL = 14 * 24 * 60 * 60 * 1000
                const now = Date.now()
                const latestVrt = new Map<string, { id: string; ts: number }>()
                for (const it of pastJobs) {
                  if (!it.vrt_report_url) continue
                  const ts = new Date(it.started_at).getTime()
                  const cur = latestVrt.get(it.site)
                  if (!cur || ts > cur.ts) latestVrt.set(it.site, { id: it.id, ts })
                }
                return pastJobs.map((item) => {
                  const isLatest = latestVrt.get(item.site)?.id === item.id
                  const ref = item.completed_at ?? item.started_at
                  const fresh = now - new Date(ref).getTime() <= TTL
                  const vrtVisible = Boolean(item.vrt_report_url) && isLatest && fresh
                  return <HistoryRow key={item.id} item={item} vrtVisible={vrtVisible} />
                })
              })()}
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
