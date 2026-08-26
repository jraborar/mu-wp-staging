// One-off: register the two Drupal test sites (D7 drush + D8 committed-vendor) so they
// can be driven through the app. Self-contained (no @/ alias) — mirrors registerSite()
// in lib/sites.ts: resolves Pantheon metadata via terminus, then upserts a full default
// row. Run: node --env-file=.env.local scripts/register_drupal_test_sites.mjs
//
// Test-safe: deploy_destination='multidev' (stage & stop for review, never auto-deploy to
// live) and auto_stage=false (NOT armed for scheduled automation) until the mutating
// paths are validated live.
import { execSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
if (!url || !key) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const db = createClient(url, key)

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
// terminus prepends PHP deprecation/warning lines to JSON — strip to the first {...} / [...].
const cleanJson = (s) => {
  const o = s.indexOf('{'), a = s.indexOf('[')
  const start = a >= 0 && (o < 0 || a < o) ? a : o
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'))
  return start >= 0 && end >= start ? s.slice(start, end + 1) : s
}

if (process.env.TERMINUS_TOKEN) {
  try { sh(`terminus auth:login --machine-token="${process.env.TERMINUS_TOKEN}" 2>&1`) } catch {}
}

function resolveMeta(site) {
  const meta = {}
  try {
    const d = JSON.parse(cleanJson(sh(`terminus site:info ${site} --format=json 2>&1`)))
    meta.site_name = d?.label ?? d?.name ?? null
    meta.machine_name = d?.name ?? null
    meta.upstream = d?.upstream_product_label ?? d?.upstream ?? null
  } catch (e) { console.error(`  site:info failed for ${site}: ${e.message}`) }
  try {
    const e = JSON.parse(cleanJson(sh(`terminus env:info ${site}.dev --format=json 2>&1`)))
    if (e?.php_version) meta.php_version = String(e.php_version)
  } catch {}
  return meta
}

const SITES = [
  { site: 'e6f71c84-b05d-4037-8844-f8bc7483361b', update_mode: 'upstream' }, // D7 — drush mechanism
  { site: 'cdc2f260-4881-4083-9512-0d3a44dc378d', update_mode: 'composer' }, // D8 non-IC — committed-vendor
]

for (const s of SITES) {
  const { data: existing } = await db.from('sites').select('*').eq('site', s.site).maybeSingle()
  const meta = resolveMeta(s.site)
  const row = {
    site: s.site,
    machine_name:        meta.machine_name ?? existing?.machine_name ?? null,
    site_name:           meta.site_name    ?? existing?.site_name    ?? null,
    site_uuid:           existing?.site_uuid ?? null,
    platform:            'drupal',
    parent_site:         existing?.parent_site ?? null,
    php_version:         meta.php_version  ?? existing?.php_version  ?? null,
    upstream:            meta.upstream     ?? existing?.upstream     ?? null,
    update_mode:         s.update_mode,
    skip_upstream:       existing?.skip_upstream       ?? false,
    skip_plugins_themes: existing?.skip_plugins_themes ?? false,
    deploy_days:         existing?.deploy_days         ?? 1,
    deploy_destination:  'multidev',
    deploy_approval:     'manual',
    security_deploy_hours: existing?.security_deploy_hours ?? 24,
    vrt_paths:           existing?.vrt_paths ?? [],
    active:              true,
    auto_stage:          false,
    notes:               existing?.notes ?? 'Drupal staging test site (registered via script; validate before arming auto_stage)',
    last_deployment:     existing?.last_deployment ?? null,
    paused_at:           existing?.paused_at    ?? null,
    paused_until:        existing?.paused_until ?? null,
    pause_reason:        existing?.pause_reason ?? null,
  }
  const { data, error } = await db.from('sites').upsert(row, { onConflict: 'site' }).select().single()
  if (error) { console.error(`✗ ${s.site}: ${error.message}`); continue }
  console.log(
    `✓ ${data.machine_name ?? data.site} (${data.site})\n` +
    `    platform=${data.platform} php=${data.php_version ?? '?'} upstream="${data.upstream ?? '?'}" update_mode=${data.update_mode}\n` +
    `    deploy_destination=${data.deploy_destination} deploy_approval=${data.deploy_approval} auto_stage=${data.auto_stage} active=${data.active}`,
  )
}
