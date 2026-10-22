import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import test from 'node:test'
import { RuntimeSidebar } from '../src/renderer/src/features/runtime/RuntimeView'
import type { AnalysisJupyterRuntimeStatus } from '../src/renderer/src/types'

const require = createRequire(import.meta.url)
const needsDisplay =
  process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY

const status: AnalysisJupyterRuntimeStatus = {
  server: {
    projectCwd: '/projects/research',
    state: 'ready',
    port: 28888,
    hasEndpoint: true
  },
  notebooks: {
    activeSessionCount: 1,
    busySessionCount: 0,
    sessions: [
      {
        projectCwd: '/projects/research',
        notebookPath: '/projects/research/eda.ipynb',
        kernelName: 'python3',
        kernelDisplayName: 'Python 3',
        sessionId: 'kernel-1',
        state: 'idle'
      }
    ]
  }
}

test(
  'server and kernel close actions respond only to their own row hover',
  {
    skip: needsDisplay ? 'A desktop display is required for Electron hover' : false,
    timeout: 30_000
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'phi-runtime-hover-'))
    try {
      const markup = renderToStaticMarkup(
        createElement(
          ThemeProvider,
          { theme: createTheme() },
          createElement(RuntimeSidebar, {
            projectCwd: '/projects/research',
            runtimeStatus: status,
            onRefresh: () => undefined,
            onStartJupyter: () => undefined,
            onStopJupyter: () => undefined,
            onStopNotebookKernel: () => undefined
          })
        )
      )
      const html = join(directory, 'index.html')
      await writeFile(
        html,
        `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;width:420px;height:600px">${markup}</body></html>`
      )
      const boundsScript = `(() => {
        try {
          const bounds = (selector) => {
            const element = document.querySelector(selector)
            if (!element) throw new Error('Missing ' + selector)
            const rect = element.getBoundingClientRect()
            return { x: Math.round(rect.left + 70), y: Math.round(rect.top + rect.height / 2) }
          }
          return {
            server: bounds('[data-phi-runtime-summary]'),
            kernel: bounds('[data-phi-runtime-sidebar-kernel]')
          }
        } catch (error) {
          return { error: String(error) }
        }
      })()`
      const sampleScript = `(() => {
        const server = document.querySelector('[data-phi-runtime-sidebar-server] .runtime-sidebar-row-actions')
        const kernel = document.querySelector('[data-phi-runtime-sidebar-kernel] .runtime-sidebar-row-actions')
        return {
          server: server ? getComputedStyle(server).opacity : null,
          kernel: kernel ? getComputedStyle(kernel).opacity : null
        }
      })()`
      const main = join(directory, 'main.cjs')
      await writeFile(
        main,
        `
const { app, BrowserWindow } = require('electron')
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))})
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 420, height: 600, webPreferences: { backgroundThrottling: false } })
  await window.loadFile(${JSON.stringify(html)})
  const rects = await window.webContents.executeJavaScript(${JSON.stringify(boundsScript)})
  if (rects.error) throw new Error(rects.error)
  const sample = () => window.webContents.executeJavaScript(${JSON.stringify(sampleScript)})
  const result = {}
  for (const row of ['server', 'kernel']) {
    window.webContents.sendInputEvent({ type: 'mouseMove', ...rects[row] })
    await new Promise((resolve) => setTimeout(resolve, 250))
    result[row] = await sample()
  }
  process.stdout.write('PHI_RUNTIME_HOVER_RESULT:' + JSON.stringify(result) + '\\n')
  window.destroy()
  app.quit()
}).catch((error) => {
  process.stderr.write(String(error?.stack ?? error))
  app.exit(1)
})
`
      )
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(require('electron') as string, [main], {
          env,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`Electron hover test timed out: ${stderr.slice(-1200)}`))
        }, 20_000)
        child.stdout.on('data', (chunk) => (stdout += String(chunk)))
        child.stderr.on('data', (chunk) => (stderr += String(chunk)))
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve(stdout)
          else
            reject(
              new Error(
                `Electron hover test exited ${code}: ${stdout.slice(-800)} ${stderr.slice(-1200)}`
              )
            )
        })
      })
      const line = output.split('\n').find((entry) => entry.startsWith('PHI_RUNTIME_HOVER_RESULT:'))
      assert.ok(line, 'Electron must report the two hover states')
      const result = JSON.parse(line.slice('PHI_RUNTIME_HOVER_RESULT:'.length)) as {
        server: { server: string; kernel: string }
        kernel: { server: string; kernel: string }
      }
      assert.deepEqual(result.server, { server: '1', kernel: '0' })
      assert.deepEqual(result.kernel, { server: '0', kernel: '1' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
