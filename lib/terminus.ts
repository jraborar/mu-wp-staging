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

  // Try EVERY opening bracket and return the first balanced span that actually
  // parses — don't commit to the first '[' in the output.
  //
  // The line filter above cannot catch a PHP notice that arrives mid-line or in a
  // shape it doesn't recognise, and such a notice can carry brackets of its own.
  // claybuck's `wp plugin list --context=admin` emits a backtrace fragment
  // "[/code/wp-includes/class-wp-hook.php:355]" ahead of the payload; locking onto
  // that bracket returned the fragment and threw the real JSON away, so 16
  // available plugin updates were read as an empty list on two separate runs
  // (mu-260820, mu-260915) and silently never applied.
  let first: string | null = null
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i]
    if (c !== '[' && c !== '{') continue
    const span = balancedSpan(cleaned, i)
    if (first === null) first = span
    try {
      JSON.parse(span)
      return span
    } catch {
      // Not the payload — keep scanning. Skip past this span's opening bracket
      // only, since a valid object can legitimately start inside it.
    }
  }

  // Nothing parsed. Hand back the first span (or the whole cleaned string when
  // there were no brackets at all) — byte-identical to the old behaviour, so the
  // caller logs and reports exactly what terminus said.
  return first ?? cleaned
}
