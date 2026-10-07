import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { connect, type Browser, type Page } from 'puppeteer-core'

export const repoRoot = resolve(import.meta.dirname, '..', '..')
export const electronPath = join(repoRoot, 'node_modules', '.bin', 'electron')
export const readyTimeoutMs = 60_000

class FatalSmokeError extends Error {}

export interface RunningApp {
  readonly browser: Browser
  readonly page: Page
  readonly child: ChildProcess
  readonly logs: () => string
}

export interface SmokePaths {
  readonly homeDir: string
  readonly agentDir: string
  readonly projectDir: string
  readonly userDataDir: string
  readonly saveAsPath: string
  readonly screenshotDir: string
  readonly ompWorkerPath?: string
}

export function environment(paths: SmokePaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: paths.homeDir,
    PI_CODING_AGENT_DIR: paths.agentDir,
    PHI_OFFICE_DEV: '1',
    PHI_OFFICE_SMOKE_SAVE_AS_PATH: paths.saveAsPath,
    ...(paths.ompWorkerPath ? { PHI_OMP_WORKER_PATH: paths.ompWorkerPath } : {})
  }
  for (const key of [
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SHELL',
    'USER',
    'LOGNAME',
    'DISPLAY',
    'XDG_RUNTIME_DIR',
    'SSH_AUTH_SOCK'
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

export async function waitUntil<T>(
  label: string,
  probe: () => T | null | false | undefined | Promise<T | null | false | undefined>
): Promise<T> {
  const deadline = Date.now() + readyTimeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      if (error instanceof FatalSmokeError) throw error
      lastError = error
    }
    await delay(100)
  }
  const detail = lastError instanceof Error ? `：${lastError.message}` : ''
  throw new Error(`${label}超时${detail}`)
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配 CDP 端口'))
        return
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
  })
}

export async function launch(paths: SmokePaths): Promise<RunningApp> {
  const port = await reservePort()
  const child = spawn(
    electronPath,
    ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${paths.userDataDir}`],
    {
      cwd: repoRoot,
      env: environment(paths),
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
  const browser = await waitUntil('Electron CDP 启动', async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new FatalSmokeError(
        `Electron 已退出 code=${String(child.exitCode)} signal=${child.signalCode}\n${output}`
      )
    }
    return connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }).catch(
      () => null
    )
  })
  const page = await waitUntil('Phi renderer 页面', async () => {
    const pages = await browser.pages()
    return pages.find((candidate) => candidate.url() !== 'about:blank') ?? null
  })
  // Keep layout and popup centers tied to the visible Electron content area.
  await page.setViewport(null)
  return { browser, page, child, logs: () => output }
}

export async function closeNormally(app: RunningApp): Promise<void> {
  await app.browser.close().catch(() => undefined)
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => app.child.once('exit', () => resolveExit(true))),
    delay(10_000).then(() => false)
  ])
  if (exited) return
  app.child.kill('SIGTERM')
  assert.equal(
    await Promise.race([
      new Promise<boolean>((resolveExit) => app.child.once('exit', () => resolveExit(true))),
      delay(10_000).then(() => false)
    ]),
    true,
    'SIGTERM 后 Electron 仍未退出'
  )
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await delay(500)
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function officePidsForRoot(root: string): number[] | null {
  try {
    return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes('officecli') && line.includes(root))
      .map((line) => Number(/^\s*(\d+)/u.exec(line)?.[1]))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  } catch {
    return null
  }
}

export async function cleanOfficeProcesses(root: string): Promise<'verified' | 'ps_unavailable'> {
  const initial = officePidsForRoot(root)
  if (initial === null) return 'ps_unavailable'
  for (const pid of initial) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      continue
    }
  }
  await delay(250)
  for (const pid of officePidsForRoot(root) ?? []) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      continue
    }
  }
  assert.deepEqual(officePidsForRoot(root), [], '仍有 PPTX OfficeCLI 进程残留')
  return 'verified'
}
