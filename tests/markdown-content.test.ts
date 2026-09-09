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

test('markdown paragraphs render local paths as file preview links', () => {
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

  assert.match(markup, /data-phi-slot="local-file-link"/)
  assert.match(markup, /data-phi-file-kind="react"/)
  assert.match(markup, /data-phi-file-kind="markdown"/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project\/src\/App.tsx"/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project\/README.md"/)
  assert.match(markup, /打开文件 \/Users\/example\/project\/README.md/)
  assert.match(markup, /data-phi-hover-preview-path="\/Users\/example\/project\/README.md"/)
  assert.match(markup, /README.md<\/span><\/button>/)
  assert.doesNotMatch(markup, /\.\/src\/App.tsx<\/span>/)
})

test('markdown file links use tiered hover previews without embedding media inline', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: 'Outputs: stacked_bar.png, report.pdf.',
        cwd: '/Users/example/project'
      })
    )
  )
  const hoverPreviewSlots = markup.match(/data-phi-slot="local-file-hover-preview"/g) ?? []

  assert.equal(hoverPreviewSlots.length, 2)
  assert.match(markup, /data-phi-hover-preview-path="\/Users\/example\/project\/stacked_bar\.png"/)
  assert.match(markup, /data-phi-hover-preview-path="\/Users\/example\/project\/report\.pdf"/)
  assert.match(markup, /data-phi-file-kind="image"/)
  assert.match(markup, /data-phi-file-kind="pdf"/)
  assert.doesNotMatch(markup, /data-phi-slot="local-file-hover-image"/)
})

test('markdown current-directory links render directory icons', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: '当前目录（[test](/Users/example/project)）内容：另外看 ./outputs/。',
        cwd: '/Users/example/project'
      })
    )
  )

  assert.match(markup, /data-phi-file-kind="directory"/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project"/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project\/outputs"/)
  assert.match(markup, /打开目录 \/Users\/example\/project/)
  assert.match(markup, /lucide-folder/)
  assert.match(markup, />test<\/span><\/button>/)
  assert.doesNotMatch(markup, /data-phi-file-kind="text"/)
})

test('markdown paragraphs render bare file names with representative icons', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: 'Files: stacked_bar.R, main.py, test.py, analysis.ipynb, .env.local, data.json, pyproject.toml, uv.lock, README.md, .python-version, version 1.2.3.',
        cwd: '/Users/example/project'
      })
    )
  )

  assert.match(markup, /data-phi-path="\/Users\/example\/project\/stacked_bar\.R"/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project\/test\.py"/)
  assert.match(markup, /data-phi-file-kind="r"/)
  assert.match(markup, /data-phi-file-kind="python"/)
  assert.match(markup, /data-phi-file-kind="jupyter"/)
  assert.match(markup, /data-phi-file-kind="dotenv"/)
  assert.match(markup, /data-phi-file-kind="json"/)
  assert.match(markup, /data-phi-file-kind="toml"/)
  assert.match(markup, /data-phi-file-kind="lock"/)
  assert.match(markup, /data-phi-file-kind="markdown"/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project\/\.python-version"/)
  assert.doesNotMatch(markup, /data-phi-path="\/Users\/example\/project\/1\.2\.3"/)
})

test('markdown inline code file names render as file preview links', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: '`main.py`, `README.md`, `src/renderer/App.tsx`, `.gitignore`, `List/ListItem`, and `--watch`',
        cwd: '/Users/example/project'
      })
    )
  )

  assert.match(markup, /data-phi-path="\/Users\/example\/project\/main\.py"/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project\/README\.md"/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project\/src\/renderer\/App\.tsx"/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project\/\.gitignore"/)
  assert.match(markup, /data-phi-file-kind="python"/)
  assert.match(markup, /data-phi-file-kind="react"/)
  assert.match(markup, /data-phi-file-kind="config"/)
  assert.match(markup, />main\.py<\/span><\/button>/)
  assert.doesNotMatch(markup, /data-phi-path="\/Users\/example\/project\/List\/ListItem"/)
  assert.match(markup, />List\/ListItem<\/code>/)
  assert.doesNotMatch(markup, /data-phi-path="\/Users\/example\/project\/--watch"/)
})

test('markdown local file links open as preview links while web links remain external', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: '[src/renderer/src/components/SettingsDialog.tsx](/Users/example/project/src/renderer/src/components/SettingsDialog.tsx) and [hash file](/Users/example/project/src/foo%23bar.ts#L4) and [OpenAI](https://openai.com)',
        cwd: '/Users/example/project'
      })
    )
  )

  assert.match(markup, /data-phi-slot="local-file-link"/)
  assert.match(markup, /SettingsDialog\.tsx/)
  assert.match(
    markup,
    /data-phi-path="\/Users\/example\/project\/src\/renderer\/src\/components\/SettingsDialog\.tsx"/
  )
  assert.match(markup, />SettingsDialog\.tsx<\/span><\/button>/)
  assert.doesNotMatch(markup, />src\/renderer\/src\/components\/SettingsDialog\.tsx<\/span>/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project\/src\/foo#bar\.ts"/)
  assert.match(markup, /hash file/)
  assert.match(markup, /href="https:\/\/openai.com"/)
  assert.match(markup, /target="_blank"/)
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
