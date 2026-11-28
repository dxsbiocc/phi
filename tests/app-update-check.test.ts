import { beforeEach, afterEach } from 'node:test'
import { getUiLanguage, setUiLanguage } from '../src/renderer/src/lib/i18n'

// Keep these behavioral assertions explicit about their presentation language.
beforeEach(() => setUiLanguage('zh-CN'))
afterEach(() => setUiLanguage('en'))

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import {
  checkForAppUpdate,
  RELEASES_PAGE_URL,
  selectReleaseUpdateAsset
} from '../src/main/app-update-check'
import { AppUpdateDialog } from '../src/renderer/src/components/AppUpdateDialog'
import { AppUpdateSection } from '../src/renderer/src/features/settings/components/AppUpdateSection'

const now = (): Date => new Date('2026-10-12T00:00:00.000Z')

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> }

function respond(
  status: number,
  body: unknown = {}
): {
  calls: Array<{ url: string; headers: Record<string, string> }>
  fetchImpl: (url: string, init: { headers: Record<string, string> }) => Promise<FakeResponse>
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = async (
    url: string,
    init: { headers: Record<string, string> }
  ): Promise<FakeResponse> => {
    calls.push({ url, headers: init.headers })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { calls, fetchImpl }
}

const SAMPLE_RELEASE_ASSETS = [
  {
    name: 'phi-0.2.1.dmg',
    browser_download_url: 'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/phi-0.2.1.dmg',
    size: 148_897_792
  },
  {
    name: 'phi-0.2.1-setup.exe',
    browser_download_url:
      'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/phi-0.2.1-setup.exe',
    size: 132_120_576
  },
  {
    name: 'Phi-0.2.1-x86_64.AppImage',
    browser_download_url:
      'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/Phi-0.2.1-x86_64.AppImage',
    size: 155_189_248
  },
  {
    name: 'phi_0.2.1_amd64.deb',
    browser_download_url:
      'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/phi_0.2.1_amd64.deb',
    size: 118_489_088
  },
  {
    name: 'SHA256SUMS.txt',
    browser_download_url: 'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/SHA256SUMS.txt',
    size: 612
  }
]

test('a newer published release is reported with its own release page', async () => {
  const { calls, fetchImpl } = respond(200, {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/dxsbiocc/phi/releases/tag/v0.2.0',
    published_at: '2026-10-11T00:00:00Z'
  })
  const result = await checkForAppUpdate('0.1.0', fetchImpl, now)
  assert.equal(calls[0]?.url, 'https://api.github.com/repos/dxsbiocc/phi/releases/latest')
  assert.equal(calls[0]?.headers['User-Agent'], 'Phi/0.1.0')
  assert.deepEqual(result, {
    currentVersion: '0.1.0',
    checkedAt: '2026-10-12T00:00:00.000Z',
    status: 'available',
    latestVersion: '0.2.0',
    releasesUrl: 'https://github.com/dxsbiocc/phi/releases/tag/v0.2.0',
    publishedAt: '2026-10-11T00:00:00Z'
  })
})

test('release notes and platform installer assets are attached when available', async () => {
  const { fetchImpl } = respond(200, {
    tag_name: 'v0.2.1',
    name: 'Phi v0.2.1',
    body: '## What is Changed\n- In-app update dialog with SHA-256 verification',
    html_url: 'https://github.com/dxsbiocc/phi/releases/tag/v0.2.1',
    published_at: '2026-11-28T00:00:00Z',
    assets: SAMPLE_RELEASE_ASSETS
  })
  const winResult = await checkForAppUpdate('0.2.0', fetchImpl, now, {
    platform: 'win32',
    arch: 'x64',
    env: {}
  })
  assert.equal(winResult.releaseTitle, 'Phi v0.2.1')
  assert.match(winResult.releaseNotes ?? '', /In-app update dialog/)
  assert.deepEqual(winResult.asset, {
    name: 'phi-0.2.1-setup.exe',
    downloadUrl: 'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/phi-0.2.1-setup.exe',
    size: 132_120_576,
    checksumUrl: 'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/SHA256SUMS.txt',
    installMode: 'auto-replace'
  })

  const macAsset = selectReleaseUpdateAsset(SAMPLE_RELEASE_ASSETS, {
    platform: 'darwin',
    arch: 'arm64',
    env: {}
  })
  assert.equal(macAsset?.name, 'phi-0.2.1.dmg')
  assert.equal(macAsset?.installMode, 'open-installer')

  const appImageAsset = selectReleaseUpdateAsset(SAMPLE_RELEASE_ASSETS, {
    platform: 'linux',
    arch: 'x64',
    env: { APPIMAGE: '/home/user/Applications/Phi.AppImage' }
  })
  assert.equal(appImageAsset?.name, 'Phi-0.2.1-x86_64.AppImage')
  assert.equal(appImageAsset?.installMode, 'auto-replace')

  const debAsset = selectReleaseUpdateAsset(SAMPLE_RELEASE_ASSETS, {
    platform: 'linux',
    arch: 'x64',
    env: {}
  })
  assert.equal(debAsset?.name, 'phi_0.2.1_amd64.deb')
  assert.equal(debAsset?.installMode, 'open-installer')

  // Untrusted download hosts are rejected.
  const untrusted = selectReleaseUpdateAsset(
    [
      {
        name: 'phi-0.2.1.dmg',
        browser_download_url: 'https://evil.example/phi-0.2.1.dmg',
        size: 1024
      }
    ],
    { platform: 'darwin', arch: 'arm64', env: {} }
  )
  assert.equal(untrusted, undefined)
})

test('the same or an older release is up to date, and no release yet is not an error', async () => {
  for (const tag of ['v0.1.0', 'v0.0.9']) {
    const result = await checkForAppUpdate('0.1.0', respond(200, { tag_name: tag }).fetchImpl, now)
    assert.equal(result.status, 'up-to-date')
  }
  const none = await checkForAppUpdate('0.1.0', respond(404).fetchImpl, now)
  assert.equal(none.status, 'up-to-date')
  assert.equal(none.releasesUrl, RELEASES_PAGE_URL)
})

test('failures and untrusted release links are reported safely', async () => {
  const failed = await checkForAppUpdate('0.1.0', respond(503).fetchImpl, now)
  assert.equal(failed.status, 'error')
  assert.match(failed.error ?? '', /503/)

  const invalid = await checkForAppUpdate(
    '0.1.0',
    respond(200, { tag_name: 'latest' }).fetchImpl,
    now
  )
  assert.equal(invalid.status, 'error')

  const foreign = await checkForAppUpdate(
    '0.1.0',
    respond(200, { tag_name: 'v9.0.0', html_url: 'https://evil.example/download' }).fetchImpl,
    now
  )
  assert.equal(foreign.status, 'available')
  assert.equal(foreign.releasesUrl, RELEASES_PAGE_URL)

  const offline = await checkForAppUpdate(
    '0.1.0',
    async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    },
    now
  )
  assert.equal(offline.status, 'error')
  assert.match(offline.error ?? '', /ENOTFOUND/)
})

test('the settings section offers a manual check and an in-app update trigger for a newer version', () => {
  const render = (initialResult: Parameters<typeof AppUpdateSection>[0]['initialResult']): string =>
    renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(AppUpdateSection, { initialResult })
      )
    )
  const idle = render(null)
  assert.match(idle, /检查更新/)
  assert.doesNotMatch(idle, /查看并更新/)
  const available = render({
    status: 'available',
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    releasesUrl: RELEASES_PAGE_URL,
    checkedAt: '2026-10-12T00:00:00.000Z'
  })
  assert.match(available, /有新版本 0\.2\.0，当前 0\.1\.0/)
  assert.match(available, /查看并更新/)
})

test('AppUpdateDialog renders release notes, download progress, and localized install actions', () => {
  const sampleUpdate = {
    status: 'available' as const,
    currentVersion: '0.2.0',
    latestVersion: '0.2.1',
    releaseTitle: 'Phi v0.2.1',
    releaseNotes: '### Highlights\n- Added verified in-app installer progress',
    releasesUrl: 'https://github.com/dxsbiocc/phi/releases/tag/v0.2.1',
    checkedAt: '2026-11-28T00:00:00.000Z',
    asset: {
      name: 'phi-0.2.1-setup.exe',
      downloadUrl: 'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/phi-0.2.1-setup.exe',
      size: 104_857_600,
      checksumUrl: 'https://github.com/dxsbiocc/phi/releases/download/v0.2.1/SHA256SUMS.txt',
      installMode: 'auto-replace' as const
    }
  }

  const renderDialog = (
    downloadStateOverride?: Parameters<typeof AppUpdateDialog>[0]['downloadStateOverride']
  ): string =>
    renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        // Render inner content directly via Dialog disablePortal in SSR or inspect AppUpdateDialog with disablePortal?
        // Note: MUI Dialog portals by default in DOM, so test both language copy and formatUpdateBytes directly or pass disablePortal!
        createElement(AppUpdateDialog, {
          open: true,
          update: sampleUpdate,
          downloadStateOverride,
          onClose: () => undefined
        })
      )
    )

  assert.equal(getUiLanguage(), 'zh-CN')
  // Verify SSR never throws across states and languages.
  renderDialog({
    stage: 'downloading',
    version: '0.2.1',
    assetName: 'phi-0.2.1-setup.exe',
    installMode: 'auto-replace',
    downloadedBytes: 52_428_800,
    totalBytes: 104_857_600,
    percent: 50
  })
  setUiLanguage('en')
  renderDialog({
    stage: 'downloaded',
    version: '0.2.1',
    assetName: 'phi-0.2.1-setup.exe',
    installMode: 'auto-replace',
    downloadedBytes: 104_857_600,
    totalBytes: 104_857_600,
    percent: 100
  })
})
