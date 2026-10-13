import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { serializeTitleSlot } from '@oh-my-pi/pi-coding-agent/session/session-title-slot'
import type { RemoteStdioProcess } from '../../src/main/agent/wrappers/remote-ssh-session'
import { deriveRemoteSessionPaths } from '../../src/main/agent/engine/rpc/session-storage/paths'
import {
  type PrepareRemoteSessionStorageOptions,
  type RemoteSessionReference,
  type RemoteSessionScope,
  type RemoteSessionStoragePreparation
} from '../../src/main/agent/engine/rpc/session-storage/types'
import { prepareRemoteSessionStorage } from '../../src/main/agent/engine/rpc/session-storage/writer-lease'
import { createRemoteOmpDeploymentFixture } from './remoteOmpDeploymentFixture'
import { installFlockShim } from './flockShim'
import { SshHost } from '../../src/main/agent/workspace-host/ssh-host'
import { createLocalShellSession, type LocalShellSession } from './localShellSession'

export async function createRemoteSessionStorageFixture(): Promise<
  Omit<Awaited<ReturnType<typeof createRemoteOmpDeploymentFixture>>, 'options'> & {
    lockSession: ReturnType<typeof createLocalShellSession>
    scope: RemoteSessionScope
    paths: ReturnType<typeof deriveRemoteSessionPaths>
    reference: RemoteSessionReference
    options: PrepareRemoteSessionStorageOptions
    channels: RemoteStdioProcess[]
    journalPath: string
    writeJournal: (override?: Record<string, unknown>, withTitle?: boolean) => Promise<void>
  }
> {
  const fixture = await createRemoteOmpDeploymentFixture()
  const restoreFlock = installFlockShim(join(fixture.root, 'flock-shim'))
  const operationSessions: LocalShellSession[] = []
  const host = new SshHost({
    remoteRoot: fixture.runtimeRoot,
    canonicalRoot: fixture.runtimeRoot,
    connect: async () => {
      const session = createLocalShellSession(fixture.runtimeRoot)
      operationSessions.push(session)
      return session
    }
  })
  const lockSession = createLocalShellSession(fixture.runtimeRoot)
  const projectRoot = join(fixture.root, 'project')
  await mkdir(projectRoot, { mode: 0o700 })
  const scope: RemoteSessionScope = {
    hostProfileId: 'fixture-host',
    bindingHash: 'a'.repeat(64),
    projectId: 'project-1',
    projectRoot,
    runtimeRoot: fixture.runtimeRoot,
    phiSessionId: 'phi-session-1'
  }
  const paths = deriveRemoteSessionPaths(scope)
  const reference: RemoteSessionReference = {
    ...scope,
    kind: 'remote-omp',
    version: 1,
    durableSessionKey: paths.durableSessionKey,
    ompVersion: '18.10.3',
    ompSessionId: 'sdk-session-1',
    journalBasename: '2026-10-13_sdk-session-1.jsonl'
  }
  const channels: RemoteStdioProcess[] = []
  const options: PrepareRemoteSessionStorageOptions = {
    runtimeHost: host,
    scope,
    openLockStdio: async (command) => {
      const channel = await lockSession.openStdio!(command)
      channels.push(channel)
      return channel
    }
  }
  const journalPath = join(paths.journals, reference.journalBasename)
  const writeJournal = async (
    override: Record<string, unknown> = {},
    withTitle = true
  ): Promise<void> => {
    await writeFile(
      journalPath,
      `${withTitle ? actualSdkTitleSlot() : ''}${JSON.stringify({
        type: 'session',
        version: 3,
        id: reference.ompSessionId,
        cwd: scope.projectRoot,
        timestamp: '2026-10-13T12:00:00.000Z',
        ...override
      })}\n`,
      { mode: 0o600 }
    )
  }
  return {
    ...fixture,
    host,
    lockSession,
    scope,
    paths,
    reference,
    options,
    channels,
    journalPath,
    writeJournal,
    cleanup: async () => {
      await lockSession.close()
      await host.close()
      await Promise.all(operationSessions.map((session) => session.close()))
      await fixture.cleanup()
      restoreFlock()
    }
  }
}

/** Oracle from locked SDK18.10.3, not a second handwritten physical journal serializer. */
export function actualSdkTitleSlot(
  options: {
    title?: string
    source?: 'auto' | 'user'
    updatedAt?: string
  } = {}
): string {
  return serializeTitleSlot({ updatedAt: '2026-10-13T12:00:00.000Z', ...options })
}

export async function prepareRemoteSessionStorageFixture(t: TestContext): Promise<
  Awaited<ReturnType<typeof createRemoteSessionStorageFixture>> & {
    preparation: RemoteSessionStoragePreparation
  }
> {
  const fixture = await createRemoteSessionStorageFixture()
  t.after(fixture.cleanup)
  const preparation = await prepareRemoteSessionStorage(fixture.options)
  t.after(() => preparation.lease.release())
  return { ...fixture, preparation }
}
