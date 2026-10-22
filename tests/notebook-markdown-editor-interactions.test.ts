import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const needsDisplay =
  process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY

test(
  'mounted Notebook Markdown editor renders blocks live and preserves editing interactions',
  {
    skip: needsDisplay ? 'A desktop display is required for the Electron renderer test' : false,
    timeout: 40_000
  },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'phi-notebook-markdown-editor-'))
    try {
      await build({
        configFile: false,
        logLevel: 'silent',
        esbuild: { jsx: 'automatic' },
        define: { 'process.env.NODE_ENV': '"development"' },
        build: {
          outDir: join(directory, 'renderer'),
          emptyOutDir: true,
          minify: false,
          lib: {
            entry: resolve('tests/fixtures/notebook-markdown-editor-interactions.tsx'),
            name: 'NotebookMarkdownEditorInteractions',
            formats: ['iife'],
            fileName: () => 'editor.js'
          }
        }
      })
      const html = join(directory, 'renderer', 'index.html')
      const styles = (await readdir(join(directory, 'renderer'))).filter((name) =>
        name.endsWith('.css')
      )
      assert.ok(styles.length > 0, 'The WarmTooltip stylesheet must be bundled')
      await writeFile(
        html,
        `<!doctype html><html><head><meta charset="utf-8">${styles.map((name) => `<link rel="stylesheet" href="./${name}">`).join('')}</head><body><script src="./editor.js"></script></body></html>`
      )
      const main = join(directory, 'main.cjs')
      await writeFile(
        main,
        `
const { app, BrowserWindow } = require('electron')
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))})
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  window.webContents.on('console-message', (details) => {
    if (!details.message.startsWith('PHI_MARKDOWN_EDITOR_RESULT:')) return
    process.stdout.write(details.message + '\\n')
    window.destroy()
    app.quit()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write(JSON.stringify(details))
    app.exit(1)
  })
  await window.loadFile(${JSON.stringify(html)})
  window.webContents.focus()
})
`
      )
      const executable = require('electron') as string
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const output = await new Promise<string>((accept, reject) => {
        const child = spawn(executable, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`Electron Markdown editor test timed out: ${stderr.slice(-2000)}`))
        }, 25_000)
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          if (code !== 0)
            reject(
              new Error(
                `Electron Markdown editor test exited ${code} (${signal}): ${stderr.slice(-2000)}`
              )
            )
          else accept(stdout)
        })
      })
      const line = output
        .split('\n')
        .find((entry) => entry.startsWith('PHI_MARKDOWN_EDITOR_RESULT:'))
      assert.ok(line, 'The mounted renderer must report a result')
      const result = JSON.parse(line.slice('PHI_MARKDOWN_EDITOR_RESULT:'.length)) as {
        ok: boolean
        error?: string
        result?: unknown
      }
      assert.equal(result.ok, true, result.error)
      context.diagnostic(JSON.stringify(result.result))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
