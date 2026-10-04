import assert from 'node:assert/strict'
import { spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { resolveBunExecutable } from '../src/main/terminal/terminal-bun'
import { buildTerminalEnv } from '../src/main/terminal/terminal-env'
import { spawnBunProcess } from '../src/main/terminal/terminal-host-process'
import {
  TerminalHost,
  type TerminalChildSpawner,
  type TerminalHostEvent
} from '../src/main/terminal/terminal-host'
import { TERMINAL_CREDIT_WINDOW_BYTES } from '../src/shared/terminalTypes'

const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const TIMEOUT_MS = 5_000

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out`)
    await delay(10)
  }
}

function requiredAppPath(): string {
  const argument = process.argv[2]
  if (!argument)
    throw new Error('usage: bun run smoke:terminal-packaged -- /path/to/pi-desktop.app')
  const appPath = realpathSync(resolve(argument))
  if (!appPath.endsWith('.app')) throw new Error(`not an app bundle: ${appPath}`)
  return appPath
}

function lsofNativePaths(pid: number): string[] {
  const result = spawnSync('/usr/sbin/lsof', ['-p', String(pid), '-Fn'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`lsof failed (${result.status}): ${result.stderr.trim()}`)
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('n') && line.includes('pi_natives.'))
    .map((line) => line.slice(1))
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    process.stdout.write('SKIP terminal packaged smoke requires macOS\n')
    return
  }

  const appPath = requiredAppPath()
  const repository = realpathSync(resolve(import.meta.dirname, '..'))
  assert.equal(
    appPath === repository || appPath.startsWith(`${repository}${sep}`),
    false,
    'the packaged app must be copied outside the repository'
  )

  const unpackedRoot = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked')
  const workerPath = join(unpackedRoot, 'out', 'main', 'terminal', 'terminal-worker.ts')
  const supervisorPath = join(unpackedRoot, 'out', 'main', 'terminal', 'terminal-supervisor.ts')
  const nativePath = join(
    unpackedRoot,
    'node_modules',
    `@oh-my-pi/pi-natives-darwin-${process.arch}`,
    `pi_natives.darwin-${process.arch}.node`
  )
  for (const path of [workerPath, supervisorPath, nativePath]) {
    assert.equal(existsSync(path), true, `packaged file is missing: ${path}`)
  }

  const previousCwd = process.cwd()
  const previousPath = process.env.PATH
  const previousExplicitBun = process.env.PHI_BUN_PATH
  const previousBunInstall = process.env.BUN_INSTALL
  process.chdir(dirname(appPath))
  process.env.PATH = MINIMAL_PATH
  delete process.env.PHI_BUN_PATH
  delete process.env.BUN_INSTALL

  const children: ChildProcessWithoutNullStreams[] = []
  const workerChildren: ChildProcessWithoutNullStreams[] = []
  const spawnPackagedChild: TerminalChildSpawner = (scriptPath) => {
    const child = spawnBunProcess(scriptPath)
    children.push(child)
    if (scriptPath === workerPath) workerChildren.push(child)
    return child
  }
  const bunExecutable = resolveBunExecutable(process.env)
  assert.equal(isAbsolute(bunExecutable), true)

  const host = new TerminalHost({
    spawnWorker: spawnPackagedChild,
    spawnSupervisor: spawnPackagedChild,
    workerPath,
    supervisorPath
  })
  const terminalId = 'packaged_smoke_terminal'
  let output = ''
  host.subscribe((event: TerminalHostEvent) => {
    if (event.type === 'data' && event.terminalId === terminalId) output += event.data
  })

  try {
    const started = await host.createTerminal({
      terminalId,
      application: '/bin/zsh',
      args: ['-il'],
      cwd: dirname(appPath),
      env: buildTerminalEnv(process.env),
      cols: 80,
      rows: 24
    })
    await host.credit(terminalId, TERMINAL_CREDIT_WINDOW_BYTES)
    const worker = workerChildren.at(-1)
    assert.ok(worker?.pid, 'terminal worker PID was not captured')
    assert.equal(worker.spawnfile, bunExecutable, 'terminal worker did not use resolved Bun path')

    const sentinel = `PHI_PACKAGED_${Date.now()}`
    await host.input(terminalId, `printf '${sentinel}\\n'\n`)
    await waitFor(() => output.includes(sentinel), 'packaged shell echo')

    await host.resize(terminalId, 113, 37)
    await host.input(terminalId, "printf 'PHI_SIZE:'; stty size\n")
    await waitFor(() => output.includes('PHI_SIZE:37 113'), 'packaged terminal resize')

    const nativePaths = lsofNativePaths(worker.pid)
    const expectedNative = realpathSync(nativePath)
    assert.equal(
      nativePaths.includes(expectedNative),
      true,
      `loaded native paths: ${nativePaths.join(',')}`
    )
    assert.equal(
      nativePaths.some((path) => path === repository || path.startsWith(`${repository}${sep}`)),
      false,
      `worker loaded a development native binary: ${nativePaths.join(',')}`
    )

    await host.close(terminalId, 'user')
    process.stdout.write(
      `PASS terminal-packaged app=${appPath} bun=${bunExecutable} worker=${worker.pid} shell=${started.pid} echo=true size=37x113 native=${expectedNative}\n`
    )
  } finally {
    await host.dispose()
    process.chdir(previousCwd)
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousExplicitBun === undefined) delete process.env.PHI_BUN_PATH
    else process.env.PHI_BUN_PATH = previousExplicitBun
    if (previousBunInstall === undefined) delete process.env.BUN_INSTALL
    else process.env.BUN_INSTALL = previousBunInstall
    for (const child of children) {
      if (!child.killed) child.kill('SIGKILL')
    }
  }
}

await main()
