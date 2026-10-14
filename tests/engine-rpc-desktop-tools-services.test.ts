import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { validateRemotePresentedFiles } from '../src/main/agent/deliverables/remote-present-files'
import { wrapperJobHostHandlers } from '../src/main/agent/wrappers/composition/job-host-handlers'
import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'
import { desktopToolsFixture } from './helpers/rpcDesktopToolsFixture'

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

test('remote present builder invokes existing remote validation and preserves SSH references/details', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  let inspected = 0
  f.services.register('deliverables.present', async (params, context) => {
    const request = record(params)
    assert.equal(request.runtimeSessionId, 'runtime-session')
    assert.equal(request.toolCallId, 'present-call')
    assert.ok(context.signal instanceof AbortSignal)
    assert.deepEqual(
      { originSessionId: context.originSessionId, toolCallId: context.toolCallId },
      { originSessionId: 'runtime-session', toolCallId: 'present-call' }
    )
    return {
      files: await validateRemotePresentedFiles(
        { sessionId: 'phi-session', projectId: 'project' },
        request.files,
        {
          inspect: async (path, identity) => {
            assert.deepEqual(identity, { sessionId: 'phi-session', projectId: 'project' })
            assert.equal(path, 'reports/final.txt')
            inspected++
            return {
              path: 'ssh://selected/server/project/reports/final.txt',
              displayPath: 'reports/final.txt',
              bytes: 31,
              identity: '/server/project/reports/final.txt'
            }
          }
        }
      )
    }
  })
  const output = await f.call(
    'present_files',
    { files: [{ path: 'reports/final.txt', description: 'Final report' }] },
    'present-call'
  )
  assert.equal(output.isError, undefined)
  assert.deepEqual(output.details, {
    kind: 'presented_files',
    files: [
      {
        path: 'ssh://selected/server/project/reports/final.txt',
        displayPath: 'reports/final.txt',
        bytes: 31,
        description: 'Final report'
      }
    ]
  })
  assert.equal(inspected, 1)
  const invalid = await f.call(
    'present_files',
    { files: [{ path: '../desktop-file' }] },
    'present-call'
  )
  assert.equal(invalid.isError, true)
  assert.equal(inspected, 1)
})

test('real wrapper host client/handler/manager preserve trusted origin and unavailable project refuses execution', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  const origins: Array<string | undefined> = []
  const jobs = new WrapperJobManager({
    agentDir: () => join(f.root, 'agent'),
    resolveProjectForRun: (origin) => {
      origins.push(origin)
      return undefined
    }
  })
  const methods: string[] = []
  for (const [method, handler] of Object.entries(wrapperJobHostHandlers(jobs)))
    f.services.register(method, (params, context) => {
      methods.push(method)
      assert.equal(context.originSessionId, 'runtime-session')
      assert.equal(context.toolCallId, 'wrapper-call')
      return handler(params)
    })
  const unavailable = await f.call(
    'wrapper_run',
    { id: 'synthetic/missing-wrapper', originSessionId: 'forged' },
    'wrapper-call'
  )
  assert.equal(unavailable.isError, true)
  assert.deepEqual(origins, ['runtime-session'])
  assert.deepEqual(methods, ['wrapperJob.start'])
  await assert.rejects(
    f.call('wrapper_run', { id: 'synthetic/missing-wrapper', target: 'local' }, 'wrapper-call'),
    /cannot run a wrapper on the desktop/
  )
  assert.deepEqual(methods, ['wrapperJob.start'])
  const status = await f.call('wrapper_status', { run_id: 'missing-run' }, 'wrapper-call')
  assert.equal(status.isError, true)
  assert.deepEqual(methods, ['wrapperJob.start', 'wrapperJob.status'])
})
