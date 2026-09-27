import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider, type Theme } from '@mui/material'
import MarkdownContent from '../src/renderer/src/components/MarkdownContent'
import { RemoteProjectFileContext } from '../src/renderer/src/lib/remoteProjectFileContext'
import { createAppTheme } from '../src/renderer/src/theme'

function renderMarkdown(text: string, theme: Theme = createTheme(), enableMath?: boolean): string {
  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme }, createElement(MarkdownContent, { text, enableMath }))
  )
}

test('markdown code blocks show language labels and copy controls', () => {
  const markup = renderMarkdown('```ts\nconst answer = 42\n```')

  assert.match(markup, /ts/)
  assert.match(markup, /复制/)
  assert.match(markup, /data-phi-markdown-code="highlighted"/)
  assert.match(markup, /data-phi-markdown-code-language="typescript"/)
  assert.match(markup, /data-phi-syntax-token="keyword"[^>]*>const</)
  assert.match(markup, /data-phi-syntax-token="plain"[^>]*> answer </)
  assert.match(markup, /data-phi-syntax-token="number"[^>]*>42</)
})

test('markdown code blocks fall back to a generic label without a language', () => {
  const markup = renderMarkdown('```\nplain text\n```')

  assert.match(markup, /代码/)
  assert.match(markup, /plain text/)
  assert.match(markup, /data-phi-markdown-code="plain"/)
})

test('markdown code blocks syntax highlight Python, R, and Rust fences', () => {
  const markup = renderMarkdown(
    [
      '```python',
      'for value in items:',
      '    print(value)',
      '```',
      '',
      '```r',
      'plot <- function(x) x + 1',
      '```',
      '',
      '```rust',
      'fn main() { let value: i32 = 42; }',
      '```'
    ].join('\n')
  )

  assert.equal((markup.match(/data-phi-markdown-code="highlighted"/g) ?? []).length, 3)
  assert.match(markup, /data-phi-markdown-code-language="python"/)
  assert.match(markup, /data-phi-markdown-code-language="r"/)
  assert.match(markup, /data-phi-markdown-code-language="rust"/)
  assert.match(markup, /data-phi-syntax-token="keyword"[^>]*>for</)
  assert.match(markup, /data-phi-syntax-token="function"[^>]*>print</)
  assert.match(markup, /data-phi-syntax-token="keyword"[^>]*>function</)
  assert.match(markup, /data-phi-syntax-token="keyword"[^>]*>fn</)
  assert.match(markup, /data-phi-syntax-token="type"[^>]*>i32</)
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

test('markdown inline code renders SMILES expressions with hover molecule previews', () => {
  const smiles = 'NC(Cc1cc(I)c(Oc2ccc(O)c(I)c2)c(I)c1)C(=O)O'
  const markup = renderMarkdown(`| 分子 | SMILES |\n| --- | --- |\n| L-T4 | \`${smiles}\` |`)

  assert.match(markup, /data-phi-slot="markdown-smiles-token"/)
  assert.match(markup, /data-phi-smiles-hover-preview="true"/)
  assert.match(markup, /data-phi-molecule-expression="true"/)
  assert.match(markup, /NC\(Cc1cc/)
})

test('markdown inline code leaves GEO matrix filenames as plain code, not molecule previews', () => {
  const markup = renderMarkdown('Download `GSE180012_raw_counts_GRCh38.txt.gz` into workspace.')

  assert.doesNotMatch(markup, /data-phi-slot="markdown-smiles-token"/)
  assert.doesNotMatch(markup, /data-phi-smiles-hover-preview="true"/)
  assert.doesNotMatch(markup, /data-phi-molecule-expression="true"/)
  assert.doesNotMatch(markup, /data-phi-slot="local-file-link"/)
  assert.match(markup, />GSE180012_raw_counts_GRCh38\.txt\.gz<\/code>/)
})

test('markdown links render STRING network urls as hover webpage previews', () => {
  const markup = renderMarkdown(
    '完整 STRING 网络可视化：https://string-db.org/network/9606.ENSP00000281030'
  )

  assert.match(markup, /data-phi-slot="database-web-preview-link"/)
  assert.match(markup, /data-phi-database-kind="string-network"/)
  assert.match(markup, /https:\/\/string-db\.org\/network\/9606\.ENSP00000281030/)
})

test('markdown links render KEGG pathway urls as hover webpage previews', () => {
  const markup = renderMarkdown('KEGG 通路：https://www.kegg.jp/pathway/hsa04110')

  assert.match(markup, /data-phi-slot="database-web-preview-link"/)
  assert.match(markup, /data-phi-database-kind="kegg-pathway"/)
  assert.match(markup, /https:\/\/www\.kegg\.jp\/pathway\/hsa04110/)
})

test('markdown color swatches work inside emphasis and tables', () => {
  const markup = renderMarkdown(
    '**Blue #0072B2**\n\n| Name | Color |\n| --- | --- |\n| red | #D55E00 |'
  )

  assert.match(markup, /style="background-color:#0072B2"/)
  assert.match(markup, /style="background-color:#D55E00"/)
})

test('math is left as literal text by default (chat, wrapper views, etc.)', () => {
  const markup = renderMarkdown('$$x^2 + y^2 = z^2$$')

  assert.doesNotMatch(markup, /class="katex"/)
  assert.match(markup, /\$\$x\^2 \+ y\^2 = z\^2\$\$/)
})

test('enableMath renders $$...$$ block and inline math as KaTeX', () => {
  const block = renderMarkdown('$$x^2 + y^2 = z^2$$', createTheme(), true)
  assert.match(block, /class="katex"/)
  assert.match(block, /application\/x-tex">x\^2 \+ y\^2 = z\^2</)

  const inline = renderMarkdown('Lift ($$L$$) depends on $$C_L$$.', createTheme(), true)
  assert.match(inline, /class="katex"/)
  assert.match(inline, /application\/x-tex">L</)
  assert.match(inline, /application\/x-tex">C_L</)
})

test('enableMath still leaves plain currency text alone (single $ is not math)', () => {
  const markup = renderMarkdown(
    'The AWS bill is $5 and the GPU costs $10 per hour.',
    createTheme(),
    true
  )

  assert.doesNotMatch(markup, /class="katex"/)
  assert.match(markup, /\$5 and the GPU costs \$10 per hour/)
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
  assert.match(markup, /font-size:1em/)
  assert.doesNotMatch(markup, /translateY\(1px\)/)
  assert.match(markup, /README.md<\/span><\/button>/)
  assert.doesNotMatch(markup, /\.\/src\/App.tsx<\/span>/)
})

test('markdown file links use tiered hover previews without embedding media inline', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: 'Outputs: ./stacked_bar.png, ./report.pdf.',
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

test('markdown relative workspace paths render as clickable hover preview links', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: 'Output `omics_viz/THRSP_network_omics.png`, see [PNG](omics_viz/THRSP_network_omics.png), and open omics_viz/THRSP_network_omics.png.',
        cwd: '/Users/example/project'
      })
    )
  )

  const absolutePath = '/Users/example/project/omics_viz/THRSP_network_omics.png'
  assert.equal(markup.match(/data-phi-slot="local-file-link"/g)?.length ?? 0, 3)
  assert.equal(markup.match(/data-phi-slot="local-file-hover-preview"/g)?.length ?? 0, 3)
  assert.match(markup, new RegExp(`data-phi-path="${absolutePath}"`))
  assert.match(markup, new RegExp(`data-phi-hover-preview-path="${absolutePath}"`))
  assert.match(markup, /data-phi-file-kind="image"/)
  assert.match(markup, /打开文件 \/Users\/example\/project\/omics_viz\/THRSP_network_omics\.png/)
  assert.doesNotMatch(markup, /href="omics_viz\/THRSP_network_omics\.png"/)
})

test('markdown leaves project-external absolute paths as non-clickable text', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: 'External output /Users/example/data/plots/volcano.png, [PNG](/Users/example/data/plots/volcano.png), and `/Users/example/data/plots/volcano.png`.',
        cwd: '/Users/example/project'
      })
    )
  )

  assert.doesNotMatch(markup, /data-phi-slot="local-file-link"/)
  assert.doesNotMatch(markup, /data-phi-hover-preview-path/)
  assert.doesNotMatch(markup, /data-phi-path="\/Users\/example\/data\/plots\/volcano\.png"/)
  assert.match(markup, /\/Users\/example\/data\/plots\/volcano\.png/)
  assert.match(markup, /PNG/)
})

test('markdown local image syntax renders a local preview container', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: '推荐模板：![Volcano template](/Users/example/project/resources/skills/omics-visualization/scripts/scatter/volcano/preview.png)',
        cwd: '/Users/example/project'
      })
    )
  )

  assert.match(markup, /data-phi-slot="local-markdown-image"/)
  assert.match(
    markup,
    /data-phi-path="\/Users\/example\/project\/resources\/skills\/omics-visualization\/scripts\/scatter\/volcano\/preview\.png"/
  )
  assert.match(markup, /data-phi-slot="local-file-link"/)
  assert.match(markup, />Volcano template<\/span><\/button>/)
  assert.doesNotMatch(markup, /<img[^>]+src="\/Users\/example\/project/)
})

test('markdown remote image syntax still renders an image element', () => {
  const markup = renderMarkdown('![External plot](https://example.com/plot.png)')

  assert.match(markup, /<img/)
  assert.match(markup, /src="https:\/\/example\.com\/plot\.png"/)
  assert.match(markup, /alt="External plot"/)
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
  assert.doesNotMatch(markup, /lucide/)
  assert.match(markup, />test<\/span><\/button>/)
  assert.doesNotMatch(markup, /data-phi-file-kind="text"/)
})

test('markdown paragraphs render explicit relative file paths with representative icons', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: 'Files: ./stacked_bar.R, ./main.py, ./test.py, ./analysis.ipynb, ./.env.local, ./data.json, ./pyproject.toml, ./uv.lock, ./README.md, ./.python-version, version 1.2.3.',
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

test('markdown leaves bare file-like words and dotted data fields as text', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: 'Fields: adj.P.Val, P.Value, data.json, README.md, .env.local, version 1.2.3.',
        cwd: '/Users/example/project'
      })
    )
  )

  assert.doesNotMatch(markup, /data-phi-slot="local-file-link"/)
  assert.match(markup, /adj\.P\.Val/)
  assert.match(markup, /data\.json/)
  assert.match(markup, /README\.md/)
})

test('markdown inline code requires explicit paths for file preview links', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(MarkdownContent, {
        text: '`./main.py`, `./README.md`, `./src/renderer/App.tsx`, `.gitignore`, `List/ListItem`, `adj.P.Val`, and `--watch`',
        cwd: '/Users/example/project'
      })
    )
  )

  assert.match(markup, /data-phi-path="\/Users\/example\/project\/main\.py"/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project\/README\.md"/)
  assert.match(markup, /data-phi-path="\/Users\/example\/project\/src\/renderer\/App\.tsx"/)
  assert.match(markup, /data-phi-file-kind="python"/)
  assert.match(markup, /data-phi-file-kind="react"/)
  assert.match(markup, />main\.py<\/span><\/button>/)
  assert.doesNotMatch(markup, /data-phi-path="\/Users\/example\/project\/\.gitignore"/)
  assert.doesNotMatch(markup, /data-phi-path="\/Users\/example\/project\/List\/ListItem"/)
  assert.match(markup, />List\/ListItem<\/code>/)
  assert.doesNotMatch(markup, /data-phi-path="\/Users\/example\/project\/adj\.P\.Val"/)
  assert.match(markup, />adj\.P\.Val<\/code>/)
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

test('remote project markdown links use SSH file panel targets without local hover or reveal', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(
        RemoteProjectFileContext.Provider,
        {
          value: {
            hostAlias: 'cluster-a',
            canonicalRoot: '/data/project',
            openPath: () => undefined
          }
        },
        createElement(MarkdownContent, {
          cwd: '/data/project',
          text: 'See /data/project/note.txt and ssh://cluster-a/data/project/result.txt. [open](ssh://cluster-a/data/project/link.txt) [other](ssh://cluster-b/data/project/secret.txt)'
        })
      )
    )
  )
  assert.match(markup, /data-phi-slot="remote-file-link"/)
  assert.match(markup, /data-phi-path="ssh:\/\/cluster-a\/data\/project\/note\.txt"/)
  assert.match(markup, /data-phi-path="ssh:\/\/cluster-a\/data\/project\/result\.txt"/)
  assert.match(markup, /data-phi-path="ssh:\/\/cluster-a\/data\/project\/link\.txt"/)
  assert.doesNotMatch(markup, /data-phi-slot="local-file-hover-preview"/)
  assert.doesNotMatch(markup, /href="ssh:\/\/cluster-b/)
  assert.doesNotMatch(markup, /data-phi-path="ssh:\/\/cluster-a\/data\/project\/secret\.txt"/)
  assert.doesNotMatch(markup, /remote-project-anchors/)
})

test('markdown code blocks do not linkify paths inside code', () => {
  const markup = renderMarkdown('```sh\ncat ./src/App.tsx\n```')

  assert.doesNotMatch(markup, /title="\/Users\/example\/project\/src\/App.tsx"/)
  assert.doesNotMatch(markup, /data-phi-slot="local-file-link"/)
  assert.match(markup, /data-phi-markdown-code-language="shell"/)
  assert.match(markup, /data-phi-syntax-token="plain"[^>]*>cat /)
  assert.match(markup, /data-phi-syntax-token="plain"[^>]*>App\.tsx</)
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
