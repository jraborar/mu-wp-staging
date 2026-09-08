// Platform check for lib/platform.ts — the framework → platform and upstream →
// update_mode mapping registration derives its two classification columns from.
// No test runner: `npm run check:platform` (Node strips the types).
//
// The REGISTRY table below is the real thing, not a set of illustrative cases:
// every distinct (upstream repo, platform, update_mode) combination across the 28
// sites in the production registry, all classified by hand before detection
// existed. Detection reproduces 26 of them; the two `drupal-project` /
// `drupal-recommended` rows were transposed by hand and detection follows
// Pantheon's own upstream_label instead — see UPSTREAM_MODES in lib/platform.ts.
//
// The `framework` column was read from Pantheon for one representative site of
// each upstream, so no value here is inferred:
//   WordPress→achi, wordpress-network→niacc, drops-7→policyed1,
//   drops-8→micheal-watson-secretary-of-state, drupal-project→hfu, empty→inst,
//   drupal-recommended→saddlebackd9, drupal-composer-managed→baseball-hall-of-fame
// Note drops-7 is the only site family Pantheon reports as plain 'drupal'; every
// other Drupal upstream — composer-managed, drops-8, and `empty` alike — is 'drupal8'.
// That is exactly why update_mode cannot be derived from framework and needs the
// upstream slug.
import {
  isDropsUpdateMode,
  platformFromFramework,
  updateModeFromUpstream,
  upstreamSlug,
} from '../lib/platform.ts'

let pass = 0, fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n         got ${a}\n         want ${e}`) }
}

const gh = (repo: string) =>
  `bde48795-b16d-443f-af01-8b1790caa1af: https://github.com/pantheon-upstreams/${repo}.git`

// [upstream repo, framework, expected platform, expected update_mode, site count,
//  update_mode stored in the registry when it DIFFERS from expected]
const REGISTRY: [string, string, string, string, number, string?][] = [
  ['WordPress',               'wordpress',         'wp-single',    'upstream',         13],
  ['drupal-composer-managed', 'drupal8',           'drupal',       'composer',          7],
  ['wordpress-network',       'wordpress_network', 'wp-multisite', 'upstream',          2],
  ['drops-7',                 'drupal',            'drupal',       'drops7',            2],
  ['empty',                   'drupal8',           'drupal',       'empty',             1],
  ['drops-8',                 'drupal8',           'drupal',       'drupal8',           1],
  // The two hand-classified rows that were transposed. Detection follows Pantheon's
  // own upstream_label; the stored value is recorded here so the disagreement is
  // visible rather than looking like a mapping bug.
  ['drupal-project',          'drupal8',           'drupal',       'drupal9',           1, 'drupal-composer'],
  ['drupal-recommended',      'drupal8',           'drupal',       'drupal-composer',   1, 'drupal9'],
]

console.log('production registry — all 28 sites, hand-classified before detection existed')
let covered = 0, transposed = 0
for (const [repo, framework, platform, mode, count, stored] of REGISTRY) {
  covered += count
  if (stored) transposed += count
  const note = stored ? ` [registry says ${stored} — transposed by hand]` : ''
  check(`${repo} (${count}x) → platform`, platformFromFramework(framework), platform)
  check(`${repo} (${count}x) → update_mode${note}`, updateModeFromUpstream(gh(repo)), mode)
}
check('rows cover the whole registry', covered, 28)
check('detection agrees with 26 of the 28 stored rows', covered - transposed, 26)

console.log('\nupstream slug extraction')
check('trailing .git stripped',   upstreamSlug(gh('drops-7')), 'drops-7')
check('no .git suffix',           upstreamSlug('uuid: https://github.com/pantheon-upstreams/drops-7'), 'drops-7')
check('trailing whitespace',      upstreamSlug(gh('drops-8') + '  \n'), 'drops-8')
check('case folded',              upstreamSlug(gh('WordPress')), 'wordpress')
check('non-github host still ok', upstreamSlug('uuid: git@example.com:custom/drops-7.git'), 'drops-7')
check('empty string → empty',     upstreamSlug(''), '')

// Why the slug and not `upstream_label`, which reads far better. An org creates its
// own upstream record against a Pantheon repo and names it freely, so the label is
// not a stable identifier: these two real sites share the wordpress-network repo but
// carry different upstream UUIDs and different labels. Keyed on the slug they agree;
// keyed on the label, tstc-multisite needs a second table row to avoid falling
// through to the WordPress default.
console.log('\nsame repo, different org-authored labels — why the slug is the key')
const NIACC = '19fc7977-656c-42f0-817e-73696a15a87a: https://github.com/pantheon-systems/wordpress-network.git'
const TSTC  = 'e68b6362-2ef4-4d94-b9b5-51b854718d9c: https://github.com/pantheon-systems/wordpress-network.git'
check('niacc          "WordPress Multisite"         → upstream', updateModeFromUpstream(NIACC), 'upstream')
check('tstc-multisite "Wordpress Multisite Upstream" → upstream', updateModeFromUpstream(TSTC), 'upstream')
check('both resolve to one slug', upstreamSlug(NIACC) === upstreamSlug(TSTC), true)
check('…which is wordpress-network', upstreamSlug(TSTC), 'wordpress-network')
// pantheon-systems vs pantheon-upstreams — the org segment of the URL varies too,
// and the slug extraction must not care.
check('host org segment ignored', upstreamSlug(NIACC), upstreamSlug(gh('wordpress-network')))

console.log('\nunknown input falls through to the caller default (never guesses)')
check('unknown framework',   platformFromFramework('joomla'), undefined)
check('empty framework',     platformFromFramework(''), undefined)
check('unknown upstream',    updateModeFromUpstream(gh('some-custom-upstream')), undefined)
check('empty upstream',      updateModeFromUpstream(''), undefined)

console.log('\nframework casing / padding tolerated (site:info is not normalised)')
check('WORDPRESS_NETWORK',   platformFromFramework('WORDPRESS_NETWORK'), 'wp-multisite')
check(' drupal8 padded',     platformFromFramework('  drupal8  '), 'drupal')
// Pantheon has reported plain 'drupal' (D7) and 'drupal8' (everything D8+) for
// years, but the prefix match means a future 'drupal11' lands on 'drupal' too
// rather than silently defaulting the site to WordPress.
check('hypothetical drupal11', platformFromFramework('drupal11'), 'drupal')

// The drops/IC split decides whether the Update Options tab lists contrib modules
// over drush or reports "managed by Composer". Every mode is asserted explicitly:
// this replaced `upstream.includes('drops-7')` tests that only worked while
// sites.upstream held a git URL, so a silent flip here mislabels a live site.
console.log('\ndrops-style vs IC-style Drupal (drives the module list)')
for (const [mode, drops] of [
  ['drops7',          true],   // drops-7  — core in /code/core/, drush
  ['drupal8',         true],   // drops-8  — same, despite the composer.json
  ['composer',        false],  // IC
  ['drupal-composer', false],  // drupal-recommended, IC-like
  ['drupal9',         false],  // drupal-project, IC-like
  ['empty',           false],  // empty upstream — no dropped core to protect
  ['upstream',        false],  // WordPress; platform gates this out anyway
  ['none',            false],
] as [string, boolean][]) {
  check(`${mode} → drops-style = ${drops}`, isDropsUpdateMode(mode as never), drops)
}
check('null → not drops (never guesses IC-drush from nothing)', isDropsUpdateMode(null), false)
check('undefined → not drops', isDropsUpdateMode(undefined), false)

// Regression guard for the reason isDropsUpdateMode exists: a product label carries
// no repo slug, so the substring tests this replaced would have called policyed1 IC.
console.log('\nwhy a substring test on the upstream string cannot work')
check('product label has no drops-7 substring', 'Drupal 7'.toLowerCase().includes('drops-7'), false)
check('but its update_mode still says drops',   isDropsUpdateMode('drops7'), true)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
