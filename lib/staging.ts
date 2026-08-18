import { type StagingJob, appendLog, finishJob, setStep, waitForApproval } from '@/lib/jobStore'
import { run, runStream, shellEscape, cleanJson } from '@/lib/terminus'
import { scheduleDeployment } from '@/lib/schedule'
import {
  buildUpdateSummary,
  buildCommitMessage,
  parseWpJson,
  type UpdateSummary,
} from '@/lib/wordpress'
import { createStagingRecord, finalizeStagingRecord, getSiteUpdatePrefs } from '@/lib/supabase'
import {
  startStagingThread,
  postThreadStep,
  postThreadBlocks,
  notifyInThread,
  buildApprovalBlocks,
  buildCompleteBlocks,
  buildFailedBlocks,
  buildPausedBlocks,
  buildCancelledBlocks,
  buildLongRunningBlocks,
  buildMultidevReadyBlocks,
} from '@/lib/slack'

const SUPPORTED_UPSTREAMS = ['wordpress', 'wordpress-multisite']

class CancelledError extends Error {
  constructor() { super('Staging cancelled by user') }
}

class PauseError extends Error {
  constructor() { super('Staging paused by user') }
}

function env(job: StagingJob): string {
  return `${job.site}.${job.multidev}`
}

function wp(job: StagingJob, args: string): string {
  return `terminus wp ${env(job)} -- ${args} 2>&1`
}

function checkCancelled(job: StagingJob): void {
  if (job.cancelRequested) throw new CancelledError()
}

// Find a multidev whose name exactly matches prefix-YYMMDD
function findByPrefix(list: string, prefix: string): string | null {
  const re = new RegExp(`^${prefix}-\\d{6}$`)
  for (const line of list.split('\n')) {
    const trimmed = line.trim()
    if (re.test(trimmed)) return trimmed
  }
  return null
}

async function revertUpstreamConflict(job: StagingJob, preApplyHash: string): Promise<boolean> {
  const log = (m: string) => appendLog(job, 'warn', m)
  log('Attempting to revert upstream conflict via git reset...')

  const gitInfoResult = await run(`terminus connection:info ${env(job)} --field=git_url 2>/dev/null`)
  const gitUrl = gitInfoResult.stdout.trim()
  if (!gitUrl) {
    appendLog(job, 'error', 'Could not retrieve git URL — set PANTHEON_SSH_KEY to enable auto-revert')
    return false
  }

  const tmpDir = `/tmp/mu_staging_revert_${job.id}`
  try {
    await run(`rm -rf "${tmpDir}"`)
    const clone = await run(`git clone "${gitUrl}" "${tmpDir}" 2>&1`)
    if (clone.code !== 0) {
      log('Git clone failed — SSH key may not be configured. Skipping revert.')
      return false
    }

    await run(`git -C "${tmpDir}" merge --abort 2>/dev/null || true`)
    const reset = await run(`git -C "${tmpDir}" reset --hard "${preApplyHash}" 2>&1`)
    if (reset.code !== 0) {
      log('Git reset failed — manual revert required')
      return false
    }

    const push = await run(`git -C "${tmpDir}" push origin master --force 2>&1`)
    if (push.code !== 0) {
      log('Git force-push failed — manual revert required')
      return false
    }

    log(`Reverted to ${preApplyHash.slice(0, 8)} successfully`)
    return true
  } finally {
    await run(`rm -rf "${tmpDir}"`)
  }
}

async function runPluginOrThemeUpdates(
  job: StagingJob,
  type: 'plugin' | 'theme',
  siteSkips: string[] = [],
): Promise<UpdateSummary> {
  const label = type === 'plugin' ? 'Plugin' : 'Theme'
  const log = (logType: Parameters<typeof appendLog>[1], m: string) => appendLog(job, logType, m)

  log('status', `Checking for ${label.toLowerCase()} updates...`)
  await run(wp(job, `${type} check-update 2>&1`))

  let listResult = await run(wp(job, `${type} list --update=available --format=json --context=admin`))
  let adminContext = true
  if (listResult.code !== 0 || listResult.stdout.toLowerCase().includes('fatal error')) {
    log('warn', `${label} list failed with admin context — retrying without it (pro plugins may not be detected)`)
    listResult = await run(wp(job, `${type} list --update=available --format=json`))
    adminContext = false
    if (listResult.code !== 0) {
      log('error', `${label} list failed — skipping ${label.toLowerCase()} updates for this site`)
      return { updated: [], skipped: [] }
    }
  }

  const cleaned = cleanJson(listResult.stdout)
  log('info', `${label} list cleaned: ${cleaned.slice(0, 300) || '(empty)'}`)

  const available = parseWpJson<{ name: string; title?: string; version?: string }>(cleaned)

  // Identify which available items are in the site-level skip list
  const sitePrefSkipped = available
    .filter(p => siteSkips.includes(p.name))
    .map(p => ({ name: p.name, title: p.title ?? p.name, reason: 'Skipped per site update preferences' }))

  if (sitePrefSkipped.length > 0) {
    log('info', `${label} site preferences: excluding ${sitePrefSkipped.map(p => p.title).join(', ')}`)
  }

  if (available.length === 0 || available.every(p => siteSkips.includes(p.name))) {
    log('info', `No ${label.toLowerCase()} updates to apply`)
    return { updated: [], skipped: sitePrefSkipped }
  }

  log('info', `Found ${available.length} ${label.toLowerCase()}(s) with available updates`)
  log('status', `Updating ${label.toLowerCase()}s...`)

  // Pass site-skip list directly to WP-CLI via --exclude so it never touches them.
  // Equivalent to: wp plugin update --all --exclude=slug1,slug2 --format=json
  const excludeFlag = siteSkips.length > 0 ? ` --exclude=${siteSkips.join(',')}` : ''
  interface WpUpdateEntry { name: string; old_version: string; new_version: string; status: string }
  const updateCmd = adminContext
    ? `${type} update --all --context=admin --format=json${excludeFlag}`
    : `${type} update --all --format=json${excludeFlag}`
  let jsonResult = await run(wp(job, updateCmd))

  // Guardrail: if update with --context=admin fails (e.g. PHP 8.1 sites), retry without it.
  // --exclude is preserved in both attempts so site preferences always apply regardless of context.
  if (adminContext && (jsonResult.code !== 0 || jsonResult.stdout.toLowerCase().includes('no plugins updated') || jsonResult.stdout.toLowerCase().includes('no themes updated'))) {
    const retryCmd = `${type} update --all --format=json${excludeFlag}`
    log('warn', `${label} update failed with admin context — retrying without it${excludeFlag ? ` (--exclude preserved: ${siteSkips.join(',')})` : ''}`)
    jsonResult = await run(wp(job, retryCmd))
  }

  log('info', `${label} update raw: ${jsonResult.stdout.slice(0, 400).replace(/\n/g, ' ') || '(empty)'}`)

  // WP-CLI exits 1 and says "No X updated" when ANY plugin fails (e.g. pro plugins need license),
  // even if other plugins DID update. Cross-check by re-listing what still needs updates after the
  // command ran — anything that disappeared from the available list was actually updated.
  const [afterAvailResult, afterAllResult] = await Promise.all([
    run(wp(job, `${type} list --update=available --format=json`)),
    run(wp(job, `${type} list --fields=name,version --format=json`)),
  ])
  const afterAvailable = new Set(
    parseWpJson<{ name: string }>(cleanJson(afterAvailResult.stdout)).map(p => p.name)
  )
  // Current installed versions after the update — used to get the real new version
  const afterVersionMap = new Map(
    parseWpJson<{ name: string; version: string }>(cleanJson(afterAllResult.stdout)).map(p => [p.name, p.version])
  )

  const toUpdate = available.filter(p => !siteSkips.includes(p.name))

  // Key guardrail: a plugin is only truly "updated" if it BOTH left the available list AND
  // its installed version actually changed. When WP-CLI refreshes the update transient during
  // a failed run, plugins can disappear from the available list without being installed —
  // same version before/after = silent fail, not an update.
  const actuallyUpdated = toUpdate
    .filter(p => {
      if (afterAvailable.has(p.name)) return false          // still needs update
      const newVer = afterVersionMap.get(p.name)
      return !!newVer && newVer !== p.version               // version genuinely changed
    })
    .map(p => ({
      name:  p.name,
      title: p.title ?? p.name,
      from:  p.version ?? '?',
      to:    afterVersionMap.get(p.name) ?? '?',
    }))

  // Plugins still in available list = failed to update
  // Plugins that left available list but version unchanged = transient cleared, NOT installed
  const genuinelySkipped = toUpdate
    .filter(p => {
      if (afterAvailable.has(p.name)) return true           // still needs update
      const newVer = afterVersionMap.get(p.name)
      return !newVer || newVer === p.version                // version unchanged = false positive
    })
    .map(p => {
      const newVer = afterVersionMap.get(p.name)
      const reason = afterAvailable.has(p.name)
        ? 'Could not be updated automatically'
        : (!newVer || newVer === p.version)
          ? 'Update not applied — may require license or manual install'
          : 'Could not be updated automatically'
      return { name: p.name, title: p.title ?? p.name, reason }
    })

  // Refine skip reasons using the JSON output error entries
  const jsonResults = parseWpJson<WpUpdateEntry>(cleanJson(jsonResult.stdout))
  const versionMap = new Map(jsonResults.map(r => [r.name, r]))
  for (const s of genuinelySkipped) {
    const r = versionMap.get(s.name)
    if (r?.status === 'Error') s.reason = 'Update failed — manual update may be required'
  }

  const summary = {
    updated: actuallyUpdated,
    skipped: [...genuinelySkipped, ...sitePrefSkipped],
  }

  for (const u of summary.updated) log('success', `${label}: ${u.title} ${u.from} → ${u.to}`)
  for (const s of summary.skipped) log('warn', `${label} skipped: ${s.title} — ${s.reason}`)

  return summary
}

const BASE_STEPS = [
  'Authenticating',
  'Preflight: connection mode',
  'Preflight: uncommitted changes',
  'Checking multidev slots',
  'Creating multidev',
  'Checking site info',
  'Setting Git mode',
  'Checking upstream',
  'Applying upstream',
  'Setting SFTP mode',
  'Updating plugins',
  'Committing plugins',
  'Updating themes',
  'Committing themes',
  'Flushing cache',
  'Clearing edge cache',
]

function buildStepList(job: StagingJob): string[] {
  return BASE_STEPS.filter(s => {
    if (job.skipUpstream && (s === 'Checking upstream' || s === 'Applying upstream')) return false
    if (job.skipPluginsThemes && ['Updating plugins','Committing plugins','Updating themes','Committing themes'].includes(s)) return false
    return true
  })
}

export async function executeJob(job: StagingJob): Promise<void> {
  const log   = (logType: Parameters<typeof appendLog>[1], m: string) => appendLog(job, logType, m)
  const STEPS = buildStepList(job)
  const step  = (name: string) => setStep(job, name, STEPS.indexOf(name) + 1, STEPS.length)

  await createStagingRecord(job.id, {
    site: job.site,
    multidev: job.multidev,
    status: 'running',
    started_at: new Date(job.startedAt).toISOString(),
  })

  let slackThreadTs: string | null = null
  let siteLabel = job.site
  const postStep = (msg: string) => { void postThreadStep(slackThreadTs, msg) }

  const startedAt = Date.now()
  let longRunTimer: ReturnType<typeof setTimeout> | null = null
  let longRunInterval: ReturnType<typeof setInterval> | null = null
  const stopAlerts = () => {
    if (longRunTimer)    clearTimeout(longRunTimer)
    if (longRunInterval) clearInterval(longRunInterval)
  }
  longRunTimer = setTimeout(() => {
    const blocks = buildLongRunningBlocks(siteLabel, job.multidev, 30, job.stepName, job.site !== siteLabel ? job.site : undefined)
    void (slackThreadTs
      ? postThreadBlocks(slackThreadTs, blocks, `Staging running 30+ min on ${siteLabel}`)
      : Promise.resolve())
    longRunInterval = setInterval(() => {
      if (job.status === 'running') {
        const elapsed = Math.round((Date.now() - startedAt) / 60000)
        log('warn', `⏱ Still running — ${elapsed} minutes elapsed`)
      }
    }, 10 * 60 * 1000)
  }, 30 * 60 * 1000)

  // Helper: prompt via UI (and Slack if configured), wait for decision, honour cancel
  const prompt = async (
    approvalType: string,
    message: string,
    approveLabel: string,
    rejectLabel: string,
  ): Promise<boolean> => {
    void postThreadBlocks(
      slackThreadTs,
      buildApprovalBlocks(job.id, message, approveLabel, rejectLabel),
      `Approval needed on ${siteLabel}: ${message}`,
    )
    const approved = await waitForApproval(job, { approvalType, message, approveLabel, rejectLabel })
    job.status = 'running'
    checkCancelled(job)
    return approved
  }

  const pauseHere = async (reason: string, pausedAt: string) => {
    job.status = 'paused'
    log('warn', `Staging paused — ${reason}`)
    finishJob(job, 'paused')
    void postThreadBlocks(
      slackThreadTs,
      buildPausedBlocks(siteLabel, job.multidev, pausedAt, job.site !== siteLabel ? job.site : undefined),
      `Staging paused on ${siteLabel} — ${reason}`,
    )
    await finalizeStagingRecord(job.id, {
      site_name: job.site_name,
      upstream: job.upstream,
      upstream_updated: job.upstreamUpdated,
      plugins_updated: job.plugins.updated,
      plugins_skipped: job.plugins.skipped,
      themes_updated: job.themes.updated,
      themes_skipped: job.themes.skipped,
      status: 'paused',
      completed_at: new Date().toISOString(),
      logs: job.logs,
    })
    throw new PauseError()
  }

  try {
    // ── 1. Auth ──────────────────────────────────────────────────────────────
    step('Authenticating')
    log('status', 'Verifying Terminus authentication...')
    const token = process.env.TERMINUS_TOKEN
    if (token) await run(`terminus auth:login --machine-token="${token}" 2>&1`)
    const whoami = await run('terminus auth:whoami 2>&1')
    const identity = whoami.stdout
      .split('\n')
      .filter(l => !/^\s*(Deprecated|Warning|Notice|PHP\s+(Deprecated|Warning|Notice)):/i.test(l))
      .find(l => l.includes('@'))
      ?.trim()
    if (!identity) throw new Error('Terminus not authenticated — check TERMINUS_TOKEN')
    log('info', `Authenticated as: ${identity}`)

    if (!process.env.PANTHEON_SSH_KEY) {
      throw new Error('PANTHEON_SSH_KEY is not set — required for WP-CLI commands. Add it in Railway environment variables.')
    }

    slackThreadTs = await startStagingThread(job.site, job.multidev)
    postStep(`✓ Authenticated as ${identity}`)

    // ── 2. Preflight: SFTP check on dev ─────────────────────────────────────
    checkCancelled(job)
    step('Preflight: connection mode')
    log('status', 'Checking dev connection mode...')
    const connModeResult = await run(`terminus env:info ${job.site}.dev --field=connection_mode 2>/dev/null`)
    const connMode = connModeResult.stdout.split('\n').map(l => l.trim()).find(l => /^(git|sftp)$/i.test(l))?.toLowerCase()
    if (!connMode) {
      log('warn', 'Could not determine dev connection mode — skipping check')
    } else if (connMode === 'sftp') {
      log('warn', 'Dev is in SFTP mode — prompting for decision')
      const shouldSwitch = await prompt(
        'alignment',
        `Dev is in SFTP mode on \`${job.site}\`. Switch to git mode (uncommitted SFTP changes will be lost) or pause to commit first?`,
        'Switch to git',
        'Pause',
      )
      if (shouldSwitch) {
        log('status', 'Switching dev to git mode...')
        const r = await run(`terminus connection:set ${job.site}.dev git 2>&1`)
        if (r.code !== 0) throw new Error(`Failed to switch dev to git mode: ${r.stdout.trim()}`)
        log('success', 'Dev switched to git mode')
        postStep('✓ Dev switched to git mode')
      } else {
        await pauseHere('dev is in SFTP mode — switch to git and commit before resuming', 'preflight')
      }
    }
    log('info', `Dev connection mode: ${connMode ?? 'unknown'} ✓`)
    postStep(`✓ Dev is in ${connMode ?? 'git'} mode`)

    // ── 3. Preflight: uncommitted changes ────────────────────────────────────
    checkCancelled(job)
    step('Preflight: uncommitted changes')
    log('status', 'Checking for uncommitted changes...')
    for (const envName of ['dev', 'test']) {
      log('info', `  Checking ${envName}...`)
      const diff = await run(`terminus env:diffstat ${job.site}.${envName} --format=json 2>&1`)
      let hasChanges = false
      try {
        const cleaned = diff.stdout.split('\n')
          .filter(l => !/^\s*(Deprecated|Warning|Notice|PHP):/i.test(l))
          .join('\n').trim()
        const data = JSON.parse(cleaned)
        hasChanges = Array.isArray(data) && data.length > 0
      } catch {
        hasChanges = diff.stdout.includes('files changed') || diff.stdout.includes('ahead')
      }
      if (hasChanges) {
        log('warn', `Uncommitted changes detected in ${envName} — prompting`)
        const shouldPause = await prompt(
          'alignment',
          `\`${envName}\` has uncommitted changes on \`${job.site}\`. Pause to commit and resolve, or stop the staging?`,
          'Pause',
          'Stop',
        )
        if (shouldPause) {
          await pauseHere(`${envName} has uncommitted changes — commit and resume when ready`, `preflight (${envName})`)
        } else {
          throw new CancelledError()
        }
      }
    }
    log('info', 'No uncommitted changes detected ✓')
    postStep('✓ No uncommitted changes in dev / test')

    // ── 4. Multidev slot management ──────────────────────────────────────────
    checkCancelled(job)
    step('Checking multidev slots')
    log('status', 'Checking multidev availability...')

    const siteInfoRaw = await run(`terminus site:info ${job.site} --format=json 2>&1`)
    let maxMultidevs = 10
    try {
      const siteData = JSON.parse(cleanJson(siteInfoRaw.stdout))
      maxMultidevs = siteData?.max_num_cdes ?? siteData?.max_multidevs ?? 10
      siteLabel = siteData?.label ?? siteData?.name ?? job.site
      if (siteLabel !== job.site) job.site_name = siteLabel
    } catch {}

    const multidevListResult = await run(`terminus multidev:list ${job.site} --field=id 2>&1`)
    const multidevList = multidevListResult.stdout
    const currentMultidevs = multidevList.split('\n').map(l => l.trim()).filter(l => /^[a-z0-9][a-z0-9-]{0,10}$/.test(l))
    const currentCount = currentMultidevs.length

    // Always delete the job's OWN target multidev if it already exists (ensures clean slate,
    // especially for test mode re-runs). Only skip cleanup of OTHER mu-YYMMDD envs when using
    // a non-standard name — that protects manually-staged production envs from accidental deletion.
    const isStandardName = /^mu-\d{6}$/.test(job.multidev)
    const targetAlreadyExists = currentMultidevs.includes(job.multidev)
    const existingMu = targetAlreadyExists
      ? job.multidev
      : isStandardName ? findByPrefix(multidevList, 'mu') : null
    const countAfterDelete = existingMu ? currentCount - 1 : currentCount

    if (countAfterDelete >= maxMultidevs) {
      log('warn', `Multidev slots full (${currentCount}/${maxMultidevs}) — prompting`)
      const shouldPause = await prompt(
        'alignment',
        `All ${maxMultidevs} multidev slots are in use on \`${job.site}\`. Delete one manually and resume, or cancel staging?`,
        'Pause',
        'Cancel',
      )
      if (shouldPause) {
        await pauseHere('multidev slots full — free a slot and resume', 'multidev slots')
      } else {
        throw new CancelledError()
      }
    }

    // ── 5. Delete old mu-YYMMDD and create new one ───────────────────────────
    step('Creating multidev')
    if (existingMu) {
      log('delete', `Removing existing multidev ${existingMu}...`)
      postStep(`🗑 Removing old multidev \`${existingMu}\`...`)
      await run(`terminus multidev:delete --yes ${job.site}.${existingMu} 2>&1`)
      log('deleted', `Removed ${existingMu}`)
      postStep(`✓ Removed \`${existingMu}\``)
    }

    log('create', `Creating multidev ${job.multidev} from live...`)
    postStep(`◈ Creating multidev \`${job.multidev}\` from live... _(this step typically takes a few minutes)_`)
    const createResult = await runStream(
      // Build from live so updates are tested against actual production state
      `terminus multidev:create ${job.site}.live ${job.multidev} 2>&1`,
      (line) => log('info', line),
    )
    if (createResult.code !== 0) {
      // terminus-3 can exit non-zero when Pantheon queues async tasks to stderr
      // (e.g. "Successfully queued endpoint_wp_search_replace task").
      // Verify existence before treating as a real failure.
      const verify = await run(`terminus multidev:list ${job.site} --fields=Name --format=list 2>&1`)
      const exists  = verify.stdout.split('\n').map(l => l.trim()).includes(job.multidev)
      if (!exists) throw new Error(`Multidev creation failed`)
      log('warn', `terminus exited non-zero but ${job.multidev} exists — confirming it is fully ready...`)
    }

    // Guard: wait until the multidev is confirmed initialized before proceeding.
    // Pantheon's async workflows (database clone, search-replace, etc.) may still
    // be running even after terminus returns. Poll env:info up to 20 times × 30s.
    let initialized = false
    for (let attempt = 1; attempt <= 20; attempt++) {
      const info = await run(`terminus env:info ${env(job)} --format=json 2>&1`)
      try {
        const d = JSON.parse(cleanJson(info.stdout))
        if (d?.initialized === true || d?.initialized === 'true') {
          initialized = true
          break
        }
      } catch {}
      if (attempt < 20) {
        log('info', `Waiting for ${job.multidev} to finish initializing (attempt ${attempt}/20)...`)
        await new Promise(r => setTimeout(r, 30_000))
      }
    }
    if (!initialized) throw new Error(`${job.multidev} did not finish initializing after 10 minutes`)
    job.multidevCreated = true
    log('success', `Multidev ${job.multidev} created`)
    postStep(`✓ Multidev \`${job.multidev}\` created`)

    // ── 6. Site info + upstream ───────────────────────────────────────────────
    checkCancelled(job)
    step('Checking site info')
    log('status', `Checking upstream for ${job.site}...`)

    let upstream = 'unknown'
    try {
      const data = JSON.parse(cleanJson(siteInfoRaw.stdout))
      upstream = (data?.upstream_product_label ?? data?.upstream ?? '').toLowerCase()
    } catch {}
    job.upstream = upstream

    const envInfoResult = await run(`terminus env:info ${env(job)} --format=json 2>&1`)
    let phpVersion = '8.2'
    try {
      const envData = JSON.parse(cleanJson(envInfoResult.stdout))
      phpVersion = envData?.php_version ?? '8.2'
    } catch {}
    // Switch PHP to match the site. The terminus wrapper (/usr/local/bin/terminus)
    // auto-selects terminus-3 for PHP ≤8.1 and terminus-4 for PHP 8.2+ — no clamping needed.
    log('info', `PHP version: ${phpVersion} — switching terminus to match`)
    const phpSwitch = await run(`update-alternatives --set php /usr/bin/php${phpVersion} 2>&1`)
    if (phpSwitch.code !== 0) {
      log('warn', `Could not switch to PHP ${phpVersion} — continuing with default`)
    } else {
      log('info', `PHP ${phpVersion} active — terminus wrapper will use ${parseFloat(phpVersion) >= 8.2 ? 'terminus-4' : 'terminus-3'}`)
    }

    const isWordPress = SUPPORTED_UPSTREAMS.some((u) => upstream.includes(u))
    if (!isWordPress) {
      log('warn', `Upstream "${upstream}" is not a supported WordPress upstream — skipping upstream steps`)
    } else {
      log('info', `Upstream: ${upstream}`)
    }

    // ── 7. Git mode ──────────────────────────────────────────────────────────
    step('Setting Git mode')
    log('status', 'Setting connection mode to Git...')
    await run(`terminus connection:set ${env(job)} git 2>&1`)
    log('info', 'Connection mode: Git')

    // ── 8–9. Upstream updates (skippable) ────────────────────────────────────
    if (!job.skipUpstream && isWordPress) {
      step('Checking upstream')
      log('status', 'Checking for upstream updates...')
      const upstreamList = await run(`terminus upstream:updates:list ${env(job)} --format=json 2>&1`)
      // Log raw for diagnosis — Pantheon tracks upstream at site level so a
      // previously-applied upstream may not show again even on a fresh multidev.
      log('info', `Upstream list raw: ${upstreamList.stdout.slice(0, 300).replace(/\n/g, ' ') || '(empty)'}`)
      let hasUpdates = false
      try {
        const entries = parseWpJson<{ message?: string; hash?: string }>(cleanJson(upstreamList.stdout))
        hasUpdates = entries.length > 0
        if (hasUpdates) {
          job.upstreamUpdates = entries.map(e => ({ message: e.message ?? '', hash: e.hash }))
          log('info', `${entries.length} upstream update(s) available`)
          for (const e of entries) if (e.message) log('info', `  · ${e.message}`)
        } else {
          // Double-check via string format in case JSON parse missed something
          const textList = await run(`terminus upstream:updates:list ${env(job)} 2>&1`)
          const textClean = cleanJson(textList.stdout).toLowerCase()
          if (!textClean.includes('no upstream updates') && !textClean.includes('no available updates') && textClean.length > 10) {
            log('warn', 'upstream:updates:list JSON was empty but text output suggests updates may be available — check manually')
            log('info', `Upstream text: ${textList.stdout.slice(0, 200).replace(/\n/g, ' ')}`)
          } else {
            log('info', 'No upstream updates available')
          }
        }
      } catch {
        log('info', 'No upstream updates available')
      }

      if (hasUpdates) {
        step('Applying upstream')
        log('status', 'Applying upstream updates...')

        // Capture WordPress version before applying
        const verBefore = await run(wp(job, 'core version'))
        job.upstreamOldVersion = cleanJson(verBefore.stdout).trim().replace(/[^\d.]/g, '') || undefined

        const hashResult = await run(`terminus env:code-log ${env(job)} --format=json 2>/dev/null`)
        let preApplyHash = ''
        try {
          const entries = JSON.parse(cleanJson(hashResult.stdout))
          preApplyHash = entries?.[0]?.hash ?? entries?.[0]?.Hash ?? ''
        } catch {}

        const applyResult = await runStream(
          `terminus upstream:updates:apply --updatedb ${env(job)} 2>&1`,
          (line) => log('info', line),
        )

        if (applyResult.code !== 0) {
          job.upstreamConflict = true
          log('warn', 'Upstream update failed — possible merge conflict, attempting revert...')
          if (preApplyHash) {
            const reverted = await revertUpstreamConflict(job, preApplyHash)
            if (reverted) {
              log('warn', 'Upstream reverted — skipping upstream update, proceeding with plugin/theme updates')
            } else {
              log('error', 'Auto-revert failed — environment may be in a conflicted state. Proceeding, but review git status manually.')
            }
          } else {
            log('warn', 'No pre-apply hash captured — skipping revert')
          }
        } else {
          job.upstreamUpdated = true
          const verAfter = await run(wp(job, 'core version'))
          job.upstreamNewVersion = cleanJson(verAfter.stdout).trim().replace(/[^\d.]/g, '') || undefined
          const verNote = job.upstreamOldVersion && job.upstreamNewVersion
            ? ` (${job.upstreamOldVersion} → ${job.upstreamNewVersion})`
            : ''
          log('success', `Upstream updates applied successfully${verNote}`)
          postStep('✓ Upstream updates applied')
        }
      }
    } else if (job.skipUpstream) {
      log('info', 'Upstream updates skipped (user option)')
    }

    // ── 10. SFTP mode ────────────────────────────────────────────────────────
    step('Setting SFTP mode')
    log('status', 'Setting connection mode to SFTP...')
    // Retry up to 5 times with 30s delay — Pantheon needs time after multidev creation
    let sftpResult = await run(`terminus connection:set ${env(job)} sftp 2>&1`)
    for (let attempt = 2; sftpResult.code !== 0 && attempt <= 5; attempt++) {
      log('warn', `SFTP mode switch failed (attempt ${attempt - 1}/5) — waiting 30s for Pantheon to warm up...`)
      await new Promise((r) => setTimeout(r, 30000))
      sftpResult = await run(`terminus connection:set ${env(job)} sftp 2>&1`)
    }
    if (sftpResult.code !== 0) throw new Error(`Failed to set SFTP mode after 5 attempts: ${sftpResult.stdout.trim()}`)
    log('info', 'Connection mode: SFTP')

    // WordPress readiness poll (new multidev needs DB sync time)
    log('status', 'Verifying WordPress database is ready...')
    let wpReady = false
    for (let attempt = 1; attempt <= 6; attempt++) {
      const check = await run(wp(job, 'core is-installed'))
      if (check.code === 0) { wpReady = true; break }
      if (attempt < 6) {
        log('info', `WordPress not ready yet (attempt ${attempt}/6) — waiting 30s...`)
        await new Promise((r) => setTimeout(r, 30000))
      }
    }
    if (!wpReady) {
      log('warn', 'WordPress not ready after 3 minutes — plugin/theme updates will be skipped')
    }

    // ── 11–14. Plugin + theme updates (skippable) ────────────────────────────
    // Load per-site skip preferences (configured in Update Options tab)
    const sitePrefs = await getSiteUpdatePrefs(job.site)
    const pluginSkipPrefs = sitePrefs?.plugin_skips ?? []
    const themeSkipPrefs  = sitePrefs?.theme_skips  ?? []
    if (pluginSkipPrefs.length > 0 || themeSkipPrefs.length > 0) {
      log('info', `Site preferences: skipping ${pluginSkipPrefs.length} plugin(s) and ${themeSkipPrefs.length} theme(s)`)
    }

    if (!job.skipPluginsThemes) {
      step('Updating plugins')
      const pluginSummary = wpReady ? await runPluginOrThemeUpdates(job, 'plugin', pluginSkipPrefs) : { updated: [], skipped: [] }
      job.plugins = pluginSummary

      if (pluginSummary.updated.length > 0 || pluginSummary.skipped.length > 0) {
        step('Committing plugins')
        const pluginMsg = buildCommitMessage(pluginSummary, { updated: [], skipped: [] })
        log('status', 'Committing plugin updates...')
        const { code: commitCode } = await runStream(
          `terminus env:commit ${env(job)} --message=${shellEscape(pluginMsg)} 2>&1`,
          (line) => log('info', line),
        )
        if (commitCode !== 0) {
          log('warn', 'Plugin commit returned non-zero — changes may still be pending')
        } else {
          log('success', 'Plugin updates committed')
        }
      } else {
        log('info', 'No plugin changes to commit')
      }

      step('Updating themes')
      const themeSummary = wpReady ? await runPluginOrThemeUpdates(job, 'theme', themeSkipPrefs) : { updated: [], skipped: [] }
      job.themes = themeSummary

      if (themeSummary.updated.length > 0 || themeSummary.skipped.length > 0) {
        step('Committing themes')
        const themeMsg = buildCommitMessage({ updated: [], skipped: [] }, themeSummary)
        log('status', 'Committing theme updates...')
        const { code: themeCommitCode } = await runStream(
          `terminus env:commit ${env(job)} --message=${shellEscape(themeMsg)} 2>&1`,
          (line) => log('info', line),
        )
        if (themeCommitCode !== 0) {
          log('warn', 'Theme commit returned non-zero — changes may still be pending')
        } else {
          log('success', 'Theme updates committed')
        }
      } else {
        log('info', 'No theme changes to commit')
      }
    } else {
      log('info', 'Plugin and theme updates skipped (user option)')
    }

    // DB update if upstream was applied
    if (job.upstreamUpdated) {
      log('status', 'Running database update...')
      const dbResult = await runStream(wp(job, 'core update-db'), (line) => log('info', line))
      if (dbResult.code !== 0) {
        log('warn', 'Database update returned non-zero — check manually')
      } else {
        log('success', 'Database updated')
      }
    }

    // ── 15. Cache flush ──────────────────────────────────────────────────────
    step('Flushing cache')
    log('status', 'Flushing WordPress cache...')
    await runStream(wp(job, 'cache flush'), (line) => log('info', line))
    log('success', 'Cache flushed')

    // Safety commit — only if we actually made SFTP changes (plugins or themes updated).
    // Skipping when nothing was updated avoids false positives where upstream-committed
    // core files appear as "pending" in env:diffstat after switching to SFTP mode.
    const hadSftpChanges = job.plugins.updated.length > 0 || job.themes.updated.length > 0
    if (hadSftpChanges) {
      const diffStat = await run(`terminus env:diffstat ${env(job)} --format=json 2>&1`)
      try {
        const pending = parseWpJson(cleanJson(diffStat.stdout))
        if (pending.length > 0) {
          log('warn', `${pending.length} uncommitted file(s) detected — committing before switching to Git...`)
          await run(`terminus env:commit ${env(job)} --message='Staged updates (safety commit)' 2>&1`)
          log('success', 'Safety commit completed')
        }
      } catch {}
    }

    log('status', 'Setting connection mode to Git...')
    const gitResult = await run(`terminus connection:set ${env(job)} git 2>&1`)
    if (gitResult.code !== 0) {
      log('warn', `Could not set Git mode: ${gitResult.stderr}`)
    } else {
      log('info', 'Connection mode: Git')
    }

    // ── 16. Clear edge cache ─────────────────────────────────────────────────
    step('Clearing edge cache')
    log('status', 'Clearing Pantheon edge cache...')
    const clearResult = await run(`terminus env:clear-cache ${env(job)} 2>&1`)
    if (clearResult.code !== 0) {
      log('warn', `Edge cache clear warning: ${clearResult.stderr}`)
    } else {
      log('success', 'Pantheon edge cache cleared')
    }

    // ── Done ─────────────────────────────────────────────────────────────────
    const upstreamNote = job.upstreamUpdated
      ? 'upstream updated, '
      : job.upstreamConflict
        ? 'upstream conflict (skipped), '
        : job.skipUpstream
          ? 'upstream skipped, '
          : ''
    log(
      'success',
      `Staging complete for ${env(job)} — ${upstreamNote}` +
      `${job.plugins.updated.length} plugin(s) updated, ` +
      `${job.themes.updated.length} theme(s) updated`,
    )

    if (job.deployDestination === 'multidev') {
      // Keep in Multidev — notify in thread, skip deployment scheduling
      postStep(`✅ *Staging complete* — multidev \`${job.multidev}\` is ready for client review`)
      void notifyInThread(
        slackThreadTs,
        buildMultidevReadyBlocks(siteLabel, job.multidev, job.site !== siteLabel ? job.site : undefined),
        `Staging complete — ${job.multidev} on ${siteLabel} ready for client to promote`,
      )
    } else {
      postStep(
        `✅ *Staging complete* — ${job.plugins.updated.length} plugin(s) · ${job.themes.updated.length} theme(s) updated`,
      )
      void notifyInThread(
        slackThreadTs,
        buildCompleteBlocks(
          siteLabel, job.multidev,
          job.plugins.updated.length, job.themes.updated.length,
          job.site !== siteLabel ? job.site : undefined,
        ),
        `Staging complete on ${siteLabel} (${job.multidev})`,
      )
    }

    finishJob(job, 'completed')
    // Only schedule deployment if something was actually updated — no point deploying a clean run.
    const anythingUpdated = job.upstreamUpdated || job.plugins.updated.length > 0 || job.themes.updated.length > 0
    if (job.deployDestination !== 'multidev' && anythingUpdated) {
      await scheduleDeployment(job)
    } else if (!anythingUpdated) {
      log('info', 'Nothing was updated — skipping deployment schedule')
    }
    await finalizeStagingRecord(job.id, {
      site_name: job.site_name,
      upstream: job.upstream,
      upstream_updated: job.upstreamUpdated,
      upstream_skipped_reason: job.upstreamConflict ? 'merge conflict' : job.skipUpstream ? 'skipped by user' : undefined,
      upstream_updates: job.upstreamUpdates.length > 0 ? job.upstreamUpdates : undefined,
      upstream_old_version: job.upstreamOldVersion,
      upstream_new_version: job.upstreamNewVersion,
      plugins_updated: job.plugins.updated,
      plugins_skipped: job.plugins.skipped,
      themes_updated: job.themes.updated,
      themes_skipped: job.themes.skipped,
      status: 'completed',
      completed_at: new Date().toISOString(),
      logs: job.logs,
    })
  } catch (err) {
    const isCancelled = err instanceof CancelledError
    const isPaused    = err instanceof PauseError
    if (isPaused) return

    const status  = isCancelled ? 'cancelled' : 'failed'
    const message = isCancelled
      ? 'Staging cancelled by user'
      : `Staging failed: ${err instanceof Error ? err.message : String(err)}`

    log(isCancelled ? 'warn' : 'error', message)

    if (isCancelled) {
      void notifyInThread(
        slackThreadTs,
        buildCancelledBlocks(siteLabel, job.multidev, 'Cancelled by user', job.site !== siteLabel ? job.site : undefined),
        `Staging cancelled on ${siteLabel}`,
      )
    } else {
      postStep(`❌ *Failed:* ${err instanceof Error ? err.message : String(err)}`)
      void notifyInThread(
        slackThreadTs,
        buildFailedBlocks(siteLabel, job.multidev, err instanceof Error ? err.message : String(err), job.site !== siteLabel ? job.site : undefined),
        `Staging failed on ${siteLabel}`,
      )
    }

    finishJob(job, status)
    await finalizeStagingRecord(job.id, {
      site_name: job.site_name,
      upstream: job.upstream,
      upstream_updated: job.upstreamUpdated,
      plugins_updated: job.plugins.updated,
      plugins_skipped: job.plugins.skipped,
      themes_updated: job.themes.updated,
      themes_skipped: job.themes.skipped,
      status,
      completed_at: new Date().toISOString(),
      logs: job.logs,
    })
  } finally {
    stopAlerts()
  }
}
