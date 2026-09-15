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

console.log('\ncleanJson — junk that PARSES (the second regression)')
// The gap that let the first fix through: every junk fixture above is unparseable, so
// "first span that parses" looked sufficient. claybuck's mu-260915 re-run then emitted a
// bare "[0]" ahead of the payload — valid JSON — and it was returned as the list, read
// as one plugin against an actual 16. Shape, not just syntax.
check('bare [0] ahead of payload is skipped',   cleanJson(`[0]\n${PAYLOAD}`), PAYLOAD)
check('[0] mid-line, same line as payload',     cleanJson(`menu[0] ${PAYLOAD}`), PAYLOAD)
check('scalar array [1,2] skipped',             cleanJson(`[1,2]\n${PAYLOAD}`), PAYLOAD)
check('string array ["x"] skipped',             cleanJson(`["x"]\n${PAYLOAD}`), PAYLOAD)
check('null array [null] skipped',              cleanJson(`[null]\n${PAYLOAD}`), PAYLOAD)
check('nested array [[]] skipped',              cleanJson(`[[]]\n${PAYLOAD}`), PAYLOAD)
check('bare number in braces is not an object', cleanJson(`[0] [1]\n${PAYLOAD}`), PAYLOAD)
// An empty array IS a legitimate payload, so it must still win over later junk.
check('genuine [] beats trailing scalar junk',  cleanJson('[]\n[0]'), '[]')
// But an empty array must NEVER shadow a real payload found later — that is the
// original bug wearing a different hat: "[]" read as "no updates available".
check('stray [] does not shadow the payload',   cleanJson(`notice [] here\n${PAYLOAD}`), PAYLOAD)
check('stray {} does not shadow the payload',   cleanJson(`notice {} here\n${PAYLOAD}`), PAYLOAD)
check('stray {} does not shadow an object',     cleanJson('noise {}\n{"php_version":"8.3"}'), '{"php_version":"8.3"}')
check('empty payload still wins when alone',    cleanJson('noise []'), '[]')
// Object payloads (env:info, site:info) still resolve, and a scalar array before one
// must not shadow it.
check('[0] before an object payload',           cleanJson('[0]\n{"php_version":"7.4"}'), '{"php_version":"7.4"}')
check('object payload with nested array',       cleanJson('[0]\n{"paths":["/","/about"]}'), '{"paths":["/","/about"]}')
// Nothing payload-shaped at all: fall back to the first span that parsed, so the caller
// still logs something real rather than a silently different string.
check('only scalar arrays → first parsed span', cleanJson('noise [0] more [1]'), '[0]')

console.log('\nparseWpJsonStrict — a failed read is never an empty list')
check('valid array',        parseWpJsonStrict(PAYLOAD), JSON.parse(PAYLOAD))
check('empty array is []',  parseWpJsonStrict('[]'), [])
check('junk is null',       parseWpJsonStrict('[/code/wp-includes/class-wp-hook.php:355]'), null)
check('empty string null',  parseWpJsonStrict(''), null)
check('whitespace null',    parseWpJsonStrict('   \n '), null)
check('non-array JSON null', parseWpJsonStrict('{"a":1}'), null)
check('truncated null',     parseWpJsonStrict('[{"name":"akismet"'), null)
// Second layer for the parseable-junk case: even if cleanJson hands back something that
// parses, an array of scalars is a broken read and must fail closed here rather than
// become a phantom one-item list.
check('[0] is null, not a 1-item list', parseWpJsonStrict('[0]'), null)
check('[1,2] is null',      parseWpJsonStrict('[1,2]'), null)
check('["x"] is null',      parseWpJsonStrict('["x"]'), null)
check('[null] is null',     parseWpJsonStrict('[null]'), null)
check('[[]] is null',       parseWpJsonStrict('[[]]'), null)
check('mixed records+scalar is null', parseWpJsonStrict('[{"name":"akismet"},0]'), null)
// The contrast that matters: the lenient parser reports the same [] for both.
check('lenient parser conflates junk with empty', parseWpJson('[/code/foo.php:355]'), [])
// And the lenient parser happily returns the phantom list that caused this.
check('lenient parser returns the phantom [0]', parseWpJson('[0]'), [0])

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
