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

// Keyed on the upstream REPO SLUG, not on `upstream_label`.
//
// The label is the more readable key and it is always present — every one of the 28
// registered sites has one. It is still the wrong thing to match on, because it is
// NOT a stable identifier for an upstream: an organisation creates its own upstream
// record pointing at a Pantheon repo and names it whatever it likes. Two sites here
// prove it — same repo, two upstream UUIDs, two labels:
//
//   niacc           19fc7977…  "WordPress Multisite"
//   tstc-multisite  e68b6362…  "Wordpress Multisite Upstream"
//
// A label-keyed map needs a row per spelling and silently misses the next org that
// names one differently — falling through to the 'upstream' default, which is a
// WordPress mode and would be actively wrong on a Drupal site. The slug is identical
// for both. (`platform` is unaffected either way: it comes from `framework`.)
//
// The remaining gap is an org that forks a Pantheon upstream into its OWN repo — a
// slug this table does not know. That returns undefined and the caller's default
// applies, same as before detection existed.
//
// Each mode is paired with the upstream whose `upstream_label` Pantheon actually
// reports for it, read from a live site rather than inferred. All but
// wordpress-network are a single shared UUID — one canonical Pantheon product
// upstream — so these labels are Pantheon's own, not an org's:
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

// Is this a drops-style Drupal site — core dropped into /code/core/ rather than
// composer-managed? drops-7 and drops-8 are the two, and they are the sites whose
// contrib modules this tool can list over drush. Everything else Drupal is IC-like,
// where exclusions are Composer's business.
//
// Reads update_mode, NOT a substring of the upstream string. The checks this
// replaces were `upstream.includes('drops-7')`, which only ever worked because
// sites.upstream happened to hold the raw git URL (…/pantheon-upstreams/drops-7.git).
// Now that the column stores the product label terminus actually reports, "Drupal 7"
// carries no `drops-7` substring and those tests would silently reclassify the site
// as Integrated Composer — showing an empty module list and skipping drush entirely.
export function isDropsUpdateMode(mode: UpdateMode | null | undefined): boolean {
  return mode === 'drops7' || mode === 'drupal8'
}
