// Parsing check for lib/inventoryParse.ts — the component inventory the
// per-site console in mu-pmu-tool renders.
// No test runner: `npm run check:inventory` (Node strips the types).
//
// EVERY FIXTURE BELOW IS VERBATIM OUTPUT, captured 2026-09-09 from
// `terminus wp apexorderpickup.live -- plugin list --format=json
//  --fields=name,title,status,version,update,update_version`
// and its theme / core check-update siblings. Nothing here is illustrative.
// That site was chosen because its live environment happens to exhibit every
// shape that broke a naive parser:
//
//   - `update` as the STRING "available" and "none" (ordinary plugins)
//   - `update` as the BOOLEAN false (must-use plugins and the drop-in) —
//     the same field, two JSON types, in one response
//   - an EMPTY title and EMPTY version (`object-cache.php`, a drop-in)
//   - a theme status of `parent`, which is neither active nor inactive
//   - `core check-update` answering `[]` because core is CURRENT
//
// The live counts at capture time: 38 plugins, 7 of them with an update
// waiting; 7 themes, none waiting; core current.
import {
  parseWpComponents,
  parseDrushComponents,
  parseCoreUpdate,
} from '../lib/inventoryParse.ts'

let pass = 0, fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n         got ${a}\n         want ${e}`) }
}

// ── WordPress plugins ───────────────────────────────────────────────────────
const PLUGINS = JSON.stringify([
  { name: 'google-analytics-for-wordpress', title: 'Google Analytics for WordPress by MonsterInsights', status: 'active', version: '11.1.3', update: 'available', update_version: '11.2.0' },
  { name: 'gravityforms', title: 'Gravity Forms', status: 'active', version: '3.1.0.2', update: 'available', update_version: '3.1.1' },
  { name: 'wp-asset-clean-up-pro', title: 'Asset CleanUp Pro: Page Speed Booster', status: 'inactive', version: '1.2.6.9', update: 'none', update_version: '' },
  { name: 'wp-native-php-sessions', title: 'MU WP Native PHP Sessions', status: 'must-use', version: '0.1', update: false, update_version: '' },
  { name: 'loader', title: 'Pantheon MU Plugin Loader', status: 'must-use', version: '1.0', update: false, update_version: '' },
  { name: 'object-cache.php', title: '', status: 'dropin', version: '', update: false, update_version: '' },
])

const plugins = parseWpComponents(PLUGINS, 'plugin')

console.log('WordPress plugin list')
check('every row survives', plugins.length, 6)
check('an available update is flagged', plugins[0].updateAvailable, true)
check('  and carries both versions', [plugins[0].version, plugins[0].available], ['11.1.3', '11.2.0'])
check('"none" is not an update', plugins[2].updateAvailable, false)
check('  and reports no available version', plugins[2].available, null)

console.log('\nthe mixed-type `update` field')
// A truthiness test would mark "none" as available; a string test would mark
// `false` as available. Both were live in the same response.
check('boolean false is NOT an available update', plugins[3].updateAvailable, false)
check('  it is reported as unknown, not current', plugins[3].updateUnknown, true)
check('a real "none" is known, not unknown', plugins[2].updateUnknown, false)
check('drop-ins are unknown too', plugins[5].updateUnknown, true)

console.log('\nempty fields from a drop-in')
check('an empty title falls back to the slug', plugins[5].title, 'object-cache.php')
check('an empty version becomes null, not ""', plugins[5].version, null)

// ── themes, including the `parent` status ──────────────────────────────────
const THEMES = JSON.stringify([
  { name: 'Divi-child', title: 'Divi Child', status: 'active', version: '4.7.7', update: 'none', update_version: '' },
  { name: 'Divi', title: 'Divi', status: 'parent', version: '4.27.7', update: 'none', update_version: '' },
])
const themes = parseWpComponents(THEMES, 'theme')

console.log('\nthemes')
check('kind is carried through', themes.map((t) => t.kind), ['theme', 'theme'])
check('a `parent` theme is kept', themes[1].status, 'parent')

// ── core ───────────────────────────────────────────────────────────────────
console.log('\ncore check-update')
// The single most misreadable response in the set: an empty array is the
// SUCCESS case, not a failed call.
check('[] means core is current', parseCoreUpdate('[]', null), null)
check('a reported update is returned',
  parseCoreUpdate('[{"version":"6.9.1","update_type":"minor"}]', '6.8.2'),
  { version: '6.8.2', available: '6.9.1' })
check('unknown installed version is labelled, not blank',
  parseCoreUpdate('[{"version":"6.9.1"}]', null)?.version, 'unknown')

// ── drush, both shapes ─────────────────────────────────────────────────────
// D7 (drush 8) returns an array; D8+ (drush 9+) returns an object keyed by
// machine name. Both families are live in the registry — policyed1 is drops-7,
// micheal-watson-secretary-of-state is drops-8.
console.log('\ndrush pm-list, both shapes')
const d7 = parseDrushComponents(
  '[{"name":"views","display_name":"Views","status":"Enabled"}]', 'module')
check('D7 array shape parses', [d7.length, d7[0].name, d7[0].title], [1, 'views', 'Views'])

const d8 = parseDrushComponents(
  '{"pathauto":{"name":"Pathauto","status":"Enabled"}}', 'module')
check('D8 object shape parses', [d8.length, d8[0].name, d8[0].title], [1, 'pathauto', 'Pathauto'])
check('drush rows report no version', [d8[0].version, d8[0].available], [null, null])
// drush pm-list says nothing about updates, so a dash here would be a claim
// the data does not support.
check('  and are unknown, never "current"', d8[0].updateUnknown, true)

console.log('\nmalformed input')
check('unparseable JSON yields no components', parseWpComponents('not json', 'plugin'), [])
check('a bare object is not a list', parseWpComponents('{"name":"x"}', 'plugin'), [])
check('rows with no name are dropped',
  parseWpComponents('[{"name":"","status":"active"}]', 'plugin'), [])
check('unparseable drush yields nothing', parseDrushComponents('<html>', 'module'), [])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
