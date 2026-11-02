#!/usr/bin/env bun

// Verifies the kernels of a finished package exactly as the app does at startup, because
// packaging steps such as signing can rewrite them after their manifest was written.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import {
  verifyLocalKernelPackage,
  type LocalKernelPackageTarget
} from '../src/main/agent/engine/kernel-client/local-package'

const BROKER_START_TIMEOUT_MS = 10_000

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

const REQUIRED_TARGETS: Partial<Record<NodeJS.Platform, readonly LocalKernelPackageTarget[]>> = {
  darwin: ['darwin-arm64', 'linux-x64'],
  linux: ['linux-x64']
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
async function assertHostsBroker(executable: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'phi-release-'))
  const socket = join(home, 'broker.sock')
  await writeFile(join(home, 'broker.token'), `${randomBytes(32).toString('hex')}\n`, {
    mode: 0o600
  })
  const child = spawn(executable, ['__omp_worker_daemon_broker'], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      OMP_DAEMON_PROJECT_DIR: home,
      OMP_DAEMON_RUNTIME_DIR: home
    },
    stdio: 'ignore'
  })
  try {
    const deadline = Date.now() + BROKER_START_TIMEOUT_MS
    while (!(await exists(socket))) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Packaged kernel could not host its broker: ${executable} ended on ${child.signalCode ?? child.exitCode}.`
        )
      }
      if (Date.now() > deadline) throw new Error(`Packaged kernel opened no broker: ${executable}.`)
      await setTimeout(100)
    }
  } finally {
    child.kill('SIGKILL')
    await rm(home, { recursive: true, force: true })
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
  await assertHostsBroker(join(resolve(resources), 'kernel', phiVersion, targets[0], 'phi-kernel'))
  process.stdout.write(`Packaged kernels verified: ${targets.join(', ')}\n`)
}

if (import.meta.main) await main()
