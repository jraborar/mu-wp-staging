// Checks for cleanJson() in lib/terminus.ts and parseWpJsonStrict() in lib/wordpress.ts —
// the WP-CLI/terminus output parsing the staging engine decides "are there updates?" on.
// No test runner: `npm run check:terminus` (Node strips the types).
//
// The case that forced this file: claybuck's `wp plugin list --update=available
// --context=admin` prefixes the payload with a PHP backtrace fragment that carries its
// own brackets. cleanJson locked onto that bracket, returned it instead of the JSON,
// the lenient parse turned the failure into `[]`, and the run reported "no plugin
// updates to apply" while 16 updates sat waiting — twice (mu-260820, mu-260915).
import { cleanJson } from '../lib/terminus.ts'
import { parseWpJsonStrict, parseWpJson } from '../lib/wordpress.ts'

let pass = 0, fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n         got ${a}\n         want ${e}`) }
}

const PAYLOAD = '[{"name":"akismet","status":"inactive","update":"available","version":"5.7","update_version":"5.7.2"}]'

console.log('\ncleanJson — the regression')
// Verbatim shape of the claybuck run: an unfiltered notice carrying a bracket pair,
// then the real payload. Pre-fix this returned '[/code/wp-includes/class-wp-hook.php:355]'.
check('backtrace fragment ahead of the payload is skipped',
  cleanJson(`Something odd happened [/code/wp-includes/class-wp-hook.php:355]\n${PAYLOAD}`),
  PAYLOAD)
check('bracket fragment mid-line, same line as payload',
  cleanJson(`notice [/code/wp-includes/class-wp-hook.php:355] ${PAYLOAD}`),
  PAYLOAD)
check('several junk bracket pairs before the payload',
  cleanJson(`[a:1] [b:2]\n[c:3]\n${PAYLOAD}`),
  PAYLOAD)

console.log('\ncleanJson — cases that already worked, and must keep working')
check('bare payload',                  cleanJson(PAYLOAD), PAYLOAD)
check('filtered [warning] line',       cleanJson(` [warning] There are no available updates for this site.\n${PAYLOAD}`), PAYLOAD)
check('filtered Warning: line',        cleanJson(`Warning: Use of undefined constant WP_CONTENT_DIR\n${PAYLOAD}`), PAYLOAD)
check('filtered Deprecated: line',     cleanJson(`Deprecated: Optional parameter declared before required\n${PAYLOAD}`), PAYLOAD)
check('trailing [notice] on same line', cleanJson(`${PAYLOAD} [notice] Command: claybuck.mu-260915 -- wp plugin list [Exit: 0]`), PAYLOAD)
// The original reason for balanced matching rather than a greedy regex.
check('terminus timestamp appended on the payload line',
  cleanJson(`${PAYLOAD}2026-08-05 10:44:31 UTC[+0000]`), PAYLOAD)
check('genuinely empty list survives', cleanJson(` [warning] nothing here\n[]`), '[]')
check('object payload',                cleanJson('Warning: x\n{"domain":"example.com"}'), '{"domain":"example.com"}')
check('object payload after junk brackets',
  cleanJson('frame [/code/foo.php:12]\n{"domain":"example.com"}'), '{"domain":"example.com"}')
check('no brackets at all → cleaned text', cleanJson('Success: The cache was flushed.'), 'Success: The cache was flushed.')
// Nothing parses: hand back the first span exactly as before, so the caller logs
// what terminus actually said instead of a silently different string.
check('nothing parseable → first span (unchanged behaviour)',
  cleanJson('frame [/code/wp-includes/class-wp-hook.php:355]'),
  '[/code/wp-includes/class-wp-hook.php:355]')
check('unbalanced payload → slice to end (unchanged behaviour)',
  cleanJson('[{"name":"akismet"'), '[{"name":"akismet"')

console.log('\nparseWpJsonStrict — a failed read is never an empty list')
check('valid array',        parseWpJsonStrict(PAYLOAD), JSON.parse(PAYLOAD))
check('empty array is []',  parseWpJsonStrict('[]'), [])
check('junk is null',       parseWpJsonStrict('[/code/wp-includes/class-wp-hook.php:355]'), null)
check('empty string null',  parseWpJsonStrict(''), null)
check('whitespace null',    parseWpJsonStrict('   \n '), null)
check('non-array JSON null', parseWpJsonStrict('{"a":1}'), null)
check('truncated null',     parseWpJsonStrict('[{"name":"akismet"'), null)
// The contrast that matters: the lenient parser reports the same [] for both.
check('lenient parser conflates junk with empty', parseWpJson('[/code/foo.php:355]'), [])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
