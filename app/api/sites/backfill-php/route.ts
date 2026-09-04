import { backfillPhpVersions } from '@/lib/sites'
import { requireCaller } from '@/lib/callerAuth'

export const runtime = 'nodejs'

// One-time: resolve php_version via terminus for any registered site missing it.
export async function POST(request: Request) {
  const denied = await requireCaller(request)
  if (denied) return denied

  const filled = await backfillPhpVersions()
  return Response.json({ filled, count: filled.length })
}
