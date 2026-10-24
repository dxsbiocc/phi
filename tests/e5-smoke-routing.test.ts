import assert from 'node:assert/strict'
import test from 'node:test'
import { scopeE5RemoteFactory } from '../src/main/agent/engine/in-process-engine'
import type {
  RoutedSessionDriver,
  RoutedSessionFactory
} from '../src/main/agent/engine/session-routing-engine'
import type { PhiSessionCreateParams } from '../src/main/agent/engine/types'
import { E5_SMOKE_PROJECT_ID } from '../src/main/agent/remote-session-routing'

test('E5 factory selects smoke capabilities only for phi-test and preserves other SSH routes', async () => {
  const routed: string[] = []
  let smokeFactories = 0
  const makeFactory = (name: string): RoutedSessionFactory => ({
    create: async () => {
      routed.push(name)
      return { isLive: true } as RoutedSessionDriver
    }
  })
  const factory = scopeE5RemoteFactory(
    makeFactory('ordinary'),
    () => {
      smokeFactories++
      return makeFactory('smoke')
    },
    (projectId) => projectId === E5_SMOKE_PROJECT_ID
  )
  const input = (projectId: string): PhiSessionCreateParams =>
    ({ remoteProject: { projectId } }) as PhiSessionCreateParams
  const sink = { event: () => undefined, state: () => undefined }
  await factory.create(input('another-ssh-project'), new AbortController().signal, sink)
  assert.equal(smokeFactories, 0)
  await factory.create(input(E5_SMOKE_PROJECT_ID), new AbortController().signal, sink)
  assert.equal(smokeFactories, 1)
  assert.deepEqual(routed, ['ordinary', 'smoke'])
})
