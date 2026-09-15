import { exec, spawn } from 'child_process'
import { AsyncLocalStorage } from 'async_hooks'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

const ENV = { ...process.env, TERMINUS_HIDE_UPDATE_MESSAGE: '1' }

// Per-job PHP context. executeJob sets this to the site's php_version (mutable so it can
// be refined after env:info); the terminus wrapper reads MU_TERMINUS_PHP to pick the
// matching php + terminus binary PER COMMAND — no global `update-alternatives`, no races
// between concurrent jobs on different PHP versions.
export const terminusPhp = new AsyncLocalStorage<{ php: string }>()

function envForRun(): NodeJS.ProcessEnv {
  const ctx = terminusPhp.getStore()
  return ctx?.php ? { ...ENV, MU_TERMINUS_PHP: ctx.php } : ENV
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '')
}

function isNoise(line: string): boolean {
  return /^\s*(Deprecated|Warning|Notice|PHP):/i.test(line)
    || /^\d+\/\d+\s*\[/.test(line)
}

export function run(cmd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    exec(cmd, { env: envForRun() }, (err, stdout, stderr) => {
      resolve({
        stdout: stripAnsi(stdout ?? ''),
        stderr: stripAnsi(stderr ?? ''),
        code: err ? (err.code ?? 1) : 0,
      })
    })
  })
}

// Streams stdout/stderr line-by-line into onLine as the command runs.
const STREAM_TIMEOUT_MS = 90 * 60 * 1000 // 90 minutes

export function runStream(
  cmd: string,
  onLine: (line: string) => void,
): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { env: envForRun() })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000)
      resolve({ code: 124 })
    }, STREAM_TIMEOUT_MS)

    const handle = (data: Buffer) => {
      const lines = stripAnsi(data.toString()).split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed && !isNoise(trimmed)) onLine(trimmed)
      }
    }

    child.stdout.on('data', handle)
    child.stderr.on('data', handle)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 0 })
    })
  })
}

export function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'"
}

// Balanced span starting at `start` (which must be a '[' or '{').
//
// Balanced bracket matching, not a greedy regex — a regex fails when terminus
// appends "2026-08-05 10:44:31 UTC[+0000]" on the same line as the JSON output.
// Returns the rest of the string when the brackets never balance, so a truncated
// payload still reaches the caller (and still fails its parse) as it always has.
function balancedSpan(s: string, start: number): string {
  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (escape)   { escape = false; continue }
    if (inString) {
      if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return s.slice(start)
}

export function cleanJson(raw: string): string {
  const cleaned = raw
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      if (/^\s*(Deprecated|Warning|Notice|PHP):/i.test(t)) return false
      if (/^\[(warning|notice|error|info)\]/i.test(t)) return false
      return true
    })
    .join('\n')
    .trim()

  // Try EVERY opening bracket and return the first balanced span that looks like a
  // terminus/WP-CLI payload — don't commit to the first '[' in the output.
  //
  // The line filter above cannot catch a PHP notice that arrives mid-line or in a
  // shape it doesn't recognise, and such a notice can carry brackets of its own.
  // claybuck's `wp plugin list --context=admin` emits a backtrace fragment
  // "[/code/wp-includes/class-wp-hook.php:355]" ahead of the payload; locking onto
  // that bracket returned the fragment and threw the real JSON away, so 16
  // available plugin updates were read as an empty list on two separate runs
  // (mu-260820, mu-260915) and silently never applied.
  //
  // "Parses as JSON" is NOT a strong enough test on its own, which cost a second
  // run: claybuck's next list emitted a bare "[0]" ahead of the payload, that IS
  // valid JSON, and it was returned as a one-element list — reported as "Found 1
  // plugin(s) with available updates" when there were 16. So prefer a span whose
  // SHAPE matches what these commands actually return: an object, or an array that
  // is empty or holds objects. A scalar array is a fragment, never a payload.
  // An EMPTY payload ("[]", "{}") only wins if no non-empty one exists anywhere,
  // because "[]" is indistinguishable from a legitimate "nothing to update" and would
  // otherwise shadow the real list: noise containing a bare "[]" — or the inner "[]"
  // of a nested "[[]]" — would land us straight back on the original bug, an empty
  // list read as "no updates available".
  let firstSpan: string | null = null
  let firstParsed: string | null = null
  let firstEmptyPayload: string | null = null
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i]
    if (c !== '[' && c !== '{') continue
    const span = balancedSpan(cleaned, i)
    if (firstSpan === null) firstSpan = span
    let parsed: unknown
    try {
      parsed = JSON.parse(span)
    } catch {
      // Not JSON at all — keep scanning. Advance one character only, since a valid
      // payload can legitimately begin inside this span.
      continue
    }
    if (isPayloadShaped(parsed)) {
      if (!isEmptyPayload(parsed)) return span
      if (firstEmptyPayload === null) firstEmptyPayload = span
    } else if (firstParsed === null) {
      firstParsed = span
    }
  }

  // No non-empty payload. Prefer a genuine empty one, then the first span that at
  // least parsed, then the first span, then the whole cleaned string — so a caller
  // still logs what terminus actually said instead of a silently different string.
  return firstEmptyPayload ?? firstParsed ?? firstSpan ?? cleaned
}

// Does this parsed value have the shape terminus and WP-CLI actually emit for
// --format=json? Objects (env:info, site:info) and arrays of records (plugin/theme
// list, upstream:updates:list, drush pm:list) qualify; an empty array is a legitimate
// "nothing here". An array of scalars does not: "[0]" or "[1,2]" lifted out of a PHP
// notice parses cleanly but is never a payload.
function isPayloadShaped(v: unknown): boolean {
  const isRecord = (x: unknown) => x !== null && typeof x === 'object' && !Array.isArray(x)
  if (Array.isArray(v)) return v.length === 0 || v.every(isRecord)
  return isRecord(v)
}

// "[]" / "{}" — well-shaped but carrying nothing, so it must not outrank a real payload
// found later in the same output. See the scan above.
function isEmptyPayload(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0
  return v !== null && typeof v === 'object' && Object.keys(v).length === 0
}
