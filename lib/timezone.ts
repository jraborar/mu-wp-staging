export function getPacificYYMMDD(): string {
  const now = new Date()
  const pt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)

  const get = (type: string) => pt.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}${get('month')}${get('day')}`
}

// Returns a date N business days (Mon–Fri) after `start`.
export function addBusinessDays(start: Date, days: number): Date {
  const result = new Date(start)
  let added = 0
  while (added < days) {
    result.setDate(result.getDate() + 1)
    const dow = result.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return result
}

// Returns today's date as a Date anchored to Manila midnight (UTC+8).
// Philippines does not observe DST — offset is always +08:00.
export function getManilaToday(): Date {
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
  }).format(new Date()) // → "YYYY-MM-DD"
  return new Date(`${dateStr}T00:00:00+08:00`)
}

// Returns an ISO 8601 string for the given date at 9:00 AM Manila time.
export function manilaNineAM(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const y = date.getFullYear()
  const m = p(date.getMonth() + 1)
  const d = p(date.getDate())
  return `${y}-${m}-${d}T09:00:00+08:00`
}
