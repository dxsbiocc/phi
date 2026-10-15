import assert from 'node:assert/strict'
import test from 'node:test'
import { NotebookAiGenerationJobs } from '../src/main/agent/notebook/notebook-ai-generation-jobs'

const request = {
  requestId: 'draft-1',
  projectCwd: '/projects/research',
  notebookPath: '/projects/research/notebooks/qc.ipynb',
  notebookName: 'qc.ipynb',
  model: 'openai/test',
  prompt: 'Summarize the data'
}

test('Notebook AI jobs expose phase transitions, timestamps and detached snapshots', () => {
  let milliseconds = Date.parse('2026-10-15T02:00:00.000Z')
  const jobs = new NotebookAiGenerationJobs(() => new Date(milliseconds))
  const handle = jobs.begin(request)
  const initial = jobs.list()[0]
  assert.equal(initial.state, 'running')
  assert.equal(initial.phase, 'preparing')
  assert.equal(initial.updatedAt, initial.startedAt)

  milliseconds += 1_000
  handle.update('waiting')
  assert.equal(jobs.list()[0].phase, 'waiting')
  assert.equal(jobs.list()[0].updatedAt, '2026-10-15T02:00:01.000Z')
  handle.update('generating', { sourcePreview: 'result = df.describe()', cellCount: 1 })
  const streaming = jobs.list()[0]
  handle.update('repairing')
  assert.equal(jobs.list()[0].phase, 'repairing')
  assert.equal(streaming.phase, 'generating')
  streaming.sourcePreview = 'modified by observer'
  assert.equal(jobs.list()[0].sourcePreview, 'result = df.describe()')

  milliseconds += 2_000
  handle.complete({ sourcePreview: 'df.describe()', cellCount: 2 })
  const completed = jobs.list()[0]
  assert.equal(completed.state, 'completed')
  assert.equal(completed.phase, 'completed')
  assert.equal(completed.completedAt, '2026-10-15T02:00:03.000Z')
  assert.equal(completed.updatedAt, completed.completedAt)
  assert.equal(completed.cellCount, 2)
  handle.update('generating', { sourcePreview: 'late output' })
  handle.fail(new Error('late failure'))
  assert.deepEqual(jobs.list()[0], completed)
})

test('attempts sharing a draft request have independent IDs and project metadata, newest first', () => {
  const jobs = new NotebookAiGenerationJobs(() => new Date('2026-10-15T02:00:00.000Z'))
  const first = jobs.begin(request)
  const second = jobs.begin({ ...request, projectCwd: 'phi-remote://gpu/project' })
  assert.notEqual(first.id, second.id)
  assert.notEqual(first.id, request.requestId)
  assert.deepEqual(
    jobs.list().map((job) => job.id),
    [second.id, first.id]
  )
  first.fail(new Error('provider unavailable'))
  assert.equal(jobs.list()[0].state, 'running')
  assert.equal(jobs.list()[0].projectCwd, 'phi-remote://gpu/project')
  assert.equal(jobs.list()[1].error, 'provider unavailable')
  assert.ok(jobs.list()[1].completedAt)
  const uncorrelated = jobs.begin({ ...request, requestId: undefined })
  assert.equal(jobs.list()[0].requestId, uncorrelated.id)
})

test('only the newest 50 finished attempts are kept, without evicting active jobs', () => {
  const jobs = new NotebookAiGenerationJobs()
  const active = Array.from({ length: 60 }, () => jobs.begin(request))
  for (let index = 0; index < 75; index += 1) {
    const job = jobs.begin({ ...request, prompt: `Attempt ${index}` })
    if (index % 2) job.fail('provider error')
    else job.complete({ sourcePreview: 'df.head()', cellCount: 1 })
  }
  const snapshot = jobs.list()
  assert.equal(snapshot.length, 110)
  assert.equal(snapshot.filter((job) => job.state !== 'running').length, 50)
  assert.deepEqual(
    snapshot.slice(50).map((job) => job.id),
    active.map((job) => job.id).reverse()
  )
  assert.equal(snapshot[0].prompt, 'Attempt 74')
  assert.equal(snapshot[49].prompt, 'Attempt 25')
})

test('job prompts, generated previews and errors remain bounded', () => {
  const jobs = new NotebookAiGenerationJobs()
  const handle = jobs.begin({ ...request, prompt: 'p'.repeat(100_000) })
  handle.update('generating', { sourcePreview: 's'.repeat(100_000), cellCount: 1 })
  assert.equal(jobs.list()[0].prompt.length, 4_000)
  assert.equal(jobs.list()[0].sourcePreview?.length, 20_000)
  handle.fail(new Error('e'.repeat(100_000)))
  assert.equal(jobs.list()[0].error?.length, 4_000)
  assert.equal(jobs.list()[0].phase, 'failed')
  assert.ok(jobs.list()[0].completedAt)
  const completed = jobs.begin(request)
  completed.complete({ sourcePreview: 'c'.repeat(100_000), cellCount: 3 })
  assert.equal(jobs.list()[0].sourcePreview?.length, 20_000)
})
