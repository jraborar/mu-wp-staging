// WP-CLI output parsing and commit message helpers

export interface UpdatedItem {
  name: string  // slug
  title: string // display name (may equal slug if not resolved)
  from: string
  to: string
}

export interface SkippedItem {
  name: string
  title: string
  reason: string
}

export interface UpdateSummary {
  updated: UpdatedItem[]
  skipped: SkippedItem[]
  // True when the update CHECK itself failed, so this summary means "we don't know",
  // not "there was nothing to do". Set it and the run is reported failed, the cadence
  // anchor is left alone, and nobody reads the empty arrays as a clean bill of health.
  checkFailed?: boolean
}

// WP-CLI plugin/theme list --format=json entry
interface WpListEntry {
  name: string          // slug
  title?: string        // display name (if requested)
  version?: string      // current version
  update_version?: string
  [key: string]: unknown
}

// WP-CLI plugin/theme update --all --format=json entry
interface WpUpdateResult {
  name: string
  old_version: string
  new_version: string
  status: string  // Updated | Error | Skipped | NoChange
}

const PREMIUM_PATTERNS = [
  /-pro$/i, /-premium$/i, /-elite$/i, /-agency$/i, /-business$/i,
  /-plus$/i, /-professional$/i, /-advanced$/i, /pro-/i,
]

function isProbablyPremium(slug: string): boolean {
  return PREMIUM_PATTERNS.some((re) => re.test(slug))
}

function getSkipReason(slug: string, status?: string): string {
  if (isProbablyPremium(slug)) {
    return 'Pro/premium plugin — provide license credentials to update'
  }
  if (status === 'Error') {
    return 'Update failed — manual update may be required'
  }
  return 'Could not be updated automatically'
}

export function parseWpJson<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

// parseWpJson, but a failure is reported instead of swallowed.
//
//   null → the output was not a JSON array at all: an unfiltered PHP notice, a
//          fatal, truncated output, or nothing.
//   []   → WP-CLI genuinely reported an empty list.
//
// Those two must never be conflated. `wp plugin list --update=available` prints a
// real `[]` when nothing needs updating, so an unparseable payload is always a
// broken read — and reading it as "no updates available" is what silently skipped
// 16 plugin updates on claybuck twice. Callers that act on the result use this;
// parseWpJson stays for the places where an empty fallback is genuinely fine.
export function parseWpJsonStrict<T>(raw: string): T[] | null {
  if (raw.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  // Every element must be a record. A WP-CLI list is an array of objects, so an array
  // of scalars means we latched onto a fragment that merely happens to be valid JSON.
  // Syntax alone was not enough: a bare "[0]" out of a PHP notice parsed fine and was
  // read as a one-plugin list on claybuck's mu-260915 re-run, reported as "Found 1
  // plugin(s)" against an actual 16 — and it took the two genuinely license-blocked
  // plugins out of the skipped list with it. A broken read must fail closed here even
  // when cleanJson hands back something parseable.
  const isRecord = (x: unknown) => x !== null && typeof x === 'object' && !Array.isArray(x)
  if (!parsed.every(isRecord)) return null
  return parsed as T[]
}

export function buildUpdateSummary(
  available: WpListEntry[],
  results: WpUpdateResult[],
): UpdateSummary {
  const resultMap = new Map(results.map((r) => [r.name, r]))
  const updated: UpdatedItem[] = []
  const skipped: SkippedItem[] = []

  for (const item of available) {
    const slug = item.name
    const title = item.title ?? slug
    const result = resultMap.get(slug)

    if (result && result.status === 'Updated') {
      updated.push({ name: slug, title, from: result.old_version, to: result.new_version })
    } else {
      skipped.push({ name: slug, title, reason: getSkipReason(slug, result?.status) })
    }
  }

  return { updated, skipped }
}

function formatItem(item: UpdatedItem): string {
  return `- ${item.title} (${item.from} → ${item.to})`
}

function formatSkipped(item: SkippedItem): string {
  return `- ${item.title} — ${item.reason}`
}

export function buildCommitMessage(
  pluginSummary: UpdateSummary,
  themeSummary: UpdateSummary,
): string {
  const lines: string[] = []

  const hasPluginWork = pluginSummary.updated.length > 0 || pluginSummary.skipped.length > 0
  const hasThemeWork  = themeSummary.updated.length > 0  || themeSummary.skipped.length > 0

  if (hasPluginWork) {
    if (pluginSummary.updated.length > 0) {
      lines.push('**Plugins**')
      for (const p of pluginSummary.updated) lines.push(formatItem(p))
    }
    if (pluginSummary.skipped.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('**Skipped**')
      for (const p of pluginSummary.skipped) lines.push(formatSkipped(p))
    }
  }

  if (hasThemeWork) {
    if (lines.length > 0) lines.push('')
    if (themeSummary.updated.length > 0) {
      lines.push('**Themes**')
      for (const t of themeSummary.updated) lines.push(formatItem(t))
    }
    if (themeSummary.skipped.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push('**Skipped**')
      for (const t of themeSummary.skipped) lines.push(formatSkipped(t))
    }
  }

  return lines.join('\n')
}
