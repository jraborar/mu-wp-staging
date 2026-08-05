import { type StagingJob, appendLog, finishJob } from '@/lib/jobStore'
import { run, runStream, shellEscape, cleanJson } from '@/lib/terminus'
import { scheduleDeployment } from '@/lib/schedule'
import {
  buildUpdateSummary,
  buildCommitMessage,
  parseWpJson,
  type UpdateSummary,
} from '@/lib/wordpress'
import { createStagingRecord, finalizeStagingRecord } from '@/lib/supabase'

const SUPPORTED_UPSTREAMS = ['wordpress', 'wordpress-multisite']

function env(job: StagingJob): string {
  return `${job.site}.${job.multidev}`
}

// Wraps a WP-CLI command via terminus wp
function wp(job: StagingJob, args: string): string {
  return `terminus wp ${env(job)} -- ${args} 2>&1`
}

async function revertUpstreamConflict(
  job: StagingJob,
  preApplyHash: string,
): Promise<boolean> {
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

    // Abort any in-progress merge, then reset to the pre-apply hash
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
): Promise<UpdateSummary> {
  const label = type === 'plugin' ? 'Plugin' : 'Theme'
  const log = (logType: Parameters<typeof appendLog>[1], m: string) => appendLog(job, logType, m)

  // Force a fresh update check so the cache isn't stale after upstream apply
  log('status', `Checking for ${label.toLowerCase()} updates...`)
  await run(wp(job, `${type} check-update 2>&1`))

  const listResult = await run(
    wp(job, `${type} list --update=available --format=json --context=admin`),
  )

  const cleaned = cleanJson(listResult.stdout)
  const rawPreview = listResult.stdout.slice(0, 600).replace(/\n/g, ' ')
  log('info', `${label} list raw (600): ${rawPreview || '(empty)'}`)
  log('info', `${label} list cleaned: ${cleaned.slice(0, 300) || '(empty)'}`)

  const available = parseWpJson<{ name: string; title?: string; version?: string }>(cleaned)

  if (available.length === 0) {
    log('info', `No ${label.toLowerCase()} updates available`)
    return { updated: [], skipped: [] }
  }

  log('info', `Found ${available.length} ${label.toLowerCase()}(s) with available updates`)
  log('status', `Updating ${label.toLowerCase()}s...`)

  // --format=json suppresses progress output; WP-CLI outputs JSON array on completion
  interface WpUpdateEntry { name: string; old_version: string; new_version: string; status: string }
  const jsonResult = await run(
    wp(job, `${type} update --all --context=admin --format=json`),
  )
  const results = parseWpJson<WpUpdateEntry>(cleanJson(jsonResult.stdout))

  const summary = buildUpdateSummary(available, results)

  for (const u of summary.updated) {
    log('success', `${label}: ${u.title} ${u.from} → ${u.to}`)
  }
  for (const s of summary.skipped) {
    log('warn', `${label} skipped: ${s.title} — ${s.reason}`)
  }

  return summary
}

export async function executeJob(job: StagingJob): Promise<void> {
  const log = (logType: Parameters<typeof appendLog>[1], m: string) => appendLog(job, logType, m)

  await createStagingRecord(job.id, {
    site: job.site,
    multidev: job.multidev,
    status: 'running',
    started_at: new Date(job.startedAt).toISOString(),
  })

  try {
    // ── 1. Auth ──────────────────────────────────────────────────────────────
    log('status', 'Verifying Terminus authentication...')
    const token = process.env.TERMINUS_TOKEN
    if (token) await run(`terminus auth:login --machine-token="${token}" 2>&1`)
    const whoami = await run('terminus auth:whoami 2>&1')
    const identity = whoami.stdout.split('\n').find((l) => l.includes('@'))?.trim()
    if (!identity) throw new Error('Terminus not authenticated — check TERMINUS_TOKEN')
    log('info', `Authenticated as: ${identity}`)

    // Verify SSH key is present — required for all WP-CLI commands
    if (!process.env.PANTHEON_SSH_KEY) {
      throw new Error('PANTHEON_SSH_KEY is not set — required for terminus wp (plugin/theme updates). Add it in Railway environment variables.')
    }

    // ── 2. Site info + upstream check ────────────────────────────────────────
    log('status', `Checking site info for ${job.site}...`)
    const siteInfo = await run(`terminus site:info ${job.site} --format=json 2>&1`)
    if (siteInfo.code !== 0) throw new Error(`Site "${job.site}" not found or inaccessible`)

    let siteLabel = job.site
    let upstream = 'unknown'
    try {
      const cleaned = cleanJson(siteInfo.stdout)
      const match = cleaned.match(/\{[\s\S]*\}/)
      if (match) {
        const data = JSON.parse(match[0])
        siteLabel = data?.label ?? data?.name ?? job.site
        upstream = (data?.upstream_product_label ?? data?.upstream ?? '').toLowerCase()
      }
    } catch {}

    job.site_name = siteLabel !== job.site ? siteLabel : undefined
    job.upstream = upstream

    // ── 2B. Match PHP version to the environment ─────────────────────────────
    const envInfo = await run(`terminus env:info ${env(job)} --format=json 2>&1`)
    let phpVersion = '8.2'
    try {
      const envData = JSON.parse(cleanJson(envInfo.stdout))
      phpVersion = envData?.php_version ?? '8.2'
    } catch {}
    log('info', `Site PHP version: ${phpVersion} — switching terminus to match`)
    const phpBin = `/usr/bin/php${phpVersion}`
    const phpSwitch = await run(`update-alternatives --set php ${phpBin} 2>&1`)
    if (phpSwitch.code !== 0) {
      log('warn', `Could not switch to PHP ${phpVersion} — continuing with default`)
    } else {
      log('info', `PHP switched to ${phpVersion}`)
    }

    const isWordPress = SUPPORTED_UPSTREAMS.some((u) => upstream.includes(u))
    if (!isWordPress) {
      log('warn', `Upstream "${upstream}" is not a supported WordPress upstream — skipping upstream update steps`)
    } else {
      log('info', `Upstream: ${upstream}`)
    }

    // ── 3. Ensure git mode before upstream operations ─────────────────────────
    log('status', 'Setting connection mode to Git...')
    await run(`terminus connection:set ${env(job)} git 2>&1`)
    log('info', 'Connection mode: Git')

    // ── 3. Upstream updates ──────────────────────────────────────────────────
    if (isWordPress) {
      log('status', 'Checking for upstream updates...')
      const upstreamList = await run(
        `terminus upstream:updates:list ${env(job)} --format=json 2>&1`,
      )
      // Parse JSON — if it's a non-empty array, there are updates
      let hasUpdates = false
      try {
        const entries = parseWpJson(cleanJson(upstreamList.stdout))
        hasUpdates = entries.length > 0
        log('info', hasUpdates
          ? `${entries.length} upstream update(s) available`
          : 'No upstream updates available'
        )
      } catch {
        hasUpdates = false
        log('info', 'No upstream updates available')
      }

      if (!hasUpdates) {
        log('info', 'No upstream updates available')
      } else {
        log('status', 'Applying upstream updates...')

        // Capture pre-apply hash for potential revert
        const hashResult = await run(
          `terminus env:code-log ${env(job)} --format=json 2>/dev/null`,
        )
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
            log('warn', 'No pre-apply hash captured — skipping revert, proceeding with plugin/theme updates')
          }
        } else {
          job.upstreamUpdated = true
          log('success', 'Upstream updates applied successfully')
        }
      }
    }

    // ── 3B. Switch to SFTP ───────────────────────────────────────────────────
    log('status', 'Setting connection mode to SFTP...')
    const sftpResult = await run(`terminus connection:set ${env(job)} sftp 2>&1`)
    if (sftpResult.code !== 0) throw new Error(`Failed to set SFTP mode: ${sftpResult.stderr}`)
    log('info', 'Connection mode: SFTP')

    // ── 4–6. Plugin updates + commit ─────────────────────────────────────────
    const pluginSummary = await runPluginOrThemeUpdates(job, 'plugin')
    job.plugins = pluginSummary

    if (pluginSummary.updated.length > 0 || pluginSummary.skipped.length > 0) {
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

    // ── 7–8. Theme updates + commit ──────────────────────────────────────────
    const themeSummary = await runPluginOrThemeUpdates(job, 'theme')
    job.themes = themeSummary

    if (themeSummary.updated.length > 0 || themeSummary.skipped.length > 0) {
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

    // ── 9. DB update (only if upstream was applied) ──────────────────────────
    if (job.upstreamUpdated) {
      log('status', 'Running database update...')
      const dbResult = await runStream(
        wp(job, 'core update-db'),
        (line) => log('info', line),
      )
      if (dbResult.code !== 0) {
        log('warn', 'Database update returned non-zero — check manually')
      } else {
        log('success', 'Database updated')
      }
    } else {
      log('info', 'Skipping wp core update-db (no upstream update applied)')
    }

    // ── 10. Cache flush ──────────────────────────────────────────────────────
    log('status', 'Flushing WordPress cache...')
    await runStream(wp(job, 'cache flush'), (line) => log('info', line))
    log('success', 'Cache flushed')

    // ── 11. Safety check — commit any remaining SFTP changes before switching to Git
    const diffStat = await run(`terminus env:diffstat ${env(job)} --format=json 2>&1`)
    try {
      const pending = parseWpJson(cleanJson(diffStat.stdout))
      if (pending.length > 0) {
        log('warn', `${pending.length} uncommitted file(s) detected — committing before switching to Git...`)
        await run(`terminus env:commit ${env(job)} --message='Staged updates (safety commit)' 2>&1`)
        log('success', 'Safety commit completed')
      }
    } catch {}

    // ── 11. Switch to Git ────────────────────────────────────────────────────
    log('status', 'Setting connection mode to Git...')
    const gitResult = await run(`terminus connection:set ${env(job)} git 2>&1`)
    if (gitResult.code !== 0) {
      log('warn', `Could not set Git mode: ${gitResult.stderr}`)
    } else {
      log('info', 'Connection mode: Git')
    }

    // ── 12. Clear Pantheon cache ─────────────────────────────────────────────
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
        : ''
    log(
      'success',
      `Staging complete for ${env(job)} — ${upstreamNote}` +
      `${job.plugins.updated.length} plugin(s) updated, ` +
      `${job.themes.updated.length} theme(s) updated`,
    )

    finishJob(job, 'completed')
    void scheduleDeployment(job)
    await finalizeStagingRecord(job.id, {
      site_name: job.site_name,
      upstream: job.upstream,
      upstream_updated: job.upstreamUpdated,
      upstream_skipped_reason: job.upstreamConflict ? 'merge conflict' : undefined,
      plugins_updated: job.plugins.updated,
      plugins_skipped: job.plugins.skipped,
      themes_updated: job.themes.updated,
      themes_skipped: job.themes.skipped,
      status: 'completed',
      completed_at: new Date().toISOString(),
      logs: job.logs,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('error', `Job failed: ${message}`)
    finishJob(job, 'failed')
    await finalizeStagingRecord(job.id, {
      site_name: job.site_name,
      upstream: job.upstream,
      upstream_updated: job.upstreamUpdated,
      plugins_updated: job.plugins.updated,
      plugins_skipped: job.plugins.skipped,
      themes_updated: job.themes.updated,
      themes_skipped: job.themes.skipped,
      status: 'failed',
      completed_at: new Date().toISOString(),
      logs: job.logs,
    })
  }
}
