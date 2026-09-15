// Checks for the VRT wait budget in lib/vrt.ts — how long staging waits for mu-vrt's
// baseline before giving up on the comparison.
// No test runner: `npm run check:vrt` (Node strips the types).
//
// The case that forced this file: the budget was inferred from `run.results.length`,
// which mu-vrt leaves EMPTY for the whole duration of a baseline (it writes the results
// in the same call that flips the status to 'awaiting_candidate'). So the per-path budget
// never applied to the baseline wait and it silently stayed on the 2-minute floor.
// claybuck (10 paths → 20 sequential captures) timed out at 121.9s and its run was left
// parked at 'awaiting_candidate' for good, with no comparison ever run.
import { budgetFor, VRT_WAIT_CONSTANTS as C } from '../lib/vrt.ts'

let pass = 0, fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n         got ${a}\n         want ${e}`) }
}
const secs = (ms: number) => Math.round(ms / 1000)

console.log('\nbudgetFor — baseline (45s/path)')
const B = C.BASELINE_MS_PER_PATH
check('unknown path count → 2min floor',  secs(budgetFor(0, B)), 120)
check('negative → 2min floor',            secs(budgetFor(-1, B)), 120)
check('1 path → floor (45s < 120s)',      secs(budgetFor(1, B)), 120)
check('2 paths → floor (90s < 120s)',     secs(budgetFor(2, B)), 120)
check('3 paths → 135s, above the floor',  secs(budgetFor(3, B)), 135)
// claybuck: 10 configured paths. The run that broke gave up at 121.9s; this is the
// budget it should have had.
check('claybuck 10 paths → 450s',         secs(budgetFor(10, B)), 450)
// apexorderpickup, the run that prompted the per-path budget in the first place.
check('apexorderpickup 13 paths → 585s',  secs(budgetFor(13, B)), 585)
check('26 paths → 1170s, just under the cap', secs(budgetFor(26, B)), 1170)
check('27 paths → 20min ceiling',         secs(budgetFor(27, B)), 1200)
check('MAX_VRT_PATHS 70 → 20min ceiling', secs(budgetFor(70, B)), 1200)

console.log('\nbudgetFor — compare (60s/path)')
const M = C.COMPARE_MS_PER_PATH
check('unknown → floor',      secs(budgetFor(0, M)), 120)
check('10 paths → 600s',      secs(budgetFor(10, M)), 600)
check('20 paths → 20min cap', secs(budgetFor(20, M)), 1200)

console.log('\nthe regression, stated as arithmetic')
// What the baseline wait actually used before the fix, for every site, regardless of size.
check('pre-fix effective baseline wait was always the floor', secs(C.MIN_WAIT_MS), 120)
// claybuck's baseline needed longer than that: the compare phase started 2m43s into
// the baseline and the wait expired 4m45s in, still short of 20 captures.
check('claybuck budget now exceeds the floor', budgetFor(10, B) > C.MIN_WAIT_MS, true)
check('budget never below the floor', [0, 1, 2, 3, 10, 70].every(p => budgetFor(p, B) >= C.MIN_WAIT_MS), true)
check('budget never above the ceiling', [0, 1, 10, 70, 1000].every(p => budgetFor(p, B) <= C.MAX_WAIT_MS), true)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
