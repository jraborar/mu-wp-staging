export function getManilaYYMMDD(): string {
  const now = new Date()
  const pt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => pt.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}${get('month')}${get('day')}`
}

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

// Returns a date N business days (Mon–Fri) after `start`, computed in Manila timezone.
// Philippines has no DST so adding 24 * 60 * 60 * 1000 ms always advances exactly one Manila day.
export function addBusinessDays(start: Date, days: number): Date {
  const DAY = 24 * 60 * 60 * 1000
  let result = new Date(start)
  let added = 0
  while (added < days) {
    result = new Date(result.getTime() + DAY)
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila', weekday: 'short',
    }).format(result)
    if (weekday !== 'Sat' && weekday !== 'Sun') added++
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
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(date)
  return `${dateStr}T09:00:00+08:00`
}

// Returns an ISO 8601 string for the given date at 3:00 PM (15:00) Manila time.
// Uses Intl to extract the Manila calendar date, avoiding UTC-offset confusion on
// servers running in UTC (where Date.getDate() returns the UTC day, not Manila day).
export function manilaThreePM(date: Date): string {
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(date)
  return `${dateStr}T15:00:00+08:00`
}

// Formats a Date as a Manila-timezone ISO 8601 string (HH:MM:SS+08:00).
export function formatAsManilaISO(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+08:00`
}
