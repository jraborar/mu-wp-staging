import { exec, spawn } from 'child_process'

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

const ENV = { ...process.env, TERMINUS_HIDE_UPDATE_MESSAGE: '1' }

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '')
}

function isNoise(line: string): boolean {
  return /^\s*(Deprecated|Warning|Notice|PHP):/i.test(line)
    || /^\d+\/\d+\s*\[/.test(line)
}

export function run(cmd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    exec(cmd, { env: ENV }, (err, stdout, stderr) => {
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
    const child = spawn('sh', ['-c', cmd], { env: ENV })

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

export function cleanJson(raw: string): string {
  const cleaned = raw
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      if (/^\s*(Deprecated|Warning|Notice|PHP):/i.test(t)) return false
      if (/^\[(warning|notice|error|info)\]/i.test(t)) return false
      // Terminus appends a UTC timestamp line after notices, e.g. "2026-08-05 10:44:31 UTC[+0000]"
      if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(t)) return false
      return true
    })
    // WP-CLI appends "[notice] Command: ..." on the same line as JSON output.
    // Strip it so the greedy regex doesn't swallow [Exit: 0] as part of the match.
    .map((l) => l.replace(/\s*\[(?:notice|warning|error|info)\]\s+Command:.*$/i, ''))
    .join('\n')
    .trim()

  const match = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/)
  return match ? match[0] : cleaned
}
