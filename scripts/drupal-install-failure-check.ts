// Checks for the Composer install-failure classifier and the missing-.git repair in
// lib/composerErrors.ts. No test runner: `npm run check:drupal-install` (Node strips
// the types).
//
// These exist because inst (Instructure) lost a full staging run on 2026-09-16 to a
// misdiagnosis: Composer resolved ~40 updates perfectly, then failed while INSTALLING
// drupal/field_tools (dev-1.x, source-installed, no .git in the committed-vendor tree).
// The old code ran every non-zero exit through the solver-conflict parser, found nothing,
// and reported "could not resolve" — pointing at a dependency conflict that never existed.
//
// The fixtures below are real composer output, junk lines and all. A parser that only ever
// sees tidy input is not evidence it handles the payload it will actually be given.
import { mkdtemp, mkdir, writeFile, stat, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseInstallFailure, parsePatchFailure, repairMissingGitDir } from '../lib/composerErrors.ts'

let pass = 0, fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = String(actual), e = String(expected)
  if (a === e) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n         got ${a}\n         want ${e}`) }
}
function checkMatch(name: string, actual: string | null, re: RegExp) {
  if (actual && re.test(actual)) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n         got ${String(actual)}\n         want match ${re}`) }
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────
// Verbatim tail of the failed inst run (staging_history 1335bb4a).
const INST_MISSING_GIT = `
  - Upgrading drupal/webform (6.3.0-beta9 => 6.3.0): Extracting archive
  - Upgrading drush/drush (13.7.3 => 13.8.0): Extracting archive
  - Upgrading drupal/field_tools (dev-1.x 16b0b93 => dev-1.x dfe6400):
Update of drupal/field_tools failed
In GitDownloader.php line 155:
The .git directory is missing from docroot/modules/contrib/field_tools, see
https://getcomposer.org/commit-deps for more information
update [--with WITH] [--prefer-source] [--prefer-dist] [--dry-run] [--dev] [--no-dev]
`.trim()

// A genuine solver failure — must NOT be classified as an install failure, or the
// auto-skip retry loop never gets the chance to strip the blocker.
const SOLVE_CONFLICT = `
Loading composer repositories with package information
Updating dependencies
Your requirements could not be resolved to an installable set of packages.
  Problem 1
    - Root composer.json requires drupal/micro_site ^2.0 -> satisfiable by drupal/micro_site[2.0.0].
    - drupal/micro_site 2.0.0 requires drupal/core ^10 -> found drupal/core[11.4.6] but it does not match.
`.trim()

// Clean success output — nothing to classify.
const CLEAN = `
Lock file operations: 0 installs, 3 updates, 0 removals
  - Upgrading drupal/core (11.4.4 => 11.4.6)
Generating autoload files
`.trim()

console.log('parseInstallFailure')
checkMatch('missing .git → names the package and the path',
  parseInstallFailure(INST_MISSING_GIT), /drupal\/field_tools[\s\S]*docroot\/modules\/contrib\/field_tools/)
checkMatch('missing .git → says the solve succeeded, so nobody hunts a phantom conflict',
  parseInstallFailure(INST_MISSING_GIT), /solve itself\s+succeeded|solve itself succeeded/)
check('solver conflict → null (leave it to the auto-skip loop)', parseInstallFailure(SOLVE_CONFLICT), 'null')
check('clean output → null', parseInstallFailure(CLEAN), 'null')
check('empty output → null', parseInstallFailure(''), 'null')
checkMatch('generic install failure is still classified',
  parseInstallFailure('Update of drupal/foo failed\nsomething went wrong'), /failed while installing drupal\/foo/)

// Verbatim from the inst re-run (staging_history 78f37acd). Note that patches applied
// SUCCESSFULLY for drupal/core earlier in the same output — the parser must attribute the
// failure to paragraphs, the last package announced before it, not to core.
const INST_PATCH_FAILURE = `
  - Applying patches for drupal/core
    https://www.drupal.org/files/issues/2024-06-21/3171835-89--D10.3.x.patch (Field Groups marked as required are missing red asterisk)
    https://www.drupal.org/files/issues/2025-01-05/3409549-34_0.patch (Twig runtime error patch)
Gathering patches for root package.
Removing package drupal/paragraphs so that it can be re-installed and re-patched.
  - Upgrading drupal/paragraphs (1.20.0 => 1.23.0): Extracting archive
  - Applying patches for drupal/paragraphs
    https://www.drupal.org/files/issues/2020-07-08/access-controll-issue-3090200-22.patch (Paragraphs do not render: access check for view)
   Could not apply patch! Skipping. The error was: Cannot apply patch https://www.drupal.org/files/issues/2020-07-08/access-controll-issue-3090200-22.patch
In Patches.php line 331:
Cannot apply patch Paragraphs do not render: access check for view (https://www.drupal.org/files/issues/2020-07-08/access-controll-issue-3090200-22.patch)!
`.trim()

// Patches that apply cleanly must not be mistaken for a failure.
const PATCHES_OK = `
  - Applying patches for drush/drush
    ./patches/drush-batch-service-method-callbacks.patch (Resolve Drupal 11.4+ service:method batch callbacks)
Generating autoload files
`.trim()

console.log('\nparsePatchFailure')
check('attributes the failure to paragraphs, not the earlier core patch block',
  parsePatchFailure(INST_PATCH_FAILURE)?.pkg, 'drupal/paragraphs')
check('captures the patch URL',
  parsePatchFailure(INST_PATCH_FAILURE)?.patch,
  'https://www.drupal.org/files/issues/2020-07-08/access-controll-issue-3090200-22.patch')
check('captures the human title',
  parsePatchFailure(INST_PATCH_FAILURE)?.title, 'Paragraphs do not render: access check for view')
check('successful patching → null', parsePatchFailure(PATCHES_OK), 'null')
check('solver conflict → null', parsePatchFailure(SOLVE_CONFLICT), 'null')
check('missing-.git failure is NOT a patch failure', parsePatchFailure(INST_MISSING_GIT), 'null')
check('empty output → null', parsePatchFailure(''), 'null')
// A failure with no owning "Applying patches for" line cannot be attributed, and guessing
// the package from the issue URL would hold back the wrong module.
check('unattributable failure → null rather than a guess',
  parsePatchFailure('In Patches.php line 331:\nCannot apply patch Something (http://x/y.patch)!'), 'null')
check('local .patch path is captured too',
  parsePatchFailure('- Applying patches for drush/drush\nCould not apply patch! Skipping. The error was: Cannot apply patch ./patches/foo.patch')?.patch,
  './patches/foo.patch')

console.log('\nrepairMissingGitDir')
const workdir = await mkdtemp(join(tmpdir(), 'drupal-check-'))
const victim = join(workdir, 'docroot/modules/contrib/field_tools')
await mkdir(victim, { recursive: true })
await writeFile(join(victim, 'field_tools.info.yml'), 'name: Field tools\n')

check('returns the path it repaired',
  await repairMissingGitDir(INST_MISSING_GIT, workdir), 'docroot/modules/contrib/field_tools')
check('the stale directory is actually gone',
  await stat(victim).then(() => 'present').catch(() => 'gone'), 'gone')
check('parent tree survives',
  await stat(join(workdir, 'docroot/modules/contrib')).then(() => 'present').catch(() => 'gone'), 'present')

check('solver conflict → null, nothing to repair', await repairMissingGitDir(SOLVE_CONFLICT, workdir), 'null')

// The path is read out of composer's stdout, so it is untrusted input. A traversal must
// never delete anything outside this job's throwaway clone.
const outside = await mkdtemp(join(tmpdir(), 'drupal-outside-'))
await writeFile(join(outside, 'keepme'), 'x')
const traversal = `In GitDownloader.php line 155:\nThe .git directory is missing from ../${outside.split('/').pop()}, see`
check('traversal outside the workdir → refused', await repairMissingGitDir(traversal, workdir), 'null')
check('the outside directory is untouched',
  await stat(join(outside, 'keepme')).then(() => 'present').catch(() => 'gone'), 'present')

const absTraversal = `In GitDownloader.php line 155:\nThe .git directory is missing from /etc, see`
check('absolute path outside the workdir → refused', await repairMissingGitDir(absTraversal, workdir), 'null')

const selfRef = `In GitDownloader.php line 155:\nThe .git directory is missing from ., see`
check('the workdir itself → refused (never nuke the clone)', await repairMissingGitDir(selfRef, workdir), 'null')
check('workdir still exists', await stat(workdir).then(() => 'present').catch(() => 'gone'), 'present')

await rm(workdir, { recursive: true, force: true })
await rm(outside, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
