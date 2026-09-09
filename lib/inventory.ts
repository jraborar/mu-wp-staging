import { run, cleanJson } from '@/lib/terminus'
import { isDropsUpdateMode } from '@/lib/platform'
import {
  parseWpComponents, parseDrushComponents, parseCoreUpdate, collapseByProject,
  type Component, type ComponentKind,
} from '@/lib/inventoryParse'
import type { UpdateMode } from '@/lib/sites'

export type { Component, ComponentKind }

/**
 * A site's installed components, with what version is running and what is
 * available — the shape `wp plugin list` gives you.
 *
 * `/api/site-plugins` already listed components, but name and title only: it
 * exists to fill the exclusion picker, which needs nothing more. The per-site
 * console in mu-pmu-tool wants the whole inventory. Rather than widen that
 * endpoint and change the picker's list, the listing moved here and both
 * callers project from it.
 *
 * WHY THIS LIVES IN mu-staging: it needs a Terminus login and a remote WP-CLI
 * or drush call against a customer's live environment. mu-pmu-tool runs no
 * engines and holds no Pantheon token, so it reads this over HTTP.
 *
 * COST, measured against apexorderpickup.live: ~13 seconds per remote call.
 * The three WordPress calls run in parallel, so an inventory is ~15s including
 * the login. NOTHING SHOULD BLOCK A PAGE RENDER ON IT — the legacy PMU
 * dashboard said "Data last refreshed 11 hours ago" for exactly this reason.
 *
 * The pure parsing is in lib/inventoryParse.ts so `npm run check:inventory`
 * can exercise it against captured output without a Pantheon credential.
 */

export interface Inventory {
  components: Component[]
  /** Core / upstream update, when `wp core check-update` reports one. */
  core: { version: string; available: string } | null
  /**
   * Set when components are managed by Composer rather than by this tool.
   *
   * These sites ARE still inventoried — drush answers the same on them. The
   * flag says where an UPGRADE comes from (a Composer run and a pull request),
   * not whether the list is available.
   */
  composerManaged: boolean
  /** Which mechanism produced the list, so the reader can judge it. */
  source: 'wp-cli' | 'drush' | 'none'
  fetchedAt: string
}

const base = (source: Inventory['source'], composerManaged = false): Inventory => ({
  components: [], core: null, composerManaged, source, fetchedAt: new Date().toISOString(),
})

export async function listInventory(
  site: string,
  platform: string | null,
  updateMode: UpdateMode | null,
): Promise<Inventory> {
  const token = process.env.TERMINUS_TOKEN
  if (token) await run(`terminus auth:login --machine-token="${token}" 2>&1`)

  if (platform === 'drupal') {
    // Integrated-Composer sites are listed TOO, which they were not at first.
    //
    // The original reasoning conflated two things: exclusions on an IC site are
    // Composer's business, so /api/site-plugins rightly declines to offer them.
    // But an INVENTORY is a read, and drush answers it identically on IC and
    // drops — verified against baseball-hall-of-fame (167 modules) and hfu
    // (243), both Integrated Composer. Returning an empty list told the reader
    // "nothing to see" when the truth was "nobody asked".
    //
    // `composerManaged` still travels, so the console can say updates come
    // through a Composer run and a pull request rather than from here.
    const composerManaged = !isDropsUpdateMode(updateMode)
    const [mod, theme] = await Promise.all([
      run(`terminus drush ${site}.live -- pm-list --type=module --no-core --format=json 2>&1`),
      run(`terminus drush ${site}.live -- pm-list --type=theme --format=json 2>&1`),
    ])
    return {
      ...base('drush', composerManaged),
      // One row per project, not per module. See collapseByProject.
      components: collapseByProject([
        ...parseDrushComponents(cleanJson(mod.stdout), 'module'),
        ...parseDrushComponents(cleanJson(theme.stdout), 'theme'),
      ]),
    }
  }

  const FIELDS = 'name,title,status,version,update,update_version'
  const [plugins, themes, core] = await Promise.all([
    run(`terminus wp ${site}.live -- plugin list --format=json --fields=${FIELDS} 2>&1`),
    run(`terminus wp ${site}.live -- theme list --format=json --fields=${FIELDS} 2>&1`),
    run(`terminus wp ${site}.live -- core check-update --format=json 2>&1`),
  ])

  return {
    ...base('wp-cli'),
    components: [
      ...parseWpComponents(cleanJson(plugins.stdout), 'plugin'),
      ...parseWpComponents(cleanJson(themes.stdout), 'theme'),
    ],
    // check-update does not report the installed version and nothing else in
    // these three calls carries it, so it is left unknown rather than guessed.
    core: parseCoreUpdate(cleanJson(core.stdout), null),
  }
}
