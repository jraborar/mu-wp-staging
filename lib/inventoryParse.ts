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
  /** active | inactive | must-use | dropin | parent | enabled | disabled */
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
 * Parse `drush pm-list --format=json`. D7 (drush 8) returns an ARRAY of objects
 * with name/display_name keys; D8+ (drush 9+) returns an OBJECT keyed by
 * machine name with nested name/status. Both shapes are live in the registry.
 *
 * drush reports no version and no update state, so every row is marked unknown
 * rather than implied current.
 */
export function parseDrushComponents(cleaned: string, kind: ComponentKind): Component[] {
  let rows: { name: string; title: string; status: string }[] = []
  try {
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) {
      rows = parsed
        .map((p: Record<string, string>) => ({
          name: p.name ?? '',
          title: p.display_name ?? p.title ?? p.name ?? '',
          status: p.status ?? 'unknown',
        }))
        .filter((p) => p.name)
    } else if (typeof parsed === 'object' && parsed !== null) {
      rows = Object.entries(parsed).map(([key, val]) => {
        const v = (val ?? {}) as Record<string, string>
        return { name: key, title: v.name ?? v.title ?? key, status: v.status ?? 'unknown' }
      })
    }
  } catch {
    /* a parse failure is not an update state — report nothing */
  }
  return rows.map((r) => ({
    name: r.name, title: r.title, kind, status: r.status,
    version: null, available: null, updateAvailable: false, updateUnknown: true,
  }))
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
