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

/**
 * Decide whether an existing multidev can be reused instead of deleted and rebuilt.
 *
 * Rebuilding a multidev costs ~10-11 minutes (measured on inst: 9m47s and 10m55s on two
 * consecutive runs, roughly 60% of each run's total). The whole Composer update it exists
 * to serve takes under 4. On a retry that rebuild is usually pure waste, because the only
 * `git push` in the pipeline happens AFTER both Composer phases — so a run that fails
 * while resolving never wrote a byte to the multidev, and the environment still holds
 * exactly what it held when it was created.
 *
 * The safe test is whether the multidev branch tip is still identical to master's tip.
 * Our push always lands our commits at the tip, so equality proves nothing of ours was
 * pushed. Inherited history does not fool it: once a staging run reaches live, master's
 * own history contains "MU Staging" commits too, which is exactly why this compares SHAs
 * rather than looking for our author.
 *
 * FAILS CLOSED, deliberately. Reuse requires positive proof of two resolvable, equal
 * SHAs. Anything else — a failed command, an unparseable ref list, a missing ref, or a
 * multidev that Pantheon branched from live's deployed commit rather than master's tip —
 * returns false and the caller rebuilds exactly as it does today. The worst case is
 * losing the optimization; it can never be reusing a dirty environment. That matters
 * because a wrongly-reused multidev would stage on top of a previous run's updates and
 * feed a deploy.
 *
 * @param refs output of `git ls-remote <url> refs/heads/<multidev> refs/heads/master`
 */
export function canReuseMultidev(refs: string, multidev: string): boolean {
  const sha = (ref: string): string | null => {
    for (const line of refs.split('\n')) {
      const m = line.trim().match(/^([0-9a-f]{40})\s+(\S+)$/i)
      if (m && m[2] === ref) return m[1].toLowerCase()
    }
    return null
  }
  const mdSha = sha(`refs/heads/${multidev}`)
  const masterSha = sha('refs/heads/master')
  if (!mdSha || !masterSha) return false
  return mdSha === masterSha
}

export interface PatchFailure {
  /** The package whose patch could not be applied, e.g. "drupal/paragraphs". */
  pkg: string
  /** The patch URL or local path composer was told to apply. */
  patch: string
  /** The human label from composer.json's patches block, when it printed one. */
  title: string | null
}

// Detect a cweagans/composer-patches failure and name the package it belongs to.
//
// A pinned patch is written against one release. When the package moves, the patch
// stops applying — and with `composer-exit-on-patch-failure` set (as Pantheon's Drupal
// templates ship it) composer exits non-zero even though it printed "Skipping":
//
//     - Applying patches for drupal/paragraphs
//       https://www.drupal.org/files/issues/2020-07-08/access-controll-issue-3090200-22.patch
//       Could not apply patch! Skipping. The error was: Cannot apply patch <url>
//     In Patches.php line 331:
//     Cannot apply patch Paragraphs do not render: access check for view (<url>)!
//
// This is neither a solve failure nor a download failure: the solve was fine and the
// archive arrived. The package simply cannot move while carrying that patch. So the
// caller holds it at its locked version and updates everything else, rather than losing
// the whole run to one stale patch — which is what happened to inst, where a 2020 patch
// against paragraphs 1.20.0 blocked the 1.23.0 upgrade and ~40 unrelated updates with it.
//
// Composer prints the owning package in an earlier "Applying patches for X" line, so we
// take the LAST such line before the failure rather than guessing from the patch URL
// (the URL names a drupal.org issue, not reliably the package).
export function parsePatchFailure(output: string): PatchFailure | null {
  const lines = output.split('\n')
  const failIdx = lines.findIndex(l => /Cannot apply patch|Could not apply patch/i.test(l))
  if (failIdx === -1) return null

  let pkg: string | null = null
  for (let i = failIdx; i >= 0; i--) {
    const m = lines[i].match(/Applying patches for (\S+)/i)
    if (m) { pkg = m[1]; break }
  }
  if (!pkg) return null

  // The URL may appear on the failure line, or on the preceding line that announced the
  // patch (composer wraps long lines, so prefer a whole URL wherever one survives).
  const window = lines.slice(Math.max(0, failIdx - 3), failIdx + 3).join('\n')
  const patch = window.match(/(https?:\/\/\S+?\.patch|\.?\/?[\w./-]+\.patch)/)?.[1] ?? 'the pinned patch'
  const title = lines.slice(Math.max(0, failIdx - 3), failIdx + 3)
    .map(l => l.match(/Cannot apply patch (.+?) \(https?:/)?.[1])
    .find(Boolean) ?? null

  return { pkg, patch, title }
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
