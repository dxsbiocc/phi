import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parse } from 'yaml'

test('Linux packaging workflow is manual, least-privilege, and uploads checked x64 artifacts', () => {
  const workflowText = readFileSync('.github/workflows/package-linux.yml', 'utf8')
  const workflow = parse(workflowText) as {
    on?: Record<string, unknown>
    permissions?: Record<string, string>
    jobs?: {
      package?: {
        'runs-on'?: string
        steps?: Array<{
          uses?: string
          run?: string
          with?: Record<string, string>
        }>
      }
    }
  }

  assert.deepEqual(Object.keys(workflow.on ?? {}), ['workflow_dispatch'])
  assert.deepEqual(workflow.permissions, { contents: 'read' })

  const job = workflow.jobs?.package
  assert.equal(job?.['runs-on'], 'ubuntu-22.04')
  const steps = job?.steps ?? []
  assert.deepEqual(
    steps.filter((step) => step.uses).map((step) => step.uses),
    [
      'actions/checkout@v4.2.2',
      'oven-sh/setup-bun@v2.0.2',
      'actions/setup-node@v4.4.0',
      'actions/upload-artifact@v4.6.2'
    ]
  )
  assert.equal(steps[1]?.with?.['bun-version'], '1.3.14')
  assert.equal(steps[2]?.with?.['node-version'], '22.15.0')
  assert.deepEqual(
    steps.filter((step) => step.run).map((step) => step.run),
    ['bun install --frozen-lockfile', 'bun run typecheck', 'bun run build:linux', steps[6]?.run]
  )
  assert.match(steps[6]?.run ?? '', /dist\/\*\.AppImage/u)
  assert.match(steps[6]?.run ?? '', /dist\/\*\.deb/u)
  assert.match(steps[6]?.run ?? '', /sha256sum/u)
  assert.equal(steps[7]?.with?.['if-no-files-found'], 'error')
  assert.equal(steps[7]?.with?.path, 'dist/*.AppImage\ndist/*.deb\n')

  for (const forbidden of ['pull_request:', 'push:', 'bun run lint', 'publish', 'release']) {
    assert.equal(
      workflowText.includes(forbidden),
      false,
      `unexpected workflow behavior: ${forbidden}`
    )
  }
})
