import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'

import { assertNoProjectPluginTools } from '../../src/main/agent/engine/rpc/project-plugin-tool-admission'
import type { WorkspaceHost } from '../../src/main/agent/workspace-host/types'

const args = process.argv.slice(2)
const command = args.shift()
const flags = new Map<string, string>()
while (args.length) {
  const name = args.shift()
  const value = args.shift()
  if (!name?.startsWith('--') || value === undefined) process.exit(64)
  flags.set(name, value)
}

if (command === 'remote-session-preflight') {
  const root = flags.get('--root')
  const projectRoot = flags.get('--project-root')
  const manifestPath = flags.get('--manifest')
  const manifestSha256 = flags.get('--manifest-sha256')
  const manifestBytes = Number(flags.get('--manifest-bytes'))
  const journalPath = flags.get('--journal')
  const sessionId = flags.get('--session-id')
  if (
    !root ||
    !projectRoot ||
    !manifestPath ||
    !manifestSha256 ||
    !journalPath ||
    !sessionId ||
    !Number.isSafeInteger(manifestBytes)
  )
    process.exit(64)
  const privateFile = async (path: string): Promise<Awaited<ReturnType<typeof lstat>>> => {
    const value = await lstat(path)
    if (
      !value.isFile() ||
      value.isSymbolicLink() ||
      value.nlink !== 1 ||
      (value.mode & 0o777) !== 0o600 ||
      (process.getuid && value.uid !== process.getuid()) ||
      !path.startsWith(`${root}/`)
    )
      throw new Error('private file validation failed')
    return value
  }
  try {
    const manifestStat = await privateFile(manifestPath)
    const manifest = await readFile(manifestPath)
    const manifestHash = createHash('sha256').update(manifest).digest('hex')
    if (
      manifest.length !== manifestBytes ||
      manifestStat.size !== manifestBytes ||
      manifestHash !== manifestSha256
    )
      throw new Error('manifest identity differs')
    const journalStat = await privateFile(journalPath)
    const journal = await readFile(journalPath)
    const firstEnd = journal.indexOf(10)
    if (firstEnd < 0 || firstEnd >= 16_384) throw new Error('invalid journal header')
    const first = JSON.parse(journal.subarray(0, firstEnd).toString('utf8')) as Record<
      string,
      unknown
    >
    const start = first.type === 'title' ? firstEnd + 1 : 0
    const headerEnd = start ? journal.indexOf(10, start) : firstEnd
    if (headerEnd < 0 || headerEnd >= 16_384) throw new Error('invalid journal header')
    const header = JSON.parse(journal.subarray(start, headerEnd).toString('utf8')) as Record<
      string,
      unknown
    >
    if (
      header.type !== 'session' ||
      header.version !== 3 ||
      header.id !== sessionId ||
      typeof header.cwd !== 'string' ||
      (await realpath(header.cwd)) !== projectRoot
    )
      throw new Error('journal identity differs')
    const deviceInode = `${journalStat.dev}:${journalStat.ino}`
    process.stdout.write(
      `${JSON.stringify({
        manifest: { path: manifestPath, size: manifest.length, sha256: manifestHash },
        journal: {
          journalPath,
          ompSessionId: sessionId,
          cwd: projectRoot,
          headerVersion: 3,
          fileIdentity: createHash('sha256')
            .update(deviceInode)
            .update('\0')
            .update(journal.subarray(start, headerEnd))
            .digest('hex'),
          fingerprint: createHash('sha256')
            .update(`${deviceInode}:${journalStat.size}:${journalStat.mtimeMs}`)
            .update('\0')
            .update(journal.subarray(0, headerEnd + 1))
            .digest('hex'),
          verification: 'bounded-header'
        }
      })}\n`
    )
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
} else if (command !== 'project-plugin-guard') process.exit(64)

const projectRoot = flags.get('--root')
if (command === 'project-plugin-guard' && !projectRoot) process.exit(64)

const host = {
  exec: {
    run(argv: readonly string[], options: { cwd: string; maxOutputBytes: number }) {
      return new Promise<{
        stdout: string
        stderr: string
        code: number | null
        signal: string | null
        truncated: boolean
      }>((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1), {
          cwd: options.cwd,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        let truncated = false
        const append = (current: string, chunk: Buffer): string => {
          const next = current + chunk.toString('utf8')
          if (Buffer.byteLength(next) <= options.maxOutputBytes) return next
          truncated = true
          return Buffer.from(next).subarray(0, options.maxOutputBytes).toString('utf8')
        }
        child.stdout.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)))
        child.stderr.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)))
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ stdout, stderr, code, signal, truncated }))
      })
    }
  }
} as unknown as WorkspaceHost

if (command === 'project-plugin-guard' && projectRoot)
  try {
    await assertNoProjectPluginTools({
      host,
      cwd: projectRoot,
      runtimeRoot: projectRoot,
      signal: new AbortController().signal
    })
    process.stdout.write('{"ok":true}\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
