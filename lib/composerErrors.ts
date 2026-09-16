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

  // Take the patch from the FAILURE LINE ITSELF, never from a window around it.
  //
  // This used to scan lines failIdx-3..failIdx+3 for anything ending in .patch, and preferred
  // an http URL over a local path. When composer applies patches for several packages in a
  // row, the lines just above a failure belong to the PREVIOUS package — so on inst run
  // 78dc274c, drush/drush was correctly identified as the failing package but reported
  // against paragraphs' patch URL, which had been printed three lines earlier:
  //
  //     - Applying patches for drupal/paragraphs
  //       https://www.drupal.org/files/issues/...-3090200-22.patch   <- picked this
  //     - Applying patches for drush/drush
  //       ./patches/drush-batch-service-method-callbacks.patch       <- meant this
  //      Could not apply patch! Skipping. The error was: Cannot apply patch ./patches/...
  //
  // The consultant then reads a hold on drush justified by a Paragraphs patch. Composer names
  // the patch on the failure line, so use that and nothing else.
  const failLine = lines[failIdx]
  const patch =
    failLine.match(/(?:The error was:\s*)?Cannot apply patch\s+(\S+\.patch|\S+\.diff|https?:\/\/\S+)/i)?.[1]
    // The "In Patches.php" form puts the human title first and the patch in parentheses.
    ?? lines.slice(failIdx, failIdx + 4).join('\n').match(/Cannot apply patch .+? \((\S+?)\)!/)?.[1]
    ?? 'the pinned patch'

  // Same rule for the title: only from a line that actually names this failure. Composer
  // wraps long lines, so allow the patch in parentheses to be any token, not just a URL —
  // drush's is a local ./patches/... path, which the old URL-only pattern never matched,
  // silently falling back to the (wrong) patch string.
  const title = lines.slice(failIdx, failIdx + 4)
    .map(l => l.match(/Cannot apply patch (.+?) \(\S/)?.[1])
    .find(t => t && !/^\S+\.(patch|diff)$/i.test(t)) ?? null

  return { pkg, patch, title }
}

/**
 * Say WHY the solver rejected a package, instead of asserting a cause we never checked.
 *
 * The auto-skip loop hard-coded "no Drupal <N> compatible release" for every package it
 * stripped. That is one possible cause, not the only one, and on inst run 063b77c6 it was
 * wrong three times over: paragraphs_asymmetric_translation_widgets, dismissible_message_bar
 * and paragraphs_browser were all reported as lacking a Drupal 11 release when in fact they
 * depend on drupal/paragraphs, which the solver had refused because of a security advisory.
 * A consultant reading that summary would go looking for D11 ports that were never the
 * problem.
 *
 * Returns a short clause for the skip reason. Falls back to a neutral statement rather than
 * a guess when the output does not say — an unexplained skip is honest; a wrong explanation
 * is worse than none.
 */
export function explainBlocker(output: string, pkg: string, coreMajor: number): string {
  // Composer groups each rejection under "Problem N"; find the block naming this package.
  const block = output
    .split(/Problem \d+/)
    .find(b => b.includes(pkg)) ?? output

  if (/affected by security advisor/i.test(block)) {
    const ids = [...block.matchAll(/(SA-(?:CONTRIB|CORE)-\d{4}-\d+|CVE-\d{4}-\d+)/g)]
      .map(m => m[1])
    const uniq = [...new Set(ids)]
    return uniq.length
      ? `a dependency is blocked by security advisories (${uniq.join(', ')})`
      : 'a dependency is blocked by a security advisory'
  }
  if (new RegExp(`drupal/core[^\\n]*but it does not match|requires drupal/core`, 'i').test(block)) {
    return `no Drupal ${coreMajor} compatible release`
  }
  return 'it could not be resolved alongside the rest of this update'
}

/**
 * Advisory IDs affecting a package, from `composer audit --locked --format=json`.
 *
 * Answers one question before holding a package back: is the version we would hold it at
 * known-vulnerable? Holding is right when a stale patch blocks an ordinary update, and wrong
 * when the held version is vulnerable — then the update being declined IS the security fix.
 *
 * TRI-STATE, and the `null` case is the whole point:
 *
 *   string[] (non-empty) — vulnerable. Refuse to hold.
 *   []                   — audit read successfully, package is clean. Safe to hold.
 *   null                 — the audit could not be read. NOT a synonym for clean.
 *
 * The first version of this returned [] for both "clean" and "unreadable", reasoning that an
 * unknown result should not halt every run. That is fail-OPEN, and it defeated the guard on
 * the very case it was written for: inst run 78dc274c held drupal/paragraphs at 1.20.0 and
 * completed, even though the end-of-run audit in the same run reported SA-CONTRIB-2026-060
 * and -061 against that exact version. The check was silent and the vulnerable version was
 * staged for deploy.
 *
 * A security gate that cannot complete its check has not passed it. Callers must treat null
 * as blocking, the same as a hit — this repo's rule is that safety checks fail closed.
 *
 * "Readable" means the payload actually looks like a composer audit result: a parsed object
 * carrying an `advisories` key. Anything else — a warning that happens to parse, an error
 * blob, an empty string — is null, not []. Shape, not just syntax.
 */
export function advisoriesFor(auditJson: string, pkg: string): string[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(auditJson) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const advisories = (parsed as { advisories?: unknown }).advisories
  // A composer audit result always carries `advisories`, even when empty. Its absence means
  // we are looking at something else, and "something else" is not evidence of safety.
  if (!advisories || typeof advisories !== 'object' || Array.isArray(advisories)) return null

  const items = (advisories as Record<string, unknown>)[pkg]
  if (items === undefined) return []          // audit read, package not listed → clean
  if (!Array.isArray(items)) return null      // listed but in a shape we do not understand

  return items
    .map(it => {
      const o = it as Record<string, string> | null
      return o?.advisoryId || o?.cve || null
    })
    .filter((id): id is string => Boolean(id))
}

/**
 * Hold a package at an exact version in a working composer.json.
 *
 * Deleting a package from `require` drops the ROOT CONSTRAINT; it does not hold a version.
 * Anything else in the graph that requires the package still pulls it, Composer re-resolves
 * it to the same new release, and a cweagans patch keyed on it fails all over again —
 * `extra.patches` is independent of `require`. inst run f3be3b27 proved it: paragraphs was
 * dropped from require, `drupal/paragraphs_browser` 1.4.0 requires `"drupal/paragraphs": "*"`,
 * so Composer installed 1.23.0 a second time and the same patch failed a second time.
 *
 * An exact constraint is what actually holds it. When the package was only ever transitive
 * this ADDS a root requirement, which is the normal Composer way to pin a dependency.
 *
 * Mutates `cjson` and returns the section written, so callers can log it.
 */
export function pinPackage(
  cjson: Record<string, Record<string, string> | unknown>,
  pkg: string,
  version: string,
): 'require' | 'require-dev' {
  const dev = cjson['require-dev'] as Record<string, string> | undefined
  const section: 'require' | 'require-dev' = dev?.[pkg] ? 'require-dev' : 'require'
  const bucket = (cjson[section] ?? {}) as Record<string, string>
  bucket[pkg] = version
  cjson[section] = bucket
  return section
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
