import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider, type Theme } from '@mui/material'
import MarkdownContent from '../src/renderer/src/components/MarkdownContent'
import { createAppTheme } from '../src/renderer/src/theme'

function renderMarkdown(text: string, theme: Theme = createTheme()): string {
  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme }, createElement(MarkdownContent, { text }))
  )
}

test('markdown code blocks show language labels and copy controls', () => {
  const markup = renderMarkdown('```ts\nconst answer = 42\n```')

  assert.match(markup, /ts/)
  assert.match(markup, /复制/)
  assert.match(markup, /const answer = 42/)
})

test('markdown code blocks fall back to a generic label without a language', () => {
  const markup = renderMarkdown('```\nplain text\n```')

  assert.match(markup, /代码/)
  assert.match(markup, /plain text/)
})

test('markdown code blocks use theme surfaces instead of hard-coded dark panels', () => {
  const markup = renderMarkdown('```ts\nconst answer = 42\n```', createAppTheme('light'))

  assert.match(markup, /rgba\(46, 159, 179, 0\.035\)/)
  assert.match(markup, /rgba\(46, 159, 179, 0\.06\)/)
  assert.doesNotMatch(markup, /rgba\(0, 0, 0, 0\.35\)/)
  assert.doesNotMatch(markup, /rgba\(15, 23, 42, 0\.5\)/)
})

test('markdown paragraphs render hex colors with swatches', () => {
  const markup = renderMarkdown('Google #4285F4 / #EA4335 / #FBBC05')

  assert.match(markup, /data-phi-slot="markdown-color-token"/)
  assert.match(markup, /data-phi-slot="markdown-color-swatch"/)
  assert.match(markup, /width:14px/)
  assert.match(markup, /height:14px/)
  assert.match(markup, /border-radius:50%/)
  assert.match(markup, /box-sizing:border-box/)
  assert.match(markup, /style="background-color:#4285F4"/)
  assert.match(markup, /style="background-color:#EA4335"/)
  assert.match(markup, /style="background-color:#FBBC05"/)
  assert.match(markup, /#4285F4/)
})

test('markdown inline code renders pure hex colors with swatches', () => {
  const markup = renderMarkdown('Use `#0072B2` for blue.')

  assert.match(markup, /data-phi-slot="markdown-color-token"/)
  assert.match(markup, /style="background-color:#0072B2"/)
  assert.match(markup, /#0072B2/)
})

test('markdown color swatches work inside emphasis and tables', () => {
  const markup = renderMarkdown(
    '**Blue #0072B2**\n\n| Name | Color |\n| --- | --- |\n| red | #D55E00 |'
  )

  assert.match(markup, /style="background-color:#0072B2"/)
  assert.match(markup, /style="background-color:#D55E00"/)
})

test('markdown latex colorbox output becomes a swatch palette instead of raw control text', () => {
  const markup = renderMarkdown(
    'Google $$\\colorbox{#4285F4}{\\textcolor{white}{\\texttt{#4285F4}}}\\quad\\colorbox{#EA4335}{\\textcolor{white}{\\texttt{#EA4335}}}$$'
  )

  assert.match(markup, /data-phi-slot="markdown-color-palette"/)
  assert.match(markup, /style="background-color:#4285F4"/)
  assert.match(markup, /style="background-color:#EA4335"/)
  assert.doesNotMatch(markup, /\\colorbox/)
  assert.doesNotMatch(markup, /\\textcolor/)
  assert.doesNotMatch(markup, /\\quad/)
})

test('markdown paragraphs render local paths as reveal buttons', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: 'See ./src/App.tsx and /Users/example/project/README.md.',
        cwd: '/Users/example/project'
      })
    )
  )

  assert.match(markup, /title="\/Users\/example\/project\/src\/App.tsx"/)
  assert.match(markup, /title="\/Users\/example\/project\/README.md"/)
  assert.match(markup, /README.md<\/button>\./)
})

test('markdown code blocks do not linkify paths inside code', () => {
  const markup = renderMarkdown('```sh\ncat ./src/App.tsx\n```')

  assert.doesNotMatch(markup, /title="\/Users\/example\/project\/src\/App.tsx"/)
  assert.match(markup, /cat \.\/src\/App.tsx/)
})

test('markdown rendering drops raw html', () => {
  const markup = renderMarkdown(
    'safe **text** <img src=x onerror=alert(1)> <script>alert(2)</script>'
  )

  assert.match(markup, /safe/)
  assert.match(markup, /text/)
  assert.doesNotMatch(markup, /<img/)
  assert.doesNotMatch(markup, /onerror/)
  assert.doesNotMatch(markup, /<script/)
})
