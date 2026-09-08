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
import { platformFromFramework, updateModeFromUpstream, upstreamSlug } from '../lib/platform.ts'

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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
