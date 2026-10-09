import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parse } from 'yaml'

const builderText = readFileSync('electron-builder.yml', 'utf8')
const builder = parse(builderText) as Record<string, unknown> & {
  appId?: string
  productName?: string
  linux?: {
    category?: string
    description?: string
    desktop?: { entry?: Record<string, string> }
    executableName?: string
    icon?: string
    maintainer?: string
    synopsis?: string
    target?: Array<{ target?: string; arch?: string[] }>
  }
  appImage?: { artifactName?: string }
  files?: string[]
  mac?: {
    extendInfo?: Record<string, string | null>
    extraResources?: Array<{ from?: string; to?: string }>
  }
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

test('Linux packages are branded x64 AppImage and deb artifacts with desktop metadata', () => {
  assert.equal(builder.linux?.executableName, 'phi')
  assert.equal(builder.linux?.icon, 'build/icon.png')
  assert.deepEqual(builder.linux?.target, [
    { target: 'AppImage', arch: ['x64'] },
    { target: 'deb', arch: ['x64'] }
  ])
  assert.equal(builder.linux?.category, 'Utility')
  assert.equal(builder.linux?.synopsis, 'Local scientific AI workbench')
  assert.equal(builder.linux?.description, 'A local desktop workbench for scientific AI workflows')
  assert.deepEqual(builder.linux?.desktop?.entry, { Name: 'Phi', Icon: 'phi' })
  assert.equal(builder.appImage?.artifactName, 'Phi-${version}-${arch}.${ext}')
  assert.equal(builderText.includes('snap'), false)
})

test('officecli stays out of every packaged application', () => {
  assert.ok(builder.files?.includes('!resources/office/officecli/**'))
  assert.equal(
    builder.mac?.extraResources?.some((entry) => entry.from?.includes('office/officecli')),
    false
  )
})
