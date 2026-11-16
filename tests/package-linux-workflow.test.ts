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
          name?: string
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
  const named = (name: string): NonNullable<(typeof steps)[number]> => {
    const step = steps.find((candidate) => candidate.name === name)
    assert.ok(step, `missing workflow step: ${name}`)
    return step
  }
  const byUse = (prefix: string): NonNullable<(typeof steps)[number]> => {
    const step = steps.find((candidate) => candidate.uses?.startsWith(prefix))
    assert.ok(step, `missing workflow action: ${prefix}`)
    return step
  }

  assert.deepEqual(
    steps.filter((step) => step.uses).map((step) => step.uses),
    [
      'actions/checkout@v4.2.2',
      'oven-sh/setup-bun@v2.0.2',
      'actions/setup-node@v4.4.0',
      'actions/upload-artifact@v4.6.2'
    ]
  )
  assert.equal(byUse('oven-sh/setup-bun@').with?.['bun-version'], '1.3.14')
  assert.equal(byUse('actions/setup-node@').with?.['node-version'], '22.15.0')
  assert.equal(named('Install dependencies').run, 'bun install --frozen-lockfile')
  assert.equal(named('Typecheck').run, 'bun run typecheck')

  const build = named('Build Linux packages')
  const workerSmoke = named('Smoke-test the packaged worker without system bun')
  const kernelCheck = named('Check packaged kernels')
  const artifactCheck = named('Check package artifacts')
  const upload = named('Upload Linux packages')

  assert.match(build.run ?? '', /bun run build:linux/u)
  assert.match(
    workerSmoke.run ?? '',
    /smoke-packaged-worker\.mjs --resources dist\/linux-unpacked\/resources/u
  )
  assert.match(
    kernelCheck.run ?? '',
    /check-release-kernel\.ts --resources dist\/linux-unpacked\/resources/u
  )
  assert.match(artifactCheck.run ?? '', /dist\/\*\.AppImage/u)
  assert.match(artifactCheck.run ?? '', /dist\/\*\.deb/u)
  assert.match(artifactCheck.run ?? '', /sha256sum/u)
  assert.equal(upload.with?.['if-no-files-found'], 'error')
  assert.equal(upload.with?.path, 'dist/*.AppImage\ndist/*.deb\n')

  const order = [build, workerSmoke, kernelCheck, artifactCheck, upload].map((step) =>
    steps.indexOf(step)
  )
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right)
  )
  assert.ok(order.every((index) => index >= 0))

  // The checker's own name contains "release"; only workflow/publish behavior is forbidden.
  for (const forbidden of ['pull_request:', 'push:', 'bun run lint', 'publish', 'gh release']) {
    assert.equal(
      workflowText.includes(forbidden),
      false,
      `unexpected workflow behavior: ${forbidden}`
    )
  }
})
