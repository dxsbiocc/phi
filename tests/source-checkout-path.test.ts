import assert from 'node:assert/strict'
import test from 'node:test'

import { isPackagedBundleDir, sourceCheckoutPath } from '../src/main/source-checkout-path'

const repo = '/Users/me/Phi'
const workerSource = `${repo}/src/main/agent/engine/in-process/main.ts`
const exists = (path: string): boolean => path === workerSource

test('a dev bundle prefers the source checkout in the working directory', () => {
  assert.equal(
    sourceCheckoutPath('src/main/agent/engine/in-process/main.ts', `${repo}/out/main`, {
      cwd: repo,
      exists
    }),
    workerSource
  )
  assert.equal(
    sourceCheckoutPath('src/main/terminal/host.ts', `${repo}/out/main`, { cwd: repo, exists }),
    null
  )
})

test('a packaged bundle ignores a source checkout in the working directory', () => {
  for (const bundleDir of [
    '/Applications/Phi.app/Contents/Resources/app.asar/out/main',
    '/Applications/Phi.app/Contents/Resources/app.asar.unpacked/out/main',
    'C:\\Program Files\\Phi\\resources\\app.asar\\out\\main'
  ]) {
    assert.equal(isPackagedBundleDir(bundleDir), true, bundleDir)
    assert.equal(
      sourceCheckoutPath('src/main/agent/engine/in-process/main.ts', bundleDir, {
        cwd: repo,
        exists
      }),
      null,
      bundleDir
    )
  }
})

test('only an asar path segment marks a bundle as packaged', () => {
  assert.equal(isPackagedBundleDir('/work/my.asar-notes/out/main'), false)
  assert.equal(isPackagedBundleDir('/work/Phi/out/main'), false)
})
