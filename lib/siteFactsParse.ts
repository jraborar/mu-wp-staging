// Pure parsing for `terminus site:info`.
//
// Import-free for the same reason lib/inventoryParse.ts is: `npm run
// check:inventory` runs it under Node's type stripping, which cannot resolve
// the `@/` alias or load lib/terminus.ts. Takes a string ALREADY passed through
// cleanJson().
//
// WHY A SECOND site:info READER EXISTS: lib/sites.ts resolveSiteMeta() already
// parses this output, but it reads only the four fields the registry stores —
// label, machine name, upstream label, framework — and throws the rest away.
// The per-site Overview in mu-pmu-tool needs the identifiers the registry has
// no column for, chiefly `organization`, which is per-customer and not derivable
// from anything already stored.

export interface SiteFacts {
  /** Pantheon site UUID. Also the fix for the 13 registry rows with no site_uuid. */
  id: string | null
  /** Machine name. */
  name: string | null
  /** Human label, e.g. "UMARY Prime Matters". */
  label: string | null
  /** Owning organization's UUID — per customer, differs on every site. */
  organization: string | null
  plan_name: string | null
  region: string | null
  framework: string | null
  /** Product label, e.g. "Drupal (Composer Managed)". */
  upstream_label: string | null
  /** Raw "<uuid>: <git url>" — the only field carrying the repo slug. */
  upstream: string | null
  /** Unix seconds. */
  created: number | null
  frozen: boolean | null
  /** Who holds the site: 'organization' or 'user'. */
  holder_type: string | null
  owner: string | null
}

const EMPTY: SiteFacts = {
  id: null, name: null, label: null, organization: null, plan_name: null,
  region: null, framework: null, upstream_label: null, upstream: null,
  created: null, frozen: null, holder_type: null, owner: null,
}

const str = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

export function parseSiteFacts(cleaned: string): SiteFacts {
  let d: Record<string, unknown>
  try {
    const parsed = JSON.parse(cleaned)
    // site:info answers with an OBJECT. An array here means something else
    // came back — a list command, or an error rendered as JSON — and reading
    // field names off it would silently produce all-nulls.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY }
    d = parsed as Record<string, unknown>
  } catch {
    return { ...EMPTY }
  }

  return {
    id: str(d.id),
    name: str(d.name),
    label: str(d.label),
    // `holder_id` repeats the organization UUID when holder_type is
    // 'organization', so it is the fallback — but never the primary, because a
    // user-held site's holder_id is a PERSON and linking to
    // /organizations/<user-uuid> would 404.
    organization:
      str(d.organization) ??
      (str(d.holder_type) === 'organization' ? str(d.holder_id) : null),
    plan_name: str(d.plan_name),
    region: str(d.region),
    framework: str(d.framework),
    upstream_label: str(d.upstream_label),
    upstream: str(d.upstream),
    created: typeof d.created === 'number' ? d.created : null,
    frozen: typeof d.frozen === 'boolean' ? d.frozen : null,
    holder_type: str(d.holder_type),
    owner: str(d.owner),
  }
}
