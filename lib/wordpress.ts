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
  return `- ${item.title} (${item.from} to ${item.to})`
}

function formatSkipped(item: SkippedItem): string {
  return `- ${item.title} - ${item.reason}`
}

export function buildCommitMessage(
  pluginSummary: UpdateSummary,
  themeSummary: UpdateSummary,
): string {
  const lines: string[] = []

  const hasPluginWork = pluginSummary.updated.length > 0 || pluginSummary.skipped.length > 0
  const hasThemeWork  = themeSummary.updated.length > 0  || themeSummary.skipped.length > 0

  if (hasPluginWork) {
    lines.push('##Plugin##')
    for (const p of pluginSummary.updated) lines.push(formatItem(p))
    if (pluginSummary.skipped.length > 0) {
      lines.push('##Skipped##')
      for (const p of pluginSummary.skipped) lines.push(formatSkipped(p))
    }
  }

  if (hasThemeWork) {
    if (lines.length > 0) lines.push('')
    lines.push('##Theme##')
    for (const t of themeSummary.updated) lines.push(formatItem(t))
    if (themeSummary.skipped.length > 0) {
      lines.push('##Skipped##')
      for (const t of themeSummary.skipped) lines.push(formatSkipped(t))
    }
  }

  return lines.join('\n')
}
