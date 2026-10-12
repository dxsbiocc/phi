import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parse } from 'yaml'

type Step = {
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
}
type Job = {
  needs?: string | string[]
  if?: string
  permissions?: Record<string, string>
  strategy?: { matrix?: { include?: Array<Record<string, string>> } }
  steps?: Step[]
}

const workflowText = readFileSync('.github/workflows/release.yml', 'utf8')
const workflow = parse(workflowText) as {
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  jobs?: Record<string, Job>
}

test('releases are drafted only from version tags, never published automatically', () => {
  assert.deepEqual(Object.keys(workflow.on ?? {}).sort(), [
    'pull_request',
    'push',
    'workflow_dispatch'
  ])
  assert.deepEqual(workflow.on?.push, { tags: ['v*'] })
  assert.deepEqual(workflow.permissions, { contents: 'read' })

  const draft = workflow.jobs?.['draft-release']
  assert.equal(draft?.if, "startsWith(github.ref, 'refs/tags/v')")
  assert.deepEqual(draft?.permissions, { contents: 'write' })
  const create = draft?.steps?.find((step) => step.name === 'Create draft release')
  assert.match(create?.run ?? '', /gh release create "\$GITHUB_REF_NAME"/)
  assert.match(create?.run ?? '', /--draft/)
  // Only the draft job may write; packaging jobs stay read-only.
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    if (name !== 'draft-release') assert.equal(job.permissions, undefined, name)
  }
  const verify = workflow.jobs?.verify?.steps?.find((step) => step.name?.startsWith('Tag matches'))
  assert.match(verify?.run ?? '', /package\.json/)
})

test('packages macOS arm64 and Linux x64, smoke-testing the bundled worker on both', () => {
  const pkg = workflow.jobs?.package
  assert.deepEqual(
    pkg?.strategy?.matrix?.include?.map((entry) => [entry.os, entry.builder]),
    [
      ['macos-14', '--mac dmg zip --arm64'],
      ['ubuntu-22.04', '--linux AppImage deb --x64']
    ]
  )
  const steps = pkg?.steps ?? []
  const smoke = steps.find((step) => step.run?.includes('smoke-packaged-worker.mjs'))
  assert.ok(smoke, 'packaged worker smoke test runs')
  assert.match(smoke?.run ?? '', /dist\/mac-arm64\/Phi\.app\/Contents\/Resources/)
  assert.match(smoke?.run ?? '', /dist\/linux-unpacked\/resources/)
  const packageStep = steps.find((step) => step.name === 'Package')
  assert.match(packageStep?.run ?? '', /--publish never/)
})

test('macOS signing uses a certificate when configured and ad-hoc signing otherwise', () => {
  const steps = workflow.jobs?.package?.steps ?? []
  const choose = steps.find((step) => step.name === 'Choose macOS signing')
  assert.equal(choose?.if, "runner.os == 'macOS'")
  assert.match(choose?.run ?? '', /-c\.mac\.identity=- -c\.mac\.hardenedRuntime=false/)
  assert.match(choose?.run ?? '', /-c\.mac\.notarize=true/)
  const verify = steps.find((step) => step.name === 'Check macOS signature')
  assert.match(verify?.run ?? '', /codesign --verify --deep --strict/)
  // Secrets reach the tools through env only; nothing prints them.
  assert.equal(/echo[^\n]*secrets\./.test(workflowText), false)
  assert.equal(
    /echo[^\n]*\$(CSC_KEY_PASSWORD|APPLE_APP_SPECIFIC_PASSWORD)/.test(workflowText),
    false
  )
})

test('local packaging scripts never publish, even on CI', () => {
  const scripts = (
    JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts
  for (const name of ['build:unpack', 'build:win', 'build:mac', 'build:linux']) {
    assert.match(scripts[name] ?? '', /electron-builder .*--publish never$/, name)
  }
})
