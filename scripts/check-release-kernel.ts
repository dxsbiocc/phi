#!/usr/bin/env bun

// Verifies the kernels of a finished package exactly as the app does at startup, because
// packaging steps such as signing can rewrite them after their manifest was written.

import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  verifyLocalKernelPackage,
  type LocalKernelPackageTarget
} from '../src/main/agent/engine/kernel-client/local-package'

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

/** A kernel the system refuses to run dies on a signal before it can report a usage error. */
async function assertRuns(executable: string): Promise<void> {
  const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(
    (done, reject) => {
      const child = spawn(executable, ['--phi-release-check'], { stdio: 'ignore' })
      child.once('error', reject)
      child.once('exit', (exitCode, exitSignal) => done({ code: exitCode, signal: exitSignal }))
    }
  )
  if (signal !== null || code === null) {
    throw new Error(`Packaged kernel did not run: ${executable} ended on ${signal}.`)
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
  await assertRuns(join(resolve(resources), 'kernel', phiVersion, targets[0], 'phi-kernel'))
  process.stdout.write(`Packaged kernels verified: ${targets.join(', ')}\n`)
}

if (import.meta.main) await main()
