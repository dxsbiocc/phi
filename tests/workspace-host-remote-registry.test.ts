import assert from 'node:assert/strict'
import test from 'node:test'

import { RemoteWorkspaceHostRegistry } from '../src/main/agent/workspace-host/remote-registry'
import type { WorkspaceHost } from '../src/main/agent/workspace-host/types'

test('remote workspace host registry keeps one host per Phi session until release', async () => {
  let hostsCreated = 0
  const host = {
    fs: {} as WorkspaceHost['fs'],
    exec: {} as WorkspaceHost['exec'],
    capabilities() {
      throw new Error('not used')
    }
  } satisfies WorkspaceHost
  const registry = new RemoteWorkspaceHostRegistry({
    resolveBinding: (request) => ({
      sessionId: request.sessionId,
      projectId: request.projectId,
      hostAlias: 'cluster-a',
      remoteRoot: '/remote/project',
      canonicalRoot: '/canonical/project',
      cacheKey: 'host-a:/canonical/project',
      config: {
        remoteRoot: '/remote/project',
        canonicalRoot: '/canonical/project',
        connect: async () => {
          throw new Error('not used')
        }
      }
    }),
    createHost: () => {
      hostsCreated += 1
      return host
    }
  })

  await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })
  await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })
  assert.equal(hostsCreated, 1)

  registry.releaseSession('session-a')
  await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })
  assert.equal(hostsCreated, 2)
})

test('remote workspace host registry releases a host after its connection fails', async () => {
  let hostsCreated = 0
  const registry = new RemoteWorkspaceHostRegistry({
    resolveBinding: (request) => ({
      sessionId: request.sessionId,
      projectId: request.projectId,
      hostAlias: 'cluster-a',
      remoteRoot: '/remote/project',
      canonicalRoot: '/canonical/project',
      cacheKey: 'host-a:/canonical/project',
      config: {
        remoteRoot: '/remote/project',
        canonicalRoot: '/canonical/project',
        connect: async () => {
          throw new Error('not used')
        }
      }
    }),
    createHost: () => {
      hostsCreated += 1
      return {
        fs: {} as WorkspaceHost['fs'],
        exec: {
          async run() {
            throw new Error('SSH connection lost')
          },
          async spawnBackground() {
            throw new Error('not used')
          }
        },
        capabilities() {
          throw new Error('not used')
        }
      }
    }
  })

  const first = await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })
  await assert.rejects(first.exec('true'), /connection lost/)
  await registry.connect({ sessionId: 'session-a', projectId: 'project-a' })

  assert.equal(hostsCreated, 2)
})
