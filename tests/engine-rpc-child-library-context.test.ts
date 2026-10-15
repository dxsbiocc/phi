import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteLibraryService } from '../src/main/agent/engine/rpc/remote-library-service'

const request = {
  runtimeSessionId: 'parent-runtime',
  sessionId: 'phi-one',
  projectId: 'project-one',
  requestId: 'library-request',
  toolCallId: 'library-call',
  action: 'audit',
  input: {}
}
test('library workspace selection retains the independently verified child sideband', async () => {
  const stopped = new Error('stop before workspace IO')
  const context = Object.freeze({
    originSessionId: 'parent-runtime',
    toolCallId: 'library-call',
    agentRunId: 'private-child'
  })
  let calls = 0
  const service = new RemoteLibraryService((identity, signal, actualContext) => {
    calls++
    assert.equal(identity.runtimeSessionId, 'parent-runtime')
    assert.equal(actualContext, context)
    assert.equal(actualContext.agentRunId, 'private-child')
    assert.equal(signal.aborted, false)
    throw stopped
  })
  await assert.rejects(service.execute(request, context), (error) => error === stopped)
  assert.equal(calls, 1)
  service.dispose()
})
test('a model-supplied child identity cannot replace the library caller sideband', async () => {
  let calls = 0
  const service = new RemoteLibraryService(() => {
    calls++
    throw new Error('unexpected IO')
  })
  await assert.rejects(
    service.execute(
      { ...request, agentRunId: 'forged-child' },
      {
        originSessionId: 'parent-runtime',
        toolCallId: 'library-call'
      }
    ),
    /trusted tool scope/
  )
  assert.equal(calls, 0)
  service.dispose()
})
test('an ended child cannot acquire a library workspace even if its parent still exists', async () => {
  const child = new AbortController()
  child.abort(new Error('owned child stopped'))
  let calls = 0
  const service = new RemoteLibraryService(() => {
    calls++
    throw new Error('unexpected workspace')
  })
  await assert.rejects(
    service.execute(request, {
      originSessionId: 'parent-runtime',
      toolCallId: 'library-call',
      agentRunId: 'private-child',
      signal: child.signal
    }),
    /owned child stopped/
  )
  assert.equal(calls, 0)
  service.dispose()
})
