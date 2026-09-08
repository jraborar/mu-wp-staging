import type { Platform, UpdateMode } from '@/lib/sites'

// Platform / core-update detection from `terminus site:info`.
//
// `platform` and `update_mode` were the only registry columns with no terminus
// fallback: they came from two form dropdowns that defaulted to WordPress +
// Pantheon Upstream, so every Drupal site had to be classified by hand. Both are
// derivable from data site:info already returns.
//
// Kept free of I/O (no Supabase client, no terminus wrapper) so `npm run
// check:platform` can exercise it directly — the same split lib/cadence.ts has.

const FRAMEWORK_PLATFORMS: Record<string, Platform> = {
  wordpress:         'wp-single',
  wordpress_network: 'wp-multisite',
}

// `framework` is the AUTHORITATIVE platform signal. lib/staging.ts already trusts
// it over sites.platform when deciding whether a site is a WordPress network,
// precisely because nothing enforced that column.
export function platformFromFramework(framework: string): Platform | undefined {
  const f = framework.trim().toLowerCase()
  if (FRAMEWORK_PLATFORMS[f]) return FRAMEWORK_PLATFORMS[f]
  // Pantheon reports 'drupal' for D7 (drops-7) and 'drupal8' for every D8+ site,
  // composer-managed ones included. All of them are one `platform` here; which
  // Drupal mechanism to use is update_mode's job, resolved from the upstream below.
  if (f.startsWith('drupal')) return 'drupal'
  return undefined
}

// Keyed on the upstream REPO SLUG rather than the product label: site:info omits
// `upstream_label` on some sites, but the git URL is always present. This mapping
// reproduces the hand-entered update_mode of all 28 registered sites exactly.
const UPSTREAM_MODES: Record<string, UpdateMode> = {
  'wordpress':               'upstream',
  'wordpress-network':       'upstream',
  'drops-7':                 'drops7',
  'drops-8':                 'drupal8',
  'drupal-composer-managed': 'composer',
  'drupal-project':          'drupal-composer',
  'drupal-recommended':      'drupal9',
  'empty':                   'empty',
}

// "<uuid>: https://github.com/pantheon-upstreams/drops-7.git" → "drops-7"
export function upstreamSlug(upstream: string): string {
  return (upstream.match(/\/([^/]+?)(?:\.git)?\s*$/)?.[1] ?? '').toLowerCase()
}

export function updateModeFromUpstream(upstream: string): UpdateMode | undefined {
  return UPSTREAM_MODES[upstreamSlug(upstream)]
}
