import { cleanupStaleRunningRecords } from '@/lib/supabase'
import { getAllJobs } from '@/lib/jobStore'
import { startSocketMode } from '@/lib/socketMode'
import { startScheduler } from '@/lib/scheduler'

export async function register() {
  const activeIds = getAllJobs()
    .filter((j) => j.status === 'running')
    .map((j) => j.id)

  await cleanupStaleRunningRecords(activeIds)

  void startSocketMode()
  startScheduler()
}
