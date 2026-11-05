#!/usr/bin/env bun

// Verifies the kernels of a finished package exactly as the app does at startup, because
// packaging steps such as signing can rewrite them after their manifest was written.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { launchLocalKernel } from '../src/main/agent/engine/kernel-client/local'
import {
  localKernelExecutableName,
  verifyLocalKernelPackage,
  type LocalKernelPackageTarget
} from '../src/main/agent/engine/kernel-client/local-package'

const BROKER_START_TIMEOUT_MS = 10_000

const REQUIRED_TARGETS: Partial<Record<NodeJS.Platform, readonly LocalKernelPackageTarget[]>> = {
  darwin: ['darwin-arm64', 'linux-x64'],
  linux: ['linux-x64'],
  win32: ['win32-x64']
}

export async function checkReleaseKernels(options: {
  readonly resources: string
  readonly phiVersion: string
  readonly targets: readonly LocalKernelPackageTarget[]
}): Promise<void> {
  const root = join(resolve(options.resources), 'kernel', options.phiVersion)
  const found = await readdir(root)
  for (const target of options.targets) {
    if (!found.includes(target)) throw new Error(`Package has no ${target} kernel in ${root}.`)
    await verifyLocalKernelPackage({
      directory: join(root, target),
      target,
      phiVersion: options.phiVersion
    })
  }
}

/**
 * Starts the daemon broker the way OMP does, by re-entering the kernel. This also catches a kernel
 * the system refuses to run, which dies on a signal.
 */
async function assertHostsBroker(executable: string, home: string): Promise<void> {
  const { IpcConnection, ipcEndpoint } = await import('@oh-my-pi/pi-natives')
  const endpoint = ipcEndpoint(home, 'broker')
  await writeFile(join(home, 'broker.token'), `${randomBytes(32).toString('hex')}\n`, {
    mode: 0o600
  })
  const child = spawn(executable, ['__omp_worker_daemon_broker'], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: join(home, '.phi'),
      OMP_DAEMON_PROJECT_DIR: home,
      OMP_DAEMON_RUNTIME_DIR: home
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk}`.slice(-4000)
  })
  let spawnError: Error | undefined
  child.once('error', (error) => {
    spawnError = error
  })
  const closed = new Promise<void>((done) => child.once('close', () => done()))
  try {
    const deadline = Date.now() + BROKER_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Packaged kernel could not host its broker: ${executable} ended on ${child.signalCode ?? child.exitCode}.\n${stderr}`
        )
      }
      const connection = await IpcConnection.connect(endpoint, {
        framing: 'lines',
        timeoutMs: 200
      }).catch(() => undefined)
      if (connection) {
        connection.destroy()
        return
      }
      await setTimeout(100)
    }
    throw new Error(`Packaged kernel opened no broker: ${executable}.\n${stderr}`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
}

async function checkNativeKernel(
  directory: string,
  target: LocalKernelPackageTarget,
  phiVersion: string
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'phi-release-'))
  try {
    const launched = await launchLocalKernel({
      package: { directory, target, phiVersion },
      cwd: directory,
      agentDir: join(home, '.phi'),
      home,
      onDiagnostic: (line) => process.stderr.write(line)
    })
    const closed = await launched.close()
    if (closed.code !== 0 || closed.signal !== null) {
      throw new Error(`Packaged kernel failed to exit cleanly: ${closed.signal ?? closed.code}.`)
    }
    if (launched.greeting.kernel.version !== phiVersion) {
      throw new Error(`Packaged kernel greeted as Phi ${launched.greeting.kernel.version}.`)
    }
    await assertHostsBroker(join(directory, localKernelExecutableName(target)), home)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf('--resources')
  const resources = flag === -1 ? undefined : process.argv[flag + 1]
  if (!resources) throw new Error('Usage: check-release-kernel.ts --resources <dir>')
  const targets = REQUIRED_TARGETS[process.platform]
  if (!targets) throw new Error(`No release kernel is defined for ${process.platform}.`)
  const { version: phiVersion } = JSON.parse(await readFile('package.json', 'utf8')) as {
    version: string
  }
  await checkReleaseKernels({ resources, phiVersion, targets })
  await checkNativeKernel(
    join(resolve(resources), 'kernel', phiVersion, targets[0]),
    targets[0],
    phiVersion
  )
  process.stdout.write(`Packaged kernels verified: ${targets.join(', ')}\n`)
}

if (import.meta.main) await main()
