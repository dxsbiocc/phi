import { execFileSync } from 'node:child_process'

export type GitRunner = (args: readonly string[]) => string

export function gitRunner(cwd: string): GitRunner {
  return (args) =>
    execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
}

export function currentCommit(git: GitRunner): string {
  const head = git(['rev-parse', 'HEAD']).trim()
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('HEAD is not a commit')
  return head
}

/** Tracked files that differ from HEAD (index or working tree). Untracked files are ignored. */
export function modifiedTrackedFiles(git: GitRunner): string[] {
  return git(['status', '--porcelain', '--untracked-files=no'])
    .split('\n')
    .filter((line) => line.trim() !== '')
}

export function assertTrackedTreeClean(git: GitRunner): void {
  const modified = modifiedTrackedFiles(git)
  if (modified.length === 0) return
  const shown = modified.slice(0, 10).join('\n  ')
  const more = modified.length > 10 ? `\n  ... and ${modified.length - 10} more` : ''
  throw new Error(
    `Refusing --execute: ${modified.length} tracked file(s) are modified. ` +
      `The receipt records the commit, so commit or stash first:\n  ${shown}${more}`
  )
}
