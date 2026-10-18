import { beforeEach, afterEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'

// Keep these legacy behavioral assertions explicit about their presentation language.
beforeEach(() => setUiLanguage('zh-CN'))
afterEach(() => setUiLanguage('en'))

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import { checkForAppUpdate, RELEASES_PAGE_URL } from '../src/main/app-update-check'
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

test('the settings section offers a manual check and a download link for a newer version', () => {
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
  assert.doesNotMatch(idle, /前往下载/)
  const available = render({
    status: 'available',
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    releasesUrl: RELEASES_PAGE_URL,
    checkedAt: '2026-10-12T00:00:00.000Z'
  })
  assert.match(available, /有新版本 0\.2\.0，当前 0\.1\.0/)
  assert.match(available, /前往下载/)
})
