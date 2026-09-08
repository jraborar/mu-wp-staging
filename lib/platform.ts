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
// `upstream_label` on some sites, but the git URL is always present.
//
// Each mode is paired with the upstream whose `upstream_label` Pantheon actually
// reports for it, read from a live site rather than inferred:
//
//   wordpress               "WordPress"                            → upstream
//   wordpress-network       "WordPress Multisite"                  → upstream
//   drops-7                 "Drupal 7"                             → drops7
//   drops-8                 "Drupal 8"                             → drupal8
//   drupal-composer-managed "Drupal (Composer Managed)"            → composer
//   drupal-project          "Drupal 9 (deprecated)"                → drupal9
//   drupal-recommended      "Drupal with Composer (deprecated)"    → drupal-composer
//   empty                   "Empty Upstream"                       → empty
//
// NOTE the last two. `drupal-project` is Pantheon's "Drupal 9" and
// `drupal-recommended` is its "Drupal with Composer" — the reverse of what the
// UpdateMode comments in lib/sites.ts claimed, and of how the two affected sites
// (hfu, saddlebackd9) were classified by hand. Corrected here to follow Pantheon,
// since these two modes are labels only: nothing branches on the difference, and
// lib/drupal.ts detects the real mechanism from the live env ("authoritative — the
// registry's update_mode drifts, never guess"). The two live rows keep their
// existing values regardless, because `existing` outranks detection.
const UPSTREAM_MODES: Record<string, UpdateMode> = {
  'wordpress':               'upstream',
  'wordpress-network':       'upstream',
  'drops-7':                 'drops7',
  'drops-8':                 'drupal8',
  'drupal-composer-managed': 'composer',
  'drupal-project':          'drupal9',
  'drupal-recommended':      'drupal-composer',
  'empty':                   'empty',
}

// "<uuid>: https://github.com/pantheon-upstreams/drops-7.git" → "drops-7"
export function upstreamSlug(upstream: string): string {
  return (upstream.match(/\/([^/]+?)(?:\.git)?\s*$/)?.[1] ?? '').toLowerCase()
}

export function updateModeFromUpstream(upstream: string): UpdateMode | undefined {
  return UPSTREAM_MODES[upstreamSlug(upstream)]
}
