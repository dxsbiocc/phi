import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parse } from 'yaml'

const builderText = readFileSync('electron-builder.yml', 'utf8')
const builder = parse(builderText) as Record<string, unknown> & {
  appId?: string
  productName?: string
  linux?: { maintainer?: string }
  mac?: { extendInfo?: Record<string, string | null> }
  publish?: { provider?: string; url?: string }
}
const packageText = readFileSync('package.json', 'utf8')
const packageJson = JSON.parse(packageText) as {
  name?: string
  version?: string
  description?: string
  author?: string
  homepage?: string
}

test('release branding freezes the Phi identity while preserving the future update URL', () => {
  assert.equal(builder.appId, 'cn.phiscience.phi')
  assert.equal(builder.productName, 'Phi')
  assert.equal(builder.linux?.maintainer, 'Phi Science')

  assert.deepEqual(packageJson, {
    ...packageJson,
    name: 'phi',
    version: '0.1.0',
    description: 'A local desktop workbench for scientific AI workflows',
    author: 'Phi Science',
    homepage: 'https://phiscience.cn'
  })

  assert.equal(builder.publish?.url, 'https://example.com/auto-updates')
  const builderWithoutPublish = Object.fromEntries(
    Object.entries(builder).filter(([key]) => key !== 'publish')
  )
  const brandedMetadata = JSON.stringify({ builder: builderWithoutPublish, package: packageJson })
  for (const templateValue of [
    'com.electron.app',
    'electronjs.org',
    'electron-vite.org',
    'example.com'
  ]) {
    assert.equal(
      brandedMetadata.includes(templateValue),
      false,
      `found template value: ${templateValue}`
    )
  }

  assert.notEqual(builder.productName, 'pi-desktop')
  assert.notEqual(packageJson.name, 'pi-desktop')
  assert.equal(
    builderText.match(/example\.com/g)?.length,
    1,
    'publish.url is the sole example.com exception'
  )
  assert.equal(packageText.includes('example.com'), false)
})

test('macOS permission descriptions match the file workflows Phi actually uses', () => {
  assert.deepEqual(builder.mac?.extendInfo, {
    NSAudioCaptureUsageDescription: null,
    NSCameraUsageDescription: null,
    NSMicrophoneUsageDescription: null,
    NSDocumentsFolderUsageDescription:
      'Phi accesses documents and project files you choose to open.',
    NSDownloadsFolderUsageDescription: 'Phi saves exported and downloaded results where you choose.'
  })
})
