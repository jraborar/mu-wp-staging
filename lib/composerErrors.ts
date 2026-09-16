// Classifying and repairing Composer failures.
//
// Deliberately dependency-free (node builtins only, no `@/` aliases) so the check script
// can import it under bare Node — see scripts/drupal-install-failure-check.ts.

import { rm } from 'fs/promises'
import { resolve as resolvePath, sep as pathSep } from 'path'

// Distinguish a DOWNLOAD/INSTALL failure from a failed SOLVE.
//
// Composer exits non-zero for both, but they are different problems with different
// fixes, and only the solve failure can be helped by stripping blockers and retrying.
// The caller used to treat every non-zero exit as a failed solve: parseConflictingPackages
// found nothing in a downloader's output, so the retry loop had nothing to strip and the
// run died reporting "could not resolve" — blaming the solver for something it did
// correctly, and sending whoever read the log looking for a dependency conflict that was
// never there. inst lost a whole run to that misdiagnosis.
//
// Returns an operator-facing explanation, or null when this is a genuine solve failure.
export function parseInstallFailure(output: string): string | null {
  const missingGit = output.match(/The \.git directory is missing from (\S+)/i)
  if (missingGit) {
    const pkg = output.match(/Update of (\S+) failed/i)?.[1] ?? 'a package'
    return `Composer tried to update ${pkg} from git source, but ${missingGit[1]} has no .git directory. `
      + 'That is the signature of a source-installed package on a committed-vendor site: the built tree '
      + 'is committed into the site repo, which cannot carry a nested .git. The dependency solve itself '
      + 'succeeded — this failed while installing. We normally repair this by removing the directory and '
      + 'letting Composer reinstall it; that repair did not resolve it here.'
  }
  const failedPkg = output.match(/Update of (\S+) failed/i)
  if (failedPkg) {
    return `Composer resolved the updates but failed while installing ${failedPkg[1]} — see the log above. `
      + 'This is a download/install failure, not a dependency conflict, so skipping blockers cannot help.'
  }
  return null
}

// Repair the "missing .git" install failure by deleting the stale directory.
//
// --prefer-dist does NOT save us here, and it is worth being precise about why: drupal.org
// publishes dist archives for TAGGED releases only. A dev branch (dev-1.x, dev-main) has no
// `dist` key at all in packages.drupal.org metadata — only `source: git`. --prefer-dist is a
// preference, so Composer silently falls back to source and GitDownloader runs anyway. Any
// committed-vendor site with a dev-branch contrib module lands here no matter what flags we
// pass. (Verified against the live metadata for drupal/field_tools: dev-1.x has source and
// no dist; 1.0.0-alpha14 and every other tag has dist: zip.)
//
// What DOES work is removing the directory. With nothing on disk Composer performs a fresh
// install rather than an update, so it never consults the absent .git. The tree it writes is
// identical; only the code path differs. stripNestedGitDirs() then removes the .git the
// clone leaves behind, before the tree is committed.
//
// Returns the repaired path, or null when this output is not a missing-.git failure.
export async function repairMissingGitDir(output: string, workdir: string): Promise<string | null> {
  const m = output.match(/The \.git directory is missing from (\S+)/i)
  if (!m) return null

  const rel = m[1].replace(/[.,:;]+$/, '')
  // The path comes out of composer's stdout, so treat it as untrusted: only ever delete
  // something that resolves strictly inside this job's throwaway clone.
  const root = resolvePath(workdir)
  const abs = resolvePath(root, rel)
  if (abs === root || !abs.startsWith(root + pathSep)) return null

  await rm(abs, { recursive: true, force: true })
  return rel
}
