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
  return raw
    .split('\n')
    .filter((l) => !/^\s*(Deprecated|Warning|Notice|PHP):/i.test(l))
    .join('\n')
    .trim()
}
