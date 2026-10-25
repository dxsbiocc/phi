import { join } from 'node:path'

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isKernelSessionId(value: string): boolean {
  return sessionIdPattern.test(value)
}

export function kernelSessionsRoot(agentDir: string): string {
  return join(agentDir, 'phi-kernel', 'sessions')
}

export function kernelSessionPaths(
  agentDir: string,
  sessionId: string
): {
  directory: string
  journal: string
  manifest: string
  receipts: string
  lock: string
} {
  if (!isKernelSessionId(sessionId)) throw new TypeError('Invalid kernel session id')
  const directory = join(kernelSessionsRoot(agentDir), sessionId)
  return {
    directory,
    journal: join(directory, 'journal.jsonl'),
    manifest: join(directory, 'session.json'),
    receipts: join(directory, 'runs.jsonl'),
    lock: join(directory, 'writer.lock')
  }
}

export function kernelSessionMigrationPaths(
  agentDir: string,
  sessionId: string
): ReturnType<typeof kernelSessionPaths> & { sourceBackup: string; migration: string } {
  const paths = kernelSessionPaths(agentDir, sessionId)
  return {
    ...paths,
    sourceBackup: join(paths.directory, 'source-backup.jsonl'),
    migration: join(paths.directory, 'migration.json')
  }
}
