import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import { connect, type Browser } from 'puppeteer-core'

import {
  electronPath,
  environment,
  readyTimeoutMs,
  repoRoot,
  stopChild,
  waitUntil,
  type RunningApp,
  type SmokePaths
} from './smoke-app-pptx-runtime'

export interface ExportSmokePaths extends SmokePaths {
  readonly exportCsvPath: string
  readonly exportTsvPath: string
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配导出 smoke CDP 端口'))
        return
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
  })
}

async function connectToElectron(port: number, child: ChildProcess): Promise<Browser> {
  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Electron 已退出 code=${String(child.exitCode)} signal=${String(child.signalCode)}`
      )
    }
    try {
      return await connect({ browserURL: `http://127.0.0.1:${port}` })
    } catch {
      await delay(100)
    }
  }
  throw new Error('Electron CDP 启动超时')
}

export async function launchExport(paths: ExportSmokePaths): Promise<RunningApp> {
  const port = await reservePort()
  const child = spawn(
    electronPath,
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${paths.userDataDir}`],
    {
      cwd: repoRoot,
      env: {
        ...environment(paths),
        PHI_OFFICE_SMOKE_EXPORT_CSV_PATH: paths.exportCsvPath,
        PHI_OFFICE_SMOKE_EXPORT_TSV_PATH: paths.exportTsvPath
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let output = ''
  const collect = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-20_000)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  try {
    const browser = await connectToElectron(port, child)
    const page = await waitUntil('Phi renderer 页面', async () => {
      const pages = await browser.pages()
      return pages.find((candidate) => candidate.url() !== 'about:blank') ?? null
    })
    await page.setViewport({ width: 1500, height: 950 })
    return { browser, page, child, logs: () => output }
  } catch (error) {
    await stopChild(child)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\n${output}`)
  }
}
