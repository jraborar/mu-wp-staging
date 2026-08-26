import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { UpdateSummary, UpdatedItem } from '@/lib/wordpress'

// A composer-audit advisory, as surfaced on a Drupal run. `pinned` marks packages
// exact-pinned in composer.json that we deliberately did NOT update even though an
// advisory exists — reported for manual review, never force-fixed.
export interface SecurityAdvisory {
  package: string
  id: string          // CVE or advisory id (SA-CONTRIB-…)
  title: string
  link?: string
  pinned: boolean
}

export type LogType = 'info' | 'status' | 'warn' | 'success' | 'error' | 'delete' | 'deleted' | 'create'

export interface LogEntry {
  type: 'log'
  logType: LogType
  message: string
  ts: number
}

export type JobStatus = 'running' | 'completed' | 'failed' | 'paused' | 'cancelled' | 'awaiting-approval'

export interface PendingApproval {
  resolve: (approved: boolean) => void
  approvalType: string
  message: string
  approveLabel: string
  rejectLabel: string
}

export interface UpstreamUpdateEntry {
  message: string
  hash?: string
}

export interface StagingJob {
  id: string
  site: string
  site_name?: string
  multidev: string
  upstream?: string
  upstreamUpdated: boolean
  upstreamConflict: boolean
  // Core files the upstream merge could not reconcile — shareable with the
  // customer, since we never force-overwrite their customizations.
  upstreamConflictFiles: string[]
  upstreamUpdates: UpstreamUpdateEntry[]   // commit details from upstream:updates:list
  upstreamOldVersion?: string              // wp core version before apply
  upstreamNewVersion?: string              // wp core version after apply
  plugins: UpdateSummary
  themes: UpdateSummary
  // Drupal (Composer-managed) runs only. Modules/themes reuse plugins/themes above;
  // core reuses the upstream* fields. These two have no WordPress equivalent.
  composerDeps: UpdatedItem[]
  securityAdvisories: SecurityAdvisory[]
  status: JobStatus
  logs: LogEntry[]
  startedAt: number
  lastActivity: number
  emitter: EventEmitter
  // progress tracking
  stepName: string
  stepIndex: number
  stepTotal: number
  // options
  skipUpstream: boolean
  skipPluginsThemes: boolean
  // flow control
  cancelRequested: boolean
  pendingApproval: PendingApproval | null
  // metadata
  scheduleId?: string
  multidevCreated: boolean
  deployDays?: number
  deployDestination?: string
  // Security/upstream fast-track: deploy on the security window (now + security_deploy_hours)
  // rather than the normal deploy_days schedule. Set by the auto upstream scan.
  securityFastTrack?: boolean
  // VRT (Model B) — set when the site has VRT enabled; baseline run id + report link
  vrtRunId?: string
  vrtReportUrl?: string
  vrtFlaggedCount?: number | null   // flagged paths after compare (null = ran but no count)
  vrtStatus?: 'completed' | 'failed' | 'incomplete'
}

export interface CreateJobOptions {
  skipUpstream?: boolean
  skipPluginsThemes?: boolean
  scheduleId?: string
  deployDays?: number
  deployDestination?: string
  securityFastTrack?: boolean
}

const MAX_JOBS = 20
const store = new Map<string, StagingJob>()

export function createJob(site: string, multidev: string, opts: CreateJobOptions = {}): StagingJob {
  if (store.size >= MAX_JOBS) {
    const oldest = [...store.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0]
    if (oldest) store.delete(oldest[0])
  }

  const job: StagingJob = {
    id: randomUUID(),
    site,
    multidev,
    upstreamUpdated: false,
    upstreamConflict: false,
    upstreamConflictFiles: [],
    upstreamUpdates: [],
    plugins: { updated: [], skipped: [] },
    themes:  { updated: [], skipped: [] },
    composerDeps: [],
    securityAdvisories: [],
    status: 'running',
    logs: [],
    startedAt: Date.now(),
    lastActivity: Date.now(),
    emitter: new EventEmitter(),
    stepName: 'Starting',
    stepIndex: 0,
    stepTotal: 16,
    skipUpstream: opts.skipUpstream ?? false,
    skipPluginsThemes: opts.skipPluginsThemes ?? false,
    cancelRequested: false,
    pendingApproval: null,
    scheduleId: opts.scheduleId,
    multidevCreated: false,
    deployDays: opts.deployDays,
    deployDestination: opts.deployDestination,
    securityFastTrack: opts.securityFastTrack ?? false,
  }
  job.emitter.setMaxListeners(50)
  store.set(job.id, job)
  return job
}

export function getJob(id: string): StagingJob | undefined {
  return store.get(id)
}

export function getAllJobs(): StagingJob[] {
  return [...store.values()]
}

export function setStep(job: StagingJob, name: string, index: number, total = job.stepTotal): void {
  job.stepName = name
  job.stepIndex = index
  job.stepTotal = total
  job.lastActivity = Date.now()
  job.emitter.emit('event', { type: 'step', name, index, total })
}

export function appendLog(job: StagingJob, logType: LogType, message: string): void {
  const entry: LogEntry = { type: 'log', logType, message, ts: Date.now() }
  job.logs.push(entry)
  job.lastActivity = Date.now()
  job.emitter.emit('event', entry)
}

export function finishJob(job: StagingJob, status: JobStatus): void {
  job.status = status
  job.lastActivity = Date.now()
  job.emitter.emit('event', { type: 'complete', status })
  job.emitter.emit('done')
}

export function waitForApproval(
  job: StagingJob,
  payload: Omit<PendingApproval, 'resolve'>,
): Promise<boolean> {
  return new Promise((resolve) => {
    job.pendingApproval = { resolve, ...payload }
    job.status = 'awaiting-approval'
    job.emitter.emit('event', { type: 'awaiting-approval', ...payload })
  })
}
