import { execFile } from 'node:child_process'

export function fileOwnerPids(path: string): Promise<number[]> {
  return new Promise((resolvePids, reject) => {
    execFile(
      '/usr/sbin/lsof',
      ['-t', '-a', '-c', 'officecli', '--', path],
      { encoding: 'utf8' },
      (error, stdout) => {
        const code = (error as unknown as { code?: string | number } | null)?.code
        if (error && code !== 1 && code !== '1') {
          reject(error)
          return
        }
        resolvePids(
          stdout
            .split('\n')
            .map(Number)
            .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
        )
      }
    )
  })
}
