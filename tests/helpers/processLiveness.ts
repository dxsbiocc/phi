import { readFileSync } from 'node:fs'

/**
 * Whether `pid` is still running. `kill(pid, 0)` also succeeds for a zombie, and orphaned
 * zombies stay forever where the container's PID 1 does not reap them, so on Linux the
 * process state decides.
 */
export function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The state follows the parenthesized command name, which may itself contain spaces.
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    return false
  }
}
