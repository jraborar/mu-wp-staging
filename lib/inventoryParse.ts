// Pure parsing for a site's component inventory.
//
// Split from lib/inventory.ts for the same reason lib/platform.ts is kept free
// of I/O: `npm run check:inventory` runs this file directly under Node's type
// stripping, which cannot resolve the `@/` alias or load lib/terminus.ts. So
// this half has NO imports at all — including no parseWpJson from
// lib/wordpress.ts, whose three lines are reproduced as asArray() below. The
// dependency, not the duplication, is what would make it untestable.
//
// Everything here takes a string ALREADY passed through cleanJson(), because
// that lives in lib/terminus.ts. lib/inventory.ts applies it.

export type ComponentKind = 'plugin' | 'theme' | 'module'

export interface Component {
  name: string
  title: string
  kind: ComponentKind
  /** active | inactive | must-use | dropin | parent | Enabled | Disabled */
  status: string
  version: string | null
  /** The version available, when one is. */
  available: string | null
  /** Whether an update is waiting. */
  updateAvailable: boolean
  /**
   * True when this component cannot report update state at all — must-use
   * plugins, drop-ins, and every drush-listed Drupal module. Distinct from "no
   * update available", and the console has to say which rather than showing a
   * reassuring dash.
   */
  updateUnknown: boolean
  /**
   * Drupal only: the PROJECT this module belongs to.
   *
   * Drupal ships many modules per project — admin_toolbar alone contributes
   * four, all at the same version. Updates happen per project, not per module,
   * so a reader wants the project list; 243 module rows for one site is not an
   * inventory anyone reads. Left undefined for WordPress, where the plugin IS
   * the unit.
   */
  project?: string
  /**
   * Drupal only: true when the module lives outside modules/contrib — a custom
   * module, which has no update channel at all and must not be counted as
   * contrib that happens to be current.
   */
  custom?: boolean
}

/** WP-CLI plugin/theme list row, with the fields lib/inventory.ts requests. */
export interface WpRow {
  name: string
  title?: string
  status: string
  version?: string
  /**
   * "none" | "available" for ordinary plugins — but the BOOLEAN `false` for
   * must-use plugins and drop-ins. One field, two JSON types in one response.
   * Verified against apexorderpickup.live: `wp-native-php-sessions`,
   * `loader` and `object-cache.php` all answer `false`.
   */
  update?: string | boolean
  update_version?: string
}

function asArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

/**
 * A WP-CLI status with no update channel.
 *
 * must-use plugins and drop-ins are files WordPress loads unconditionally. They
 * have no update mechanism, which is why WP-CLI answers `false` rather than
 * "none" — the absence of an update is not the same as being current.
 */
const NO_UPDATE_CHANNEL = new Set(['must-use', 'dropin'])

export function toComponent(r: WpRow, kind: ComponentKind): Component {
  return {
    name: r.name,
    // `object-cache.php` comes back with an empty title, so fall back to the
    // slug rather than rendering a nameless row.
    title: r.title?.trim() || r.name,
    kind,
    status: r.status,
    version: r.version?.trim() || null,
    available: r.update_version?.trim() || null,
    // Only the exact string counts. `update === true` never occurs, and testing
    // truthiness would mark every "none" as available.
    updateAvailable: r.update === 'available',
    updateUnknown: NO_UPDATE_CHANNEL.has(r.status) || typeof r.update === 'boolean',
  }
}

export function parseWpComponents(cleaned: string, kind: ComponentKind): Component[] {
  return asArray<WpRow>(cleaned)
    .filter((r) => !!r?.name)
    .map((r) => toComponent(r, kind))
}

/**
 * drush's `display_name` is "Admin Toolbar (admin_toolbar)" — the label with
 * the machine name appended. The console shows the slug in its own column, so
 * the suffix is stripped rather than printed twice.
 */
function cleanDrushTitle(display: string, name: string): string {
  const stripped = display.replace(/\s*\(\s*[a-z0-9_]+\s*\)\s*$/i, '').trim()
  return stripped || name
}

interface DrushRow {
  name: string
  title: string
  status: string
  version: string | null
  project?: string
  path?: string
}

/**
 * Parse `drush pm-list --format=json` / `pm:list`.
 *
 * TWO SHAPES, both live in the registry: D7 (drush 8) can return an ARRAY of
 * objects, while D8+ (drush 9+) returns an OBJECT keyed by machine name. Verified
 * against policyed1 (drops-7) and baseball-hall-of-fame / hfu (Integrated
 * Composer) — the latter two answer with 167 and 243 modules respectively.
 *
 * VERSION IS PRESENT and is now read. An earlier version of this file asserted
 * drush reported none, which was simply wrong: policyed1 answers
 * "7.x-3.22+78-dev" and the IC sites answer "3.6.3".
 *
 * AVAILABLE VERSIONS ARE NOT. `drush pm:security` has been REMOVED from modern
 * Drush — it now errors with "Please use `composer audit`", which cannot run
 * against a Pantheon environment. So every Drupal row keeps updateUnknown, and
 * that is a statement about Drush, not about the site being current.
 */
export function parseDrushComponents(cleaned: string, kind: ComponentKind): Component[] {
  let rows: DrushRow[] = []
  const read = (v: Record<string, string>, fallbackName: string): DrushRow => {
    const name = v.name ?? fallbackName
    return {
      name,
      title: cleanDrushTitle(v.display_name ?? v.title ?? name, name),
      status: v.status ?? 'unknown',
      version: v.version?.trim() || null,
      project: v.project?.trim() || undefined,
      path: v.path,
    }
  }
  try {
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) {
      rows = parsed
        .map((p: Record<string, string>) => read(p, p.name ?? ''))
        .filter((p) => p.name)
    } else if (typeof parsed === 'object' && parsed !== null) {
      rows = Object.entries(parsed).map(([key, val]) =>
        read((val ?? {}) as Record<string, string>, key),
      )
    }
  } catch {
    /* a parse failure is not an update state — report nothing */
  }
  return rows.map((r) => ({
    name: r.name,
    title: r.title,
    kind,
    status: r.status,
    version: r.version,
    available: null,
    updateAvailable: false,
    updateUnknown: true,
    project: r.project,
    // A module with no path is not evidence of anything, so absence is not
    // treated as custom. Only an explicit non-contrib path counts.
    custom: r.path ? !r.path.includes('/contrib/') : undefined,
  }))
}

/**
 * Collapse Drupal modules to one row per PROJECT.
 *
 * 243 module rows is not something anyone reads, and it overstates the site:
 * admin_toolbar's four sub-modules are one thing to update. Kept here rather
 * than in the UI so `npm run check:inventory` covers it.
 *
 * The surviving row is the one whose name equals the project — the project's
 * own module — falling back to the first seen. Status becomes Enabled if ANY
 * sub-module is enabled, because a project with one enabled sub-module is
 * running on that site.
 */
export function collapseByProject(components: Component[]): Component[] {
  const byProject = new Map<string, Component[]>()
  const passthrough: Component[] = []

  for (const c of components) {
    if (!c.project) { passthrough.push(c); continue }
    const key = `${c.kind}:${c.project}`
    const arr = byProject.get(key)
    if (arr) arr.push(c)
    else byProject.set(key, [c])
  }

  const collapsed = [...byProject.values()].map((group) => {
    const lead = group.find((c) => c.name === c.project) ?? group[0]
    const enabled = group.some((c) => /^enabled$/i.test(c.status))
    const subs = group.length - 1
    return {
      ...lead,
      name: lead.project!,
      status: enabled ? 'Enabled' : lead.status,
      // Surfaced in the title because the count is the reason the row is one
      // row: it tells the reader nothing was dropped.
      title: subs > 0 ? `${lead.title} +${subs}` : lead.title,
    }
  })

  return [...collapsed, ...passthrough]
}

/**
 * Parse `wp core check-update --format=json`.
 *
 * AN EMPTY ARRAY MEANS CORE IS CURRENT. Worth stating because an empty response
 * reads like a failed call — apexorderpickup.live is on current core and
 * answers exactly `[]`.
 */
export function parseCoreUpdate(
  cleaned: string,
  installed: string | null,
): { version: string; available: string } | null {
  const first = asArray<{ version?: string }>(cleaned)[0]
  if (!first?.version) return null
  return { version: installed ?? 'unknown', available: first.version }
}
