import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import type { WebLinkPreview } from '../src/shared/webLinkPreviewTypes'
import { WebLinkPreviewCard } from '../src/renderer/src/components/markdown/WebLinkHoverCard'

const url = 'https://example.com/docs?lang=zh#setup'
const preview: WebLinkPreview = {
  url,
  resolvedUrl: 'https://example.com/docs',
  title: 'Project documentation',
  description: 'Read installation and usage instructions.',
  siteName: 'Example',
  iconDataUrl: null
}

function renderCard(overrides: Partial<Parameters<typeof WebLinkPreviewCard>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WebLinkPreviewCard, {
        url,
        label: 'Project docs',
        site: 'web',
        preview,
        loading: false,
        onOpen: () => undefined,
        ...overrides
      })
    )
  )
}

test('loading webpage previews use Skeleton placeholders and expose a busy state', () => {
  const markup = renderCard({ loading: true, preview: null })

  assert.match(markup, /data-phi-web-link-preview="loading"/)
  assert.match(markup, /aria-busy="true"/)
  assert.match(markup, /class="MuiSkeleton-root/)
  assert.doesNotMatch(markup, /暂无网页摘要/)
})

test('ready webpage previews show the fetched title and summary', () => {
  const markup = renderCard()

  assert.match(markup, /data-phi-web-link-preview="ready"/)
  assert.match(markup, />Project documentation</)
  assert.match(markup, />Read installation and usage instructions\.</)
})

test('webpage preview footer retains the full original URL while displaying a scheme-free address', () => {
  const markup = renderCard()

  assert.match(markup, /title="https:\/\/example\.com\/docs\?lang=zh#setup"/)
  assert.match(markup, />example\.com\/docs\?lang=zh#setup</)
})

test('unavailable webpage previews retain a useful custom label and fallback summary', () => {
  const markup = renderCard({ preview: null })

  assert.match(markup, /data-phi-web-link-preview="unavailable"/)
  assert.match(markup, />Project docs</)
  assert.match(markup, />暂无网页摘要</)
})

test('unavailable raw URL previews use the hostname as the fallback title', () => {
  const markup = renderCard({ preview: null, label: url })

  assert.match(markup, /data-phi-web-preview-title="true"[^>]*>example\.com</)
})

test('webpage preview titles and descriptions are bounded to two and three lines', () => {
  const markup = renderCard()

  assert.match(markup, /-webkit-line-clamp:2/)
  assert.match(markup, /-webkit-line-clamp:3/)
})

test('webpage previews render safe inline raster icons', () => {
  const iconDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
  const markup = renderCard({ preview: { ...preview, iconDataUrl } })

  assert.match(markup, /<img[^>]+src="data:image\/png;base64,/)
})

test('webpage previews never load remote icon URLs directly in the renderer', () => {
  const markup = renderCard({
    preview: { ...preview, iconDataUrl: 'https://tracker.example/icon.png' }
  })

  assert.doesNotMatch(markup, /<img/)
  assert.doesNotMatch(markup, /tracker\.example/)
})

test('webpage previews reject inline SVG icons', () => {
  const markup = renderCard({
    preview: { ...preview, iconDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }
  })

  assert.doesNotMatch(markup, /<img/)
})

test('webpage previews include an accessible open button', () => {
  const markup = renderCard()

  assert.match(markup, /<button[^>]+aria-label="打开网页"/)
})
