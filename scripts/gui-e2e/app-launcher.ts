import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

import {
  _electron,
  chromium,
  type Browser,
  type ElectronApplication,
  type Page
} from 'playwright-core'

export interface AppHandle {
  page: Page
  mode: 'electron' | 'cdp'
  sampleMemory?(): Promise<Array<{ type: string; workingSetKiB: number; privateKiB?: number }>>
  close(): Promise<void>
}

interface ExecutableLaunchOptions {
  env: Record<string, string>
  userData: string
  args?: string[]
}

const READY_SELECTOR = '[data-phi-home-prompt], [data-phi-chat-placement], .app-activity-bar'

// A packaged app can reject Playwright's three inspector markers. Node 24 reports the losing
// marker promises after the awaited launch has rejected; the caller intentionally falls back to CDP.
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error && reason.message === 'Process failed to launch!') return
  queueMicrotask(() => {
    throw reason
  })
})

function executableFor(appPath: string): string {
  const executable = join(appPath, 'Contents', 'MacOS', 'Phi')
  if (!existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`)
  return executable
}

function isolatedEnvironment(home: string): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  const environment: Record<string, string> = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: join(home, '.phi')
  }
  delete environment.NODE_OPTIONS
  delete environment.ELECTRON_RUN_AS_NODE
  return environment
}

function isolatedUserData(home: string): string {
  const userData = join(home, 'Library', 'Application Support', 'Phi')
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  return userData
}

async function firstReadyPage(pages: () => Page[], timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const page of pages()) {
      if (page.isClosed()) continue
      try {
        if ((await page.locator(READY_SELECTOR).count()) > 0) return page
      } catch {
        // Splash windows can disappear between enumeration and inspection.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Phi main window did not become ready')
}

function childAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals, group = false): void {
  try {
    if (group && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    child.kill(signal)
  }
}

async function stopChild(child: ChildProcess, group = false): Promise<void> {
  if (!childAlive(child)) return
  signalChild(child, 'SIGTERM', group)
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000))
  ])
  if (childAlive(child)) signalChild(child, 'SIGKILL', group)
}

async function closeElectron(app: ElectronApplication): Promise<void> {
  const child = app.process()
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000))
  ])
  await stopChild(child)
}

async function launchElectron(
  executable: string,
  options: ExecutableLaunchOptions
): Promise<AppHandle> {
  const app = await _electron.launch({
    executablePath: executable,
    env: options.env,
    args: [`--user-data-dir=${options.userData}`, ...(options.args ?? [])],
    timeout: 30_000
  })
  try {
    const page = await firstReadyPage(() => app.windows(), 90_000)
    return {
      page,
      mode: 'electron',
      sampleMemory: () =>
        app.evaluate(({ app }) =>
          app.getAppMetrics().map(({ type, memory }) => ({
            type,
            workingSetKiB: memory.workingSetSize,
            ...(memory.privateBytes !== undefined ? { privateKiB: memory.privateBytes } : {})
          }))
        ),
      close: () => closeElectron(app)
    }
  } catch (error) {
    await closeElectron(app)
    throw error
  }
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

function safeLaunchDiagnostic(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => /(fatal|error|abort|crash|sandbox|trace trap|uncaught)/i.test(line))
    .slice(-8)
    .join('\n')
    .replace(/\b(api[\s_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\b(?:sk|xai|key|token)-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\b(?:ghp_|github_pat_|glpat-|hf_)[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9+/=_-]{64,}\b/g, '[REDACTED]')
    .slice(-2_000)
}

async function waitForCdp(
  child: ChildProcess,
  port: number,
  diagnostics: () => string
): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (!childAlive(child)) {
      const detail = safeLaunchDiagnostic(diagnostics())
      throw new Error(
        `Phi CDP fallback exited before startup (code=${String(child.exitCode)}, signal=${String(child.signalCode)})${detail ? `\n${detail}` : ''}`
      )
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {
      // The debugging endpoint is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Phi remote-debugging endpoint did not become ready')
}

async function closeCdp(browser: Browser, page: Page, child: ChildProcess): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page)
    await session.send('Browser.close')
  } catch {
    // The browser may already be closing.
  }
  await browser.close().catch(() => undefined)
  await stopChild(child, true)
}

async function launchCdp(executable: string, options: ExecutableLaunchOptions): Promise<AppHandle> {
  const port = await availablePort()
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      `--user-data-dir=${options.userData}`,
      ...(options.args ?? [])
    ],
    {
      env: options.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let diagnostics = ''
  const collect = (chunk: Buffer): void => {
    diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(-20_000)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  try {
    await waitForCdp(child, port, () => diagnostics)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const page = await firstReadyPage(
      () => browser.contexts().flatMap((context) => context.pages()),
      90_000
    )
    return { page, mode: 'cdp', close: () => closeCdp(browser, page, child) }
  } catch (error) {
    await stopChild(child, true)
    throw error
  }
}

export async function launchPackagedApp(appPath: string, home: string): Promise<AppHandle> {
  return launchPackagedExecutable(executableFor(appPath), {
    env: isolatedEnvironment(home),
    userData: isolatedUserData(home)
  })
}

export async function launchPackagedExecutable(
  executable: string,
  options: ExecutableLaunchOptions
): Promise<AppHandle> {
  if (!existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`)
  try {
    return await launchElectron(executable, options)
  } catch {
    return await launchCdp(executable, options)
  }
}
