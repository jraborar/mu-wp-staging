import { readFile } from 'fs/promises'
import {
  type StagingJob,
  type SecurityAdvisory,
  appendLog,
  finishJob,
  setStep,
} from '@/lib/jobStore'
import { run, runStream, shellEscape, cleanJson, terminusPhp } from '@/lib/terminus'
import { updateSite, type Site } from '@/lib/sites'
import { prebookDeployment, reconcileDeployment } from '@/lib/schedule'
import {
  createStagingRecord,
  finalizeStagingRecord,
  getSiteVrtEnabled,
  getSiteUpdatePrefs,
} from '@/lib/supabase'
import { startBaseline, finishCompare, multidevUrl } from '@/lib/vrt'
import type { UpdatedItem } from '@/lib/wordpress'
import {
  startStagingThread,
  postThreadStep,
  notifyInThread,
  buildCompleteBlocks,
  buildFailedBlocks,
  buildMultidevReadyBlocks,
} from '@/lib/slack'

// ─────────────────────────────────────────────────────────────────────────────
// Pantheon serves THREE distinct Drupal update mechanisms. We detect which from the
// LIVE env (authoritative — the registry's update_mode drifts), never guess:
//
//   'ic'     Integrated Composer (build_step: true in pantheon(.upstream).yml).
//            Commit composer.{json,lock} only — Pantheon builds vendor server-side.
//   'vendor' Composer-managed but NOT IC (composer.json present, no build_step).
//            vendor/ is committed to git → we must build it locally and commit it.
//   'drush'  No composer.json (classic drops-7 / legacy drops-8). Core via
//            upstream:updates:apply; contrib via SFTP-mode `drush pm-update` + env:commit.
// ─────────────────────────────────────────────────────────────────────────────
type Mechanism = 'ic' | 'vendor' | 'drush'

interface DrupalProfile {
  mechanism: Mechanism
  framework: string
  upstreamLabel: string
  machineName: string
  siteLabel: string
  maxMultidevs: number
  hasComposer: boolean
  buildStep: boolean
  drushMajor: number
  coreMajor: number   // Drupal core major (7, 8, 9, 10, 11) — picks cr vs cc all
}

// Cache-clear command differs by core major: Drupal 8+ = `cr` (cache-rebuild),
// Drupal 7 = `cc all` (cache-clear). Drush 8 serves BOTH cores, so the drush
// version is NOT the discriminator — the core major is.
function cacheClearCmd(coreMajor: number): string {
  return coreMajor > 0 && coreMajor < 8 ? 'cc all' : 'cr'
}

// A freshly-created Pantheon multidev container needs a short window before SSH access
// propagates, so the first drush-over-SSH call can fail with "Permission denied
// (publickey)" / Exit 255 even though nothing is wrong. Such a failure means the SSH
// session NEVER established — the command never ran — so retrying is safe (unlike a
// command that ran and failed for a real reason, which we must NOT re-run).
function isTransientSsh(output: string, code: number): boolean {
  if (code === 0) return false
  return code === 255
    || /Permission denied \(publickey\)|Connection (refused|timed out|closed)|kex_exchange_identification|ssh_exchange_identification|Could not resolve hostname/i.test(output)
}

const noopLog: Logger = () => {}

// `terminus drush <target> -- <args>`, retrying ONLY on transient SSH-handshake
// failures (never on a command that actually ran and returned an error). Streams lines
// to the log when stream=true; buffers them either way so the failure can be classified.
async function drushRun(
  target: string, args: string, log: Logger = noopLog,
  opts: { stream?: boolean; retries?: number } = {},
): Promise<{ code: number; stdout: string }> {
  const retries = opts.retries ?? 5
  const cmd = `terminus drush ${target} -- ${args} 2>&1`
  for (let attempt = 1; ; attempt++) {
    let code: number, stdout: string
    if (opts.stream) {
      let buf = ''
      const r = await runStream(cmd, (line) => { buf += line + '\n'; log('info', line) })
      code = r.code; stdout = buf
    } else {
      const r = await run(cmd)
      code = r.code; stdout = r.stdout
    }
    if (!isTransientSsh(stdout, code) || attempt > retries) return { code, stdout }
    const delay = Math.min(30_000, 5_000 * attempt)
    log('warn', `drush over SSH not ready yet (exit ${code}) — retry ${attempt}/${retries} in ${delay / 1000}s`)
    await new Promise((r) => setTimeout(r, delay))
  }
}

// Read the live/env Drupal core version via `drush status --format=json` (the
// --field flag is drush 9+, so it errors on D7's drush 8 — JSON works everywhere).
async function drushCoreVersion(target: string, log: Logger = noopLog): Promise<string | undefined> {
  const r = await drushRun(target, 'status --format=json', log)
  try {
    const d = JSON.parse(cleanJson(r.stdout))
    const v = d?.['drupal-version'] ?? d?.drupal_version
    return v ? String(v) : undefined
  } catch {
    return undefined
  }
}

// Drupal core packages move together and map to the History "upstream" line. A bare
// `composer update` respects the site's ^constraint, so a Drupal MAJOR (11.x while
// pinned to ^10) is never pulled — not an update option unless the customer opts in.
const CORE_GROUP = new Set([
  'drupal/core',
  'drupal/core-recommended',
  'drupal/core-composer-scaffold',
  'drupal/core-project-message',
])
const CORE_UPDATE_TARGETS = [
  'drupal/core-recommended',
  'drupal/core-composer-scaffold',
  'drupal/core-project-message',
]

const GIT_AUTHOR_NAME = 'MU Staging'
const GIT_AUTHOR_EMAIL = 'staging@mixed.digital'

class CancelledError extends Error {
  constructor() { super('Staging cancelled by user') }
}

function env(job: StagingJob): string {
  return `${job.site}.${job.multidev}`
}

function checkCancelled(job: StagingJob): void {
  if (job.cancelRequested) throw new CancelledError()
}

// Find a multidev whose name exactly matches prefix-YYMMDD (mirrors staging.ts).
function findByPrefix(list: string, prefix: string): string | null {
  const re = new RegExp(`^${prefix}-\\d{6}$`)
  for (const line of list.split('\n')) {
    const trimmed = line.trim()
    if (re.test(trimmed)) return trimmed
  }
  return null
}

// Map a php_version ("8.1.34") to the container's matching CLI binary. The container
// ships php8.1/8.2/8.3 only — sites on 7.x resolve under 8.1 (logged as a caveat).
function phpBinary(phpVersion?: string | null): string {
  const v = (phpVersion ?? '8.2').trim()
  if (/^7\./.test(v) || v.startsWith('8.0') || v.startsWith('8.1')) return 'php8.1'
  if (v.startsWith('8.3')) return 'php8.3'
  return 'php8.2'
}

interface LockEntry { version: string; type: string }

async function readLock(path: string): Promise<Map<string, LockEntry>> {
  const out = new Map<string, LockEntry>()
  try {
    const d = JSON.parse(await readFile(path, 'utf8'))
    for (const p of [...(d.packages ?? []), ...(d['packages-dev'] ?? [])]) {
      out.set(p.name, { version: p.version, type: p.type ?? '' })
    }
  } catch {}
  return out
}

interface LockDiff {
  core: UpdatedItem[]
  modules: UpdatedItem[]
  themes: UpdatedItem[]
  deps: UpdatedItem[]
}

// Categorize what actually changed between two locks. The lock diff — not
// `composer show -o` markers — is the source of truth: `!` means "a newer version
// exists", but an exact pin in composer.json still holds the package back.
function diffLocks(before: Map<string, LockEntry>, after: Map<string, LockEntry>): LockDiff {
  const diff: LockDiff = { core: [], modules: [], themes: [], deps: [] }
  for (const [name, av] of after) {
    const bv = before.get(name)
    if (!bv || bv.version === av.version) continue
    const item: UpdatedItem = { name, title: name, from: bv.version, to: av.version }
    if (CORE_GROUP.has(name)) diff.core.push(item)
    else if (av.type === 'drupal-module') diff.modules.push(item)
    else if (av.type === 'drupal-theme') diff.themes.push(item)
    else diff.deps.push(item)
  }
  const byName = (a: UpdatedItem, b: UpdatedItem) => a.name.localeCompare(b.name)
  diff.core.sort(byName); diff.modules.sort(byName); diff.themes.sort(byName); diff.deps.sort(byName)
  return diff
}

async function readConstraints(composerJsonPath: string): Promise<Record<string, string>> {
  try {
    const d = JSON.parse(await readFile(composerJsonPath, 'utf8'))
    return { ...(d.require ?? {}), ...(d['require-dev'] ?? {}) }
  } catch {
    return {}
  }
}

// An exact pin is a constraint with no range operator — e.g. "1.17.0", not "^1.4".
// We NEVER move these, even for a security advisory: they are pinned for a reason.
function isPinned(constraint: string | undefined): boolean {
  if (!constraint) return false
  const c = constraint.trim()
  if (!c || c.startsWith('dev-')) return false
  return !'^~><*|'.includes(c[0])
}

// Parse `composer audit --locked --format=json`, flagging advisories that sit on an
// exact-pinned package (those get reported for manual review, never auto-updated).
function parseAudit(raw: string, constraints: Record<string, string>): SecurityAdvisory[] {
  const out: SecurityAdvisory[] = []
  let adv: Record<string, unknown[]> = {}
  try {
    adv = JSON.parse(cleanJson(raw)).advisories ?? {}
  } catch {
    return out
  }
  for (const [pkg, items] of Object.entries(adv)) {
    for (const it of items as Record<string, string>[]) {
      out.push({
        package: pkg,
        id: it.cve || it.advisoryId || '?',
        title: (it.title ?? '').slice(0, 200),
        link: it.link,
        pinned: isPinned(constraints[pkg]),
      })
    }
  }
  return out
}

type Logger = (t: Parameters<typeof appendLog>[1], m: string) => void

// ── Mechanism detection (reads the LIVE dev env, before any multidev exists) ──────
async function detectProfile(job: StagingJob, seedPhp: string, log: Logger): Promise<DrupalProfile> {
  const info = await run(`terminus site:info ${job.site} --format=json 2>&1`)
  let framework = '', upstreamLabel = '', machineName = job.site, siteLabel = job.site, maxMultidevs = 10
  try {
    const d = JSON.parse(cleanJson(info.stdout))
    framework = String(d?.framework ?? '').toLowerCase()
    upstreamLabel = String(d?.upstream_product_label ?? d?.upstream ?? '').toLowerCase()
    machineName = d?.name ?? job.site
    siteLabel = d?.label ?? d?.name ?? job.site
    maxMultidevs = d?.max_num_cdes ?? d?.max_multidevs ?? 10
  } catch {}

  if (!framework.startsWith('drupal')) {
    throw new Error(`unsupported_drupal_profile: framework "${framework || 'unknown'}" is not Drupal`)
  }

  // Read pantheon.yml + pantheon.upstream.yml + probe for composer.json / drush version
  // in one round-trip via drush php-eval on the canonical dev env.
  const probeExpr =
    'echo "MU_BUILDSTEP=".((preg_match("/^\\s*build_step:\\s*true/m",@file_get_contents("/code/pantheon.yml").' +
    '"\\n".@file_get_contents("/code/pantheon.upstream.yml")))?"1":"0")."\\n";' +
    'echo "MU_COMPOSER=".(file_exists("/code/composer.json")?"1":"0")."\\n";' +
    'echo "MU_DRUSH=".(defined("DRUSH_VERSION")?DRUSH_VERSION:"?")."\\n";'
  // Retry-guard the probe: a transient SSH failure here would read composer/build_step
  // as absent and misroute the site to the wrong mechanism.
  const probe = await drushRun(`${job.site}.dev`, `php-eval ${shellEscape(probeExpr)}`, log)
  const buildStep = /MU_BUILDSTEP=1/.test(probe.stdout)
  const hasComposer = /MU_COMPOSER=1/.test(probe.stdout)
  const drushMatch = probe.stdout.match(/MU_DRUSH=(\d+)/)
  const drushMajor = drushMatch ? parseInt(drushMatch[1], 10) : 0

  let mechanism: Mechanism
  if (hasComposer && buildStep) mechanism = 'ic'
  else if (hasComposer) mechanism = 'vendor'
  else mechanism = 'drush'

  // Core major decides cr vs cc all. `framework` is only "drupal7" / "drupal8" (8 for
  // ALL D8+), so read the real version from drush status.
  const coreVersion = await drushCoreVersion(`${job.site}.dev`, log)
  const coreMajor = coreVersion ? parseInt(coreVersion.split('.')[0], 10) || 0 : (framework === 'drupal7' ? 7 : 0)

  log('info',
    `Drupal profile: framework=${framework}, mechanism=${mechanism}, core=${coreVersion ?? '?'} ` +
    `(build_step=${buildStep}, composer=${hasComposer}, drush=${drushMajor || '?'})`)
  if (mechanism !== 'drush' && phpBinary(seedPhp) === 'php8.1' && /^7\./.test((seedPhp ?? '').trim())) {
    log('warn', `Site PHP is ${seedPhp}; the container has no PHP 7.x — Composer will resolve under php8.1`)
  }
  return { mechanism, framework, upstreamLabel, machineName, siteLabel, maxMultidevs, hasComposer, buildStep, drushMajor, coreMajor }
}

// After a git push / upstream apply, Pantheon runs a server-side workflow (IC build or
// sync-code deploy). Poll until nothing is running/queued so drush runs against new code.
async function waitForWorkflows(job: StagingJob, log: Logger, label: string): Promise<void> {
  for (let attempt = 1; attempt <= 40; attempt++) {
    const wf = await run(`terminus workflow:list ${job.site} --format=json 2>&1`)
    try {
      const entries = JSON.parse(cleanJson(wf.stdout)) as Array<Record<string, unknown>>
      const active = entries.filter(e => {
        const s = String(e.status ?? '').toLowerCase()
        return s === 'running' || s === 'queued' || s === 'pending'
      })
      if (active.length === 0) { log('success', `${label} finished`); return }
    } catch {}
    if (attempt < 40) {
      log('info', `Waiting for ${label} to finish (attempt ${attempt}/40)...`)
      await new Promise(r => setTimeout(r, 15_000))
    }
  }
  log('warn', `${label} did not confirm as finished after 10 minutes — proceeding (verify manually if updates look stale)`)
}

interface UpdateOutcome {
  coreChanged: boolean
  anythingUpdated: boolean
  pushed: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Composer strategy — serves both IC and committed-vendor. `integrated` is the only
// behavioural switch: IC rewrites the lock and commits it (Pantheon builds); vendor
// builds vendor/ locally and commits the whole built tree.
// ─────────────────────────────────────────────────────────────────────────────
async function composerStrategy(
  job: StagingJob, profile: DrupalProfile, phpCtx: { php: string }, log: Logger,
  postStep: (m: string) => void, workdir: string,
): Promise<UpdateOutcome> {
  const integrated = profile.mechanism === 'ic'
  checkCancelled(job)
  setStep(job, 'Resolving Composer updates', job.stepIndex + 1, job.stepTotal)

  const php = phpBinary(phpCtx.php)
  const composerEnv = `COMPOSER_HOME=/tmp/mu_composer_home COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_NO_INTERACTION=1 COMPOSER_PROCESS_TIMEOUT=900`
  const composer = (args: string) => `${composerEnv} ${php} /usr/local/bin/composer --working-dir=${workdir} ${args}`
  const gitc = (args: string) => `git -C ${workdir} ${args}`
  // Both paths resolve on THIS container, whose minimal PHP lacks extensions the site's
  // real runtime has (e.g. ext-gd). Composer's solver enforces platform reqs even with
  // --no-install, so without ignoring them it rejects every candidate ("could not be
  // resolved") and the update silently looks like a no-op. IC only rewrites the lock, so
  // it ignores just the EXTENSIONS (ext-*) and keeps php-version resolution honest; the
  // committed-vendor path also builds vendor here, so it drops all platform reqs. Running
  // under the matching php binary keeps VERSION resolution correct either way.
  const resolveFlags = integrated
    ? '--no-install --no-audit --no-scripts --no-plugins --ignore-platform-req=ext-*'
    : '--no-audit --no-scripts --no-plugins --ignore-platform-reqs'

  log('status', 'Resolving multidev git URL...')
  // terminus emits PHP deprecation lines on stdout; --field output is NOT JSON (no
  // cleanJson), so pick the actual URL line rather than trusting the whole blob.
  const gitInfo = await run(`terminus connection:info ${env(job)} --field=git_url 2>&1`)
  const gitUrl = gitInfo.stdout.split('\n').map((l) => l.trim()).find((l) => /^(ssh|https?):\/\//.test(l)) ?? ''
  if (!gitUrl) throw new Error('Could not resolve the multidev git URL')

  await run(`rm -rf ${workdir}`)
  log('status', `Cloning ${job.multidev} branch${integrated ? '' : ' (committed-vendor repos are large — this can take a few minutes)'}...`)
  const clone = await runStream(
    `git clone --depth 1 --single-branch --branch ${job.multidev} ${shellEscape(gitUrl)} ${workdir} 2>&1`,
    (line) => log('info', line),
  )
  if (clone.code !== 0) throw new Error(`git clone failed for branch ${job.multidev}`)

  let composerJson = ''
  try { composerJson = await readFile(`${workdir}/composer.json`, 'utf8') } catch {}
  if (!composerJson) throw new Error('No composer.json on the multidev branch')

  const origLock = await readLock(`${workdir}/composer.lock`)
  const coreBefore = origLock.get('drupal/core')?.version ?? '?'
  const constraints = await readConstraints(`${workdir}/composer.json`)

  // Advisory-affected packages otherwise block `composer update` (Composer 2.10+). We
  // report advisories separately and never force-fix a pin. This edits the working-copy
  // composer.json only — we never `git add` composer.json (IC) / we restore it (vendor).
  await run(composer(`config --no-plugins policy.advisories.block false 2>&1`))

  const commitOpts = `-c user.name=${shellEscape(GIT_AUTHOR_NAME)} -c user.email=${shellEscape(GIT_AUTHOR_EMAIL)}`
  let commits = 0

  // Only the lock (IC) / the whole built tree (vendor). composer.json must stay
  // byte-identical to the branch: our updates are all within existing constraints.
  const stageAndCommit = async (message: string) => {
    if (integrated) {
      await run(gitc(`add composer.lock 2>&1`))
    } else {
      await run(gitc(`checkout -- composer.json 2>&1`))   // discard the advisory-block edit
      await run(gitc(`add -A 2>&1`))                       // vendor/, core/, modules/contrib/, lock
    }
    await run(gitc(`${commitOpts} commit -m ${shellEscape(message)} 2>&1`))
    commits++
  }

  // Phase A — Drupal core as the "upstream" update. -W pulls core's own deps.
  log('status', 'Checking for an in-constraint Drupal core update...')
  const coreUpdate = await runStream(
    composer(`update ${CORE_UPDATE_TARGETS.join(' ')} -W ${resolveFlags} 2>&1`),
    (line) => log('info', line),
  )
  // A failed solve (unresolvable deps, missing platform ext) leaves the lock untouched,
  // which downstream reads as "coreChanged=false" — i.e. a hard error masquerading as
  // "up to date". Fail loudly instead of shipping an inconclusive run as a success.
  if (coreUpdate.code !== 0) {
    throw new Error('Composer could not resolve a Drupal core update — see the log above. A failed solve must not be reported as "up to date".')
  }
  const afterCore = await readLock(`${workdir}/composer.lock`)
  const coreAfter = afterCore.get('drupal/core')?.version ?? coreBefore
  const coreChanged = coreAfter !== coreBefore
  if (coreChanged) {
    job.upstreamUpdated = true
    job.upstreamOldVersion = coreBefore
    job.upstreamNewVersion = coreAfter
    await stageAndCommit(`Update Drupal core (${coreBefore} → ${coreAfter})`)
    log('success', `Drupal core: ${coreBefore} → ${coreAfter}`)
    postStep(`✓ Drupal core ${coreBefore} → ${coreAfter}`)
  } else {
    log('info', `Drupal core is up to date (${coreBefore}) — nothing new within constraint`)
  }

  // Phase B — modules / themes / deps. Exact pins are honoured automatically.
  log('status', 'Resolving remaining module / theme / dependency updates...')
  const restUpdate = await runStream(composer(`update ${resolveFlags} 2>&1`), (line) => log('info', line))
  if (restUpdate.code !== 0) {
    throw new Error('Composer could not resolve module/theme/dependency updates — see the log above. A failed solve must not be reported as "no updates".')
  }
  const finalLock = await readLock(`${workdir}/composer.lock`)

  const totalDiff = diffLocks(origLock, finalLock)
  job.plugins = { updated: totalDiff.modules, skipped: [] }
  job.themes = { updated: totalDiff.themes, skipped: [] }
  job.composerDeps = totalDiff.deps

  const restChanged = totalDiff.modules.length + totalDiff.themes.length + totalDiff.deps.length
  if (restChanged > 0) {
    const lines = ['Update Drupal modules, themes & dependencies', '']
    for (const m of totalDiff.modules) lines.push(`- ${m.name} (${m.from} → ${m.to})`)
    for (const t of totalDiff.themes) lines.push(`- ${t.name} (${t.from} → ${t.to})`)
    if (totalDiff.deps.length) lines.push(`- ${totalDiff.deps.length} Composer dependency update(s)`)
    await stageAndCommit(lines.join('\n'))
    log('success', `${totalDiff.modules.length} module(s), ${totalDiff.themes.length} theme(s), ${totalDiff.deps.length} dependency update(s)`)
  } else {
    log('info', 'No module / theme / dependency updates within constraint')
  }

  // Security audit — reports advisories (incl. on pinned packages we left alone).
  const auditRaw = (await run(composer(`audit --locked --format=json 2>&1`))).stdout
  job.securityAdvisories = parseAudit(auditRaw, constraints)
  if (job.securityAdvisories.length > 0) {
    log('warn', `${job.securityAdvisories.length} security advisory(ies) found:`)
    for (const a of job.securityAdvisories) {
      log('warn', `  ⚠ ${a.package} — ${a.id}${a.pinned ? ' [PINNED — manual review, not updated]' : ''}`)
    }
  }

  const anythingUpdated = coreChanged || restChanged > 0
  let pushed = false
  if (commits > 0) {
    checkCancelled(job)
    setStep(job, 'Pushing & building', job.stepIndex + 1, job.stepTotal)
    log('status', integrated
      ? 'Pushing updates — Pantheon will build via Integrated Composer...'
      : 'Pushing built code (composer.lock + vendor/) — Pantheon will deploy it...')
    const push = await runStream(gitc(`push origin ${job.multidev} 2>&1`), (line) => log('info', line))
    if (push.code !== 0) throw new Error('git push failed — updates were not deployed to the multidev')
    pushed = true
    await waitForWorkflows(job, log, integrated ? 'Integrated Composer build' : 'code sync')

    checkCancelled(job)
    setStep(job, 'Database updates (drush)', job.stepIndex + 1, job.stepTotal)
    log('status', 'Applying database updates (drush updatedb)...')
    await drushRun(env(job), 'updatedb -y', log, { stream: true })
    const cc = cacheClearCmd(profile.coreMajor)
    log('status', `Rebuilding cache (drush ${cc})...`)
    await drushRun(env(job), cc, log, { stream: true })
    log('success', 'Database updated and cache rebuilt')
  } else {
    log('info', 'Nothing to push — no in-constraint updates were available')
  }

  return { coreChanged, anythingUpdated, pushed }
}

interface DrushProject { name: string; existing: string; candidate: string; type: string }

// Parse `drush pm-updatestatus --format=json` (D7 drush 8) → projects with a newer
// candidate. Output carries warnings/ANSI before the JSON, so extract the object.
function parseUpdateStatus(raw: string): DrushProject[] {
  const s = raw.indexOf('{'); const e = raw.lastIndexOf('}')
  if (s < 0 || e < 0) return []
  let obj: Record<string, Record<string, string>> = {}
  try { obj = JSON.parse(raw.slice(s, e + 1)) } catch { return [] }
  const out: DrushProject[] = []
  for (const [name, r] of Object.entries(obj)) {
    const existing = r.existing_version, candidate = r.candidate_version
    if (existing && candidate && existing !== candidate) {
      out.push({ name, existing, candidate, type: (r.project_type || 'module').toLowerCase() })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Drush strategy — classic drops-7 / non-composer Drupal. Core via upstream merge
// (git mode); contrib via SFTP-mode `drush pm-update` + env:commit. No local clone.
// ─────────────────────────────────────────────────────────────────────────────
async function drushStrategy(
  job: StagingJob, profile: DrupalProfile, log: Logger, postStep: (m: string) => void,
): Promise<UpdateOutcome> {
  checkCancelled(job)
  setStep(job, 'Applying core (upstream)', job.stepIndex + 1, job.stepTotal)

  // Core version before/after via `drush status --format=json` (drush 8 has no --field).
  const drupalVersion = () => drushCoreVersion(env(job), log)

  // ── Core via upstream:updates:apply (same git-merge model as WordPress core) ──
  await run(`terminus connection:set ${env(job)} git 2>&1`)
  let coreChanged = false
  const upstreamList = await run(`terminus upstream:updates:list ${env(job)} --format=json 2>&1`)
  let hasUpstream = false
  try {
    const entries = JSON.parse(cleanJson(upstreamList.stdout))
    const arr = Array.isArray(entries) ? entries : Object.values(entries)
    hasUpstream = arr.length > 0
    if (hasUpstream) {
      job.upstreamUpdates = arr.map((e: { message?: string; hash?: string }) => ({ message: e.message ?? '', hash: e.hash }))
      for (const e of job.upstreamUpdates) if (e.message) log('info', `  · ${e.message}`)
    }
  } catch {}

  if (hasUpstream) {
    const before = await drupalVersion()
    log('status', 'Applying Drupal core upstream update (upstream:updates:apply --updatedb)...')
    const applyLines: string[] = []
    const apply = await runStream(
      `terminus upstream:updates:apply --updatedb ${env(job)} 2>&1`,
      (line) => { applyLines.push(line); log('info', line) },
    )
    if (apply.code !== 0) {
      job.upstreamConflict = true
      job.upstreamConflictFiles = Array.from(new Set(
        applyLines
          .map(l => l.match(/CONFLICT \([^)]*\): Merge conflict in (.+?)\s*$/))
          .filter((m): m is RegExpMatchArray => m !== null)
          .map(m => m[1].trim()),
      ))
      log('warn', 'Upstream core update conflicted — Pantheon left the multidev unchanged; reporting the conflict.')
      for (const f of job.upstreamConflictFiles) log('warn', `  · ${f}`)
    } else {
      const after = await drupalVersion()
      job.upstreamUpdated = true
      job.upstreamOldVersion = before
      job.upstreamNewVersion = after
      coreChanged = before !== after
      log('success', `Drupal core: ${before ?? '?'} → ${after ?? '?'}`)
      postStep(`✓ Drupal core ${before ?? '?'} → ${after ?? '?'}`)
    }
  } else {
    log('info', 'No upstream core update available')
  }

  // ── Contrib via SFTP-mode drush pm-update ────────────────────────────────────
  checkCancelled(job)
  setStep(job, 'Updating contrib (drush)', job.stepIndex + 1, job.stepTotal)
  log('status', 'Checking contrib module/theme updates (drush pm-updatestatus)...')
  const statusRaw = await drushRun(env(job), 'pm-updatestatus --format=json', log)
  let projects = parseUpdateStatus(statusRaw.stdout).filter(p => p.name !== 'drupal' && p.type !== 'core')

  // Honour per-site skip lists (module machine names) if the site is registered.
  const prefs = await getSiteUpdatePrefs(job.site).catch(() => null)
  const skips = new Set([...(prefs?.plugin_skips ?? []), ...(prefs?.theme_skips ?? [])])
  const skipped = projects.filter(p => skips.has(p.name))
  projects = projects.filter(p => !skips.has(p.name))
  for (const p of skipped) {
    job.plugins.skipped.push({ name: p.name, title: p.name, reason: 'skipped by site preference' })
  }

  let contribCount = 0
  if (projects.length > 0) {
    const names = projects.map(p => p.name)
    log('status', `Updating ${names.length} contrib project(s) in SFTP mode: ${names.join(', ')}`)
    await run(`terminus connection:set ${env(job)} sftp 2>&1`)
    try {
      // --no-core: core is handled by the upstream merge above. Explicit name list so
      // skipped modules stay put and the commit message is deterministic.
      const upd = await drushRun(
        env(job), `pm-update --no-core -y ${names.map(shellEscape).join(' ')}`, log, { stream: true },
      )
      if (upd.code !== 0) log('warn', 'drush pm-update reported a non-zero exit — verifying what changed via env:diffstat')
      // Commit the downloaded code BEFORE leaving SFTP mode (git mode discards uncommitted changes).
      const commit = await run(`terminus env:commit ${env(job)} --message=${shellEscape('Update Drupal contrib modules/themes (drush)')} 2>&1`)
      log('info', commit.stdout.split('\n').filter(l => l.trim()).slice(-3).join(' '))
    } finally {
      await run(`terminus connection:set ${env(job)} git 2>&1`)
    }

    // Confirm what actually moved (re-check status; anything still listed didn't update).
    const afterRaw = await drushRun(env(job), 'pm-updatestatus --format=json', log)
    const stillOutdated = new Set(parseUpdateStatus(afterRaw.stdout).map(p => p.name))
    for (const p of projects) {
      if (stillOutdated.has(p.name)) {
        job.plugins.skipped.push({ name: p.name, title: p.name, reason: 'update did not apply — needs manual review' })
        continue
      }
      const item: UpdatedItem = { name: p.name, title: p.name, from: p.existing, to: p.candidate }
      if (p.type === 'theme') job.themes.updated.push(item)
      else job.plugins.updated.push(item)
      contribCount++
    }

    log('status', 'Applying database updates (drush updatedb)...')
    await drushRun(env(job), 'updatedb -y', log, { stream: true })
    log('success', `${contribCount} contrib project(s) updated`)
  } else {
    log('info', 'No contrib updates available (all modules/themes current)')
  }

  await drushRun(env(job), cacheClearCmd(profile.coreMajor), log, { stream: true })
  const anythingUpdated = coreChanged || contribCount > 0
  const pushed = anythingUpdated || job.upstreamUpdated
  return { coreChanged, anythingUpdated, pushed }
}

// ─────────────────────────────────────────────────────────────────────────────
export async function runDrupalStaging(job: StagingJob, registrySite: Site | null): Promise<void> {
  const phpCtx = { php: registrySite?.php_version ?? '8.2' }
  terminusPhp.enterWith(phpCtx)

  const log: Logger = (logType, m) => appendLog(job, logType, m)

  const STEPS_TOTAL = 12
  job.stepTotal = STEPS_TOTAL
  const step = (name: string, index: number) => setStep(job, name, index, STEPS_TOTAL)

  await createStagingRecord(job.id, {
    site: job.site,
    multidev: job.multidev,
    status: 'running',
    started_at: new Date(job.startedAt).toISOString(),
  })

  let slackThreadTs: string | null = null
  let siteLabel = job.site_name ?? job.site
  const postStep = (msg: string) => { void postThreadStep(slackThreadTs, msg) }
  const workdir = `/tmp/mu_drupal_${job.id}`

  try {
    // ── 1. Auth ────────────────────────────────────────────────────────────────
    step('Authenticating', 1)
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

    // ── 2. Detect mechanism (IC / vendor / drush) ───────────────────────────────
    step('Detecting Drupal profile', 2)
    log('status', 'Detecting Drupal update mechanism from the live environment...')
    const profile = await detectProfile(job, phpCtx.php, log)
    siteLabel = profile.siteLabel
    if (siteLabel !== job.site) job.site_name = siteLabel
    job.upstream = profile.upstreamLabel || `drupal (${profile.mechanism})`
    const needsSsh = profile.mechanism === 'ic' || profile.mechanism === 'vendor'
    if (needsSsh && !process.env.PANTHEON_SSH_KEY) {
      throw new Error('PANTHEON_SSH_KEY is not set — required to clone/push the Composer-managed Drupal repo.')
    }

    slackThreadTs = await startStagingThread(job.site, job.multidev)
    postStep(`✓ Authenticated as ${identity}`)
    postStep(`✓ Drupal profile: *${profile.mechanism.toUpperCase()}* mechanism`)

    // ── 3. Multidev slots ────────────────────────────────────────────────────────
    checkCancelled(job)
    step('Checking multidev slots', 3)
    log('status', 'Checking multidev availability...')
    const multidevList = (await run(`terminus multidev:list ${job.site} --field=id 2>&1`)).stdout
    const currentMultidevs = multidevList.split('\n').map(l => l.trim()).filter(l => /^[a-z0-9][a-z0-9-]{0,10}$/.test(l))
    const isStandardName = /^mu-\d{6}$/.test(job.multidev)
    const targetExists = currentMultidevs.includes(job.multidev)
    const existingMu = targetExists ? job.multidev : isStandardName ? findByPrefix(multidevList, 'mu') : null
    const countAfterDelete = existingMu ? currentMultidevs.length - 1 : currentMultidevs.length
    if (countAfterDelete >= profile.maxMultidevs) {
      throw new Error(`All ${profile.maxMultidevs} multidev slots are in use — free a slot and re-run`)
    }

    // ── 4. Create fresh multidev from live ───────────────────────────────────────
    step('Creating multidev', 4)
    if (existingMu) {
      log('delete', `Removing existing multidev ${existingMu}...`)
      postStep(`🗑 Removing old multidev \`${existingMu}\`...`)
      await run(`terminus multidev:delete --yes --delete-branch ${job.site}.${existingMu} 2>&1`)
      log('deleted', `Removed ${existingMu}`)
    }
    log('create', `Creating multidev ${job.multidev} from live...`)
    postStep(`◈ Creating multidev \`${job.multidev}\` from live... _(a few minutes)_`)
    const create = await runStream(`terminus multidev:create ${job.site}.live ${job.multidev} 2>&1`, (line) => log('info', line))
    if (create.code !== 0) {
      const verify = await run(`terminus multidev:list ${job.site} --fields=Name --format=list 2>&1`)
      if (!verify.stdout.split('\n').map(l => l.trim()).includes(job.multidev)) throw new Error('Multidev creation failed')
    }
    let initialized = false
    for (let attempt = 1; attempt <= 20; attempt++) {
      const info = await run(`terminus env:info ${env(job)} --format=json 2>&1`)
      try {
        const d = JSON.parse(cleanJson(info.stdout))
        if (d?.initialized === true || d?.initialized === 'true') { initialized = true; break }
        if (d?.php_version) phpCtx.php = String(d.php_version)
      } catch {}
      if (attempt < 20) { log('info', `Waiting for ${job.multidev} to initialize (${attempt}/20)...`); await new Promise(r => setTimeout(r, 30_000)) }
    }
    if (!initialized) throw new Error(`${job.multidev} did not finish initializing after 10 minutes`)
    job.multidevCreated = true
    log('success', `Multidev ${job.multidev} created (PHP ${phpCtx.php})`)
    postStep(`✓ Multidev \`${job.multidev}\` created`)

    await prebookDeployment(job)

    // ── 5. VRT baseline (pre-update) ─────────────────────────────────────────────
    if (await getSiteVrtEnabled(job.site).catch(() => false)) {
      step('VRT baseline', 5)
      log('status', 'Capturing VRT baseline (pre-update)...')
      const vrt = await startBaseline(job.site, job.multidev, profile.machineName)
      if (vrt) { job.vrtRunId = vrt.run_id; job.vrtReportUrl = vrt.report_url; log('info', `VRT baseline started — ${vrt.report_url}`) }
      else log('warn', 'VRT baseline could not be started — skipping visual regression')
    }

    // ── 6. Backup before mutation ────────────────────────────────────────────────
    checkCancelled(job)
    step('Backup before mutation', 6)
    log('status', 'Creating database backup before any change...')
    const backup = await runStream(`terminus backup:create ${env(job)} --element=database 2>&1`, (line) => log('info', line))
    if (backup.code !== 0) throw new Error('Database backup failed — stopping before any mutation (rollback safety)')
    log('success', 'Database backup created')
    postStep('✓ Database backup created')

    // ── 7. Normalize (drush cache clear) + health ────────────────────────────────
    checkCancelled(job)
    step('Normalize (drush cache clear) + health', 7)
    const normCc = cacheClearCmd(profile.coreMajor)
    log('status', `Rebuilding Drupal cache (drush ${normCc})...`)
    await drushRun(env(job), normCc, log, { stream: true })
    const healthUrl = multidevUrl(profile.machineName, job.multidev)
    const healthCode = (await run(`curl -s -o /dev/null -w '%{http_code}' --max-time 30 ${shellEscape(healthUrl)} 2>&1`)).stdout.trim()
    log(healthCode.startsWith('2') || healthCode.startsWith('3') ? 'success' : 'warn', `Health probe ${healthUrl} → HTTP ${healthCode || 'no response'}`)

    // ── 8. Update (mechanism-specific) ───────────────────────────────────────────
    const outcome = profile.mechanism === 'drush'
      ? await drushStrategy(job, profile, log, postStep)
      : await composerStrategy(job, profile, phpCtx, log, postStep, workdir)

    // ── 9. Clear edge cache ──────────────────────────────────────────────────────
    step('Clearing edge cache', 11)
    log('status', 'Clearing Pantheon edge cache...')
    await run(`terminus env:clear-cache ${env(job)} 2>&1`)
    log('success', 'Pantheon edge cache cleared')

    // ── 10. VRT compare (post-update) ────────────────────────────────────────────
    let vrtSummary = ''
    if (job.vrtRunId) {
      step('Running VRT comparison', STEPS_TOTAL)
      log('status', 'Capturing VRT candidate (post-update) and diffing vs baseline...')
      const result = await finishCompare(job.multidev, profile.machineName, job.vrtRunId)
      if (!result) {
        job.vrtStatus = 'incomplete'
        log('warn', 'VRT comparison did not complete — see the report for status')
        vrtSummary = job.vrtReportUrl ? `\n🔍 VRT: comparison incomplete — <${job.vrtReportUrl}|open report>` : ''
      } else if (result.status === 'failed') {
        job.vrtStatus = 'failed'
        const total = result.results?.length ?? 0
        const errors = result.results?.filter(r => r.error).length ?? 0
        const detail = errors > 0 ? ` — ${errors} of ${total} path(s) could not be captured` : ''
        log('warn', `VRT could not compare${detail}`)
        vrtSummary = job.vrtReportUrl ? `\n🔍 *VRT: no comparison ran*${detail} — <${job.vrtReportUrl}|open report>` : ''
      } else {
        const n = result.flagged_count
        const total = result.results?.length ?? 0
        const errors = result.results?.filter(r => r.error).length ?? 0
        job.vrtStatus = errors > 0 ? 'incomplete' : 'completed'
        job.vrtFlaggedCount = n
        log(n > 0 || errors > 0 ? 'warn' : 'success', `VRT: ${n} path(s) flagged, ${errors} of ${total} failed to capture — ${job.vrtReportUrl}`)
        const parts: string[] = []
        if (n > 0) parts.push(`*${n} path(s) flagged for review*`)
        if (errors > 0) parts.push(`*${errors} of ${total} path(s) failed to capture*`)
        vrtSummary = `\n🔍 VRT: ${parts.length ? parts.join(' · ') : 'no visual changes detected'} — <${job.vrtReportUrl}|open report>`
      }
    }

    // ── 11. Done ─────────────────────────────────────────────────────────────────
    const coreNote = outcome.coreChanged ? `core ${job.upstreamOldVersion} → ${job.upstreamNewVersion}, ` : ''
    log('success',
      `Staging complete for ${env(job)} — ${coreNote}` +
      `${job.plugins.updated.length} module(s), ${job.themes.updated.length} theme(s), ${job.composerDeps.length} dependency update(s)`)

    if (job.deployDestination === 'multidev') {
      if (!job.securityFastTrack) await updateSite(job.site, { last_deployment: new Date().toISOString() }).catch(() => {})
      postStep(`✅ *Staging complete* — multidev \`${job.multidev}\` is ready for client review${vrtSummary}`)
      void notifyInThread(slackThreadTs,
        buildMultidevReadyBlocks(siteLabel, job.multidev, job.site !== siteLabel ? job.site : undefined),
        `Staging complete — ${job.multidev} on ${siteLabel} ready for client to promote`)
    } else {
      postStep(`✅ *Staging complete* — ${job.plugins.updated.length} module(s) · ${job.themes.updated.length} theme(s) · ${job.composerDeps.length} dep(s)${vrtSummary}`)
      void notifyInThread(slackThreadTs,
        buildCompleteBlocks(siteLabel, job.multidev, job.plugins.updated.length, job.themes.updated.length, job.site !== siteLabel ? job.site : undefined),
        `Staging complete on ${siteLabel} (${job.multidev})`)
    }

    finishJob(job, 'completed')
    if (job.deployDestination !== 'multidev') {
      await reconcileDeployment(job, outcome.anythingUpdated)
      if (!outcome.anythingUpdated) log('info', 'Nothing was updated — pre-booked deploy cancelled')
    }
    await finalizeStagingRecord(job.id, drupalRecord(job, 'completed'))
  } catch (err) {
    const isCancelled = err instanceof CancelledError
    const status = isCancelled ? 'cancelled' : 'failed'
    const message = isCancelled ? 'Staging cancelled by user' : `Staging failed: ${err instanceof Error ? err.message : String(err)}`
    log(isCancelled ? 'warn' : 'error', message)
    if (!isCancelled) {
      postStep(`❌ *Failed:* ${err instanceof Error ? err.message : String(err)}`)
      void notifyInThread(slackThreadTs,
        buildFailedBlocks(siteLabel, job.multidev, err instanceof Error ? err.message : String(err), job.site !== siteLabel ? job.site : undefined),
        `Staging failed on ${siteLabel}`)
    }
    finishJob(job, status)
    await reconcileDeployment(job, false)
    await finalizeStagingRecord(job.id, drupalRecord(job, status))
  } finally {
    await run(`rm -rf ${workdir}`)
  }
}

// Map the job's accumulated results onto the staging_history row (Drupal reuses the WP
// columns: core→upstream_*, modules→plugins_, themes→themes_; plus composer_deps_updated
// + security_advisories from sql/014).
function drupalRecord(job: StagingJob, status: string) {
  return {
    site_name: job.site_name,
    platform: 'drupal',
    upstream: job.upstream,
    upstream_updated: job.upstreamUpdated,
    upstream_skipped_reason: job.upstreamConflict
      ? (job.upstreamConflictFiles.length > 0 ? `merge conflict in ${job.upstreamConflictFiles.length} file(s)` : 'merge conflict')
      : undefined,
    upstream_conflict_files: job.upstreamConflictFiles.length > 0 ? job.upstreamConflictFiles : undefined,
    upstream_old_version: job.upstreamOldVersion,
    upstream_new_version: job.upstreamNewVersion,
    upstream_updates: job.upstreamUpdates.length > 0 ? job.upstreamUpdates : undefined,
    plugins_updated: job.plugins.updated,
    plugins_skipped: job.plugins.skipped,
    themes_updated: job.themes.updated,
    themes_skipped: job.themes.skipped,
    composer_deps_updated: job.composerDeps,
    security_advisories: job.securityAdvisories,
    vrt_report_url: job.vrtReportUrl ?? undefined,
    vrt_flagged_count: job.vrtFlaggedCount ?? undefined,
    vrt_status: job.vrtStatus ?? undefined,
    status,
    completed_at: new Date().toISOString(),
    logs: job.logs,
  }
}
