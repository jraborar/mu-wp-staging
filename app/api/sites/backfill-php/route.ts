import { backfillPhpVersions } from '@/lib/sites'

export const runtime = 'nodejs'

// One-time: resolve php_version via terminus for any registered site missing it.
export async function POST() {
  const filled = await backfillPhpVersions()
  return Response.json({ filled, count: filled.length })
}
