import { cleanupStaleRunningRecords } from '@/lib/supabase'
import { getAllJobs } from '@/lib/jobStore'

export async function register() {
  const activeIds = getAllJobs()
    .filter((j) => j.status === 'running')
    .map((j) => j.id)

  await cleanupStaleRunningRecords(activeIds)
}
