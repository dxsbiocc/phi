import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { RemoteProjectDownloadManager } from '../../src/main/agent/download/remote-project-download'
import { ensureRemoteProjectAnchor } from '../../src/main/agent/remote-project-anchor'
import { getFileTransferCoordinator, type TransferEvent } from '../../src/main/agent/transfer'
import { shellQuote } from '../../src/main/agent/wrappers/remote-ssh-session'
import type { RemoteExecBoundedOptions } from '../../src/main/agent/wrappers/remote-ssh-session'
import { warmExecutable } from './firstExec'
import { createLocalShellSession } from './localShellSession'

type DownloadFixture = {
  root: string
  anchor: string
  remoteRoot: string
  bytes: Buffer
  digest: string
  manager: RemoteProjectDownloadManager
  events: TransferEvent[]
  sessions: ReturnType<typeof createLocalShellSession>[]
  coordinator: ReturnType<typeof getFileTransferCoordinator>
  setBeforeCommand: (hook: (command: string) => Promise<void>) => void
  setBeforeConnect: (hook: () => Promise<void>) => void
  setOnEvent: (hook: (event: TransferEvent) => void) => void
  allow: (name?: string) => void
  startedPath: (name?: string) => string
  request: (
    sessionId?: string,
    name?: string,
    requestId?: string
  ) => {
    sessionId: string
    projectId: string
    requestId: string
    toolCallId: string
    url: string
    outputPath: string
    maxFileBytes: number
  }
  dispose: () => Promise<void>
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

/** Real download shell scripts and binary files, with curl replaced by an offline fixture. */
export function remoteDownloadFixture(
  options: {
    projectId?: string
    hostProfileId?: string
    hostAlias?: string
    anchor?: string
    remoteRoot?: string
    agentDir?: string
  } = {}
): DownloadFixture {
  const root = mkdtempSync(join(tmpdir(), 'phi-download-ownership-'))
  const projectId = options.projectId ?? 'project-1'
  const agentDir =
    options.agentDir ?? (options.anchor ? dirname(dirname(options.anchor)) : join(root, 'agent'))
  const bin = join(root, 'bin')
  const eventsDir = join(root, 'events')
  const remoteRootInput = join(root, 'remote')
  for (const directory of [agentDir, bin, eventsDir, remoteRootInput])
    mkdirSync(directory, { recursive: true })
  const remoteRoot = realpathSync(options.remoteRoot ?? remoteRootInput)
  const anchor = ensureRemoteProjectAnchor(projectId, agentDir)
  if (options.anchor && realpathSync(options.anchor) !== realpathSync(anchor)) {
    throw new Error('Fixture anchor must match the selected Phi project')
  }
  const bytes = Buffer.from(Array.from({ length: 8193 }, (_, index) => index % 256))
  const digest = createHash('sha256').update(bytes).digest('hex')
  const source = join(root, 'source.bin')
  writeFileSync(source, bytes)
  writeFileSync(join(anchor, 'owner.bin'), 'local anchor sentinel')
  const curlPath = join(bin, 'curl')
  writeFileSync(
    curlPath,
    `#!/bin/bash
set -eu
if [ "\${1-}" = --phi-warm ]; then exit 0; fi
head_only=0; headers=; output=; url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --head) head_only=1; shift ;;
    --dump-header|--output|--write-out|--header|--resolve|--max-filesize|--connect-timeout|--max-time|--proto|--max-redirs|--continue-at|--noproxy)
      option=$1; value=$2; shift 2
      case "$option" in --dump-header) headers=$value ;; --output) output=$value ;; esac ;;
    --fail|--silent|--show-error|-q) shift ;;
    *) url=$1; shift ;;
  esac
done
size=$(wc -c < "$PHI_FIXTURE_SOURCE" | tr -d ' ')
if [ "$head_only" -eq 1 ]; then
  printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\nETag: "tiny-v1"\r\nX-Checksum-Sha256: %s\r\n\r\n' "$size" "$PHI_FIXTURE_DIGEST" > "$headers"
  printf 200; exit 0
fi
name=\${url##*/}
printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\n\r\n' "$size" > "$headers"
dd if="$PHI_FIXTURE_SOURCE" of="$output" bs=1024 count=1 2>/dev/null
touch "$PHI_FIXTURE_EVENTS/$name.started"
while [ ! -e "$PHI_FIXTURE_EVENTS/$name.allow" ]; do sleep 0.02; done
tail -c +1025 "$PHI_FIXTURE_SOURCE" >> "$output"
printf 200
`
  )
  chmodSync(curlPath, 0o755)
  warmExecutable(curlPath, ['--phi-warm'])
  const prefix = [
    `PATH=${shellQuote(`${bin}:${process.env.PATH ?? ''}`)}`,
    `PHI_FIXTURE_SOURCE=${shellQuote(source)}`,
    `PHI_FIXTURE_DIGEST=${shellQuote(digest)}`,
    `PHI_FIXTURE_EVENTS=${shellQuote(eventsDir)}`
  ].join(' ')
  const events: TransferEvent[] = []
  const sessions: ReturnType<typeof createLocalShellSession>[] = []
  let beforeCommand: (command: string) => Promise<void> = async () => undefined
  let beforeConnect: () => Promise<void> = async () => undefined
  let onEvent: (event: TransferEvent) => void = () => undefined
  const location = {
    kind: 'ssh' as const,
    hostProfileId: options.hostProfileId ?? 'profile-1',
    remoteRoot,
    canonicalRoot: remoteRoot
  }
  const manager = new RemoteProjectDownloadManager({
    agentDir,
    getManifest: () =>
      ({
        kind: 'project',
        projectId,
        cwd: anchor,
        projectLocation: location
      }) as never,
    getProject: () => ({ id: projectId, location }) as never,
    listProjects: () => [],
    getHostProfile: () => ({
      id: location.hostProfileId,
      label: 'Fixture',
      hostAlias: options.hostAlias ?? 'fixture-host'
    }),
    onTransferEvent: (event) => {
      events.push(event)
      onEvent(event)
    },
    connectHost: async () => {
      await beforeConnect()
      const session = createLocalShellSession(remoteRoot)
      const execute = session.exec.bind(session)
      const open = session.openStdio!.bind(session)
      session.exec = async (command) => {
        await beforeCommand(command)
        return execute(`${prefix} bash -c ${shellQuote(command)}`)
      }
      session.execBounded = async (command: string, options: RemoteExecBoundedOptions) => {
        options.signal?.throwIfAborted()
        if (command.includes('getent ahosts')) {
          await beforeCommand(command)
          session.commands.push(command)
          return {
            stdout: '93.184.216.34\n',
            stderr: '',
            code: 0,
            signal: null,
            stdoutTruncated: false,
            stderrTruncated: false
          }
        }
        const result = await session.exec(command)
        return { ...result, stdoutTruncated: false, stderrTruncated: false }
      }
      session.openStdio = async (command) => {
        await beforeCommand(command)
        return open(`${prefix} bash -c ${shellQuote(command)}`)
      }
      sessions.push(session)
      return session
    }
  })
  return {
    root,
    anchor,
    remoteRoot,
    bytes,
    digest,
    manager,
    events,
    sessions,
    coordinator: getFileTransferCoordinator(agentDir),
    setBeforeCommand: (hook: typeof beforeCommand) => {
      beforeCommand = hook
    },
    setBeforeConnect: (hook: typeof beforeConnect) => {
      beforeConnect = hook
    },
    setOnEvent: (hook: typeof onEvent) => {
      onEvent = hook
    },
    allow: (name = 'owner.bin') => writeFileSync(join(eventsDir, `${name}.allow`), ''),
    startedPath: (name = 'owner.bin') => join(eventsDir, `${name}.started`),
    request: (sessionId = 'session-owner', name = 'owner.bin', requestId = 'request-original') => ({
      sessionId,
      projectId,
      requestId,
      toolCallId: `tool-${sessionId}`,
      url: `https://example.org/${name}`,
      outputPath: name,
      maxFileBytes: 65536
    }),
    dispose: async () => {
      for (const session of sessions) await session.close()
      await getFileTransferCoordinator(agentDir).cleanupRetained({
        hostKey: 'fixture-cleanup',
        cleanupOwner: 'none',
        storageKey: 'none',
        freeBytes: 0,
        removeOwned: async () => undefined
      })
      rmSync(root, { recursive: true, force: true })
    }
  }
}
