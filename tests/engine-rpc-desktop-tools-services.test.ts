import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { validateRemotePresentedFiles } from '../src/main/agent/deliverables/remote-present-files'
import { wrapperJobHostHandlers } from '../src/main/agent/wrappers/composition/job-host-handlers'
import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'
import { WRAPPER_CATALOG_HOST_METHODS } from '../src/main/agent/wrappers/composition/job-types'
import { writeGffreadFixture } from './helpers/compositionFixtures'

test('remote present validation preserves SSH references and descriptions', async () => {
  let inspected = 0
  const files = await validateRemotePresentedFiles(
    { sessionId: 'phi-session', projectId: 'project' },
    [{ path: 'reports/final.txt', description: 'Final report' }],
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
  assert.deepEqual(files, [
    {
      path: 'ssh://selected/server/project/reports/final.txt',
      displayPath: 'reports/final.txt',
      bytes: 31,
      description: 'Final report'
    }
  ])
  assert.equal(inspected, 1)
  await assert.rejects(
    validateRemotePresentedFiles(
      { sessionId: 'phi-session', projectId: 'project' },
      [{ path: '../desktop-file' }],
      { inspect: async () => assert.fail('invalid path must not be inspected') }
    )
  )
  assert.equal(inspected, 1)
})

test('wrapper handlers discover the real catalog and refuse an unavailable project', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-services-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const origins: Array<string | undefined> = []
  const jobs = new WrapperJobManager({
    agentDir: () => join(root, 'agent'),
    resolveProjectForRun: (origin) => {
      origins.push(origin)
      return undefined
    }
  })
  const sourceRoot = join(root, 'desktop-wrapper-catalog')
  writeGffreadFixture(sourceRoot)
  const handlers = wrapperJobHostHandlers(jobs, { discovery: { sourceRoot } })

  const searched = (await handlers[WRAPPER_CATALOG_HOST_METHODS.search]({
    query: 'annotation conversion'
  })) as { details: { results: Array<{ id: string }> } }
  assert.deepEqual(
    searched.details.results.map((entry) => entry.id),
    ['nf-core/modules/gffread']
  )
  const inspected = (await handlers[WRAPPER_CATALOG_HOST_METHODS.inspect]({
    id: 'nf-core/modules/gffread'
  })) as { details: { manifest: { id: string } } }
  assert.equal(inspected.details.manifest.id, 'nf-core/modules/gffread')

  const unavailable = (await handlers['wrapperJob.start']({
    id: 'synthetic/missing-wrapper',
    originSessionId: 'runtime-session'
  })) as { error?: string }
  assert.match(unavailable.error ?? '', /拒绝本机执行/)
  assert.deepEqual(origins, ['runtime-session'])

  assert.equal(await handlers['wrapperJob.status']({ runId: 'missing-run' }), undefined)
})
