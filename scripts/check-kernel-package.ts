#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  verifyLocalKernelPackage,
  type LocalKernelPackageTarget
} from '../src/main/agent/engine/kernel-client/local-package'
import { candidateContext, reserveEvidencePath } from './kernel-candidate'

export interface KernelPackageCheckReport {
  readonly schemaVersion: 1
  readonly ok: true
  readonly checkedAt: string
  readonly appPath: string
  readonly buildDirectory: string
  readonly packagedDirectory: string
  readonly phiVersion: string
  readonly target: LocalKernelPackageTarget
  readonly manifestSha256: string
  readonly files: ReadonlyArray<{ name: string; sha256: string; size: number }>
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256')
  await new Promise<void>((resolveDigest, reject) => {
    const input = createReadStream(path)
    input.on('data', (chunk) => digest.update(chunk))
    input.once('error', reject)
    input.once('end', resolveDigest)
  })
  return digest.digest('hex')
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function packagedResources(appPath: string): string {
  return join(appPath, 'Contents', 'Resources')
}

export async function checkPackagedKernel(options: {
  readonly appPath: string
  readonly buildDirectory: string
  readonly phiVersion: string
  readonly target: LocalKernelPackageTarget
}): Promise<KernelPackageCheckReport> {
  const appPath = resolve(options.appPath)
  const buildDirectory = resolve(options.buildDirectory)
  const packagedDirectory = join(
    packagedResources(appPath),
    'kernel',
    options.phiVersion,
    options.target
  )
  const [built, packaged] = await Promise.all([
    verifyLocalKernelPackage({
      directory: buildDirectory,
      target: options.target,
      phiVersion: options.phiVersion
    }),
    verifyLocalKernelPackage({
      directory: packagedDirectory,
      target: options.target,
      phiVersion: options.phiVersion
    })
  ])
  const expectedNames = ['manifest.json', ...built.manifest.files.map((file) => file.name)].sort()
  const packagedEntries = await readdir(packagedDirectory, { withFileTypes: true })
  const actualNames = packagedEntries.map((entry) => entry.name).sort()
  if (
    packagedEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
  ) {
    throw new Error(
      `Packaged kernel file set mismatch: expected ${expectedNames.join(', ')}, found ${actualNames.join(', ')}.`
    )
  }
  const [builtManifestSha256, packagedManifestSha256] = await Promise.all([
    sha256(built.manifestPath),
    sha256(packaged.manifestPath)
  ])
  if (builtManifestSha256 !== packagedManifestSha256) {
    throw new Error(
      `Packaged kernel manifest mismatch: expected ${builtManifestSha256}, found ${packagedManifestSha256}.`
    )
  }
  if (JSON.stringify(packaged.manifest.files) !== JSON.stringify(built.manifest.files)) {
    throw new Error('Packaged kernel artifacts do not match the candidate build manifest.')
  }
  return {
    schemaVersion: 1,
    ok: true,
    checkedAt: new Date().toISOString(),
    appPath,
    buildDirectory,
    packagedDirectory,
    phiVersion: options.phiVersion,
    target: options.target,
    manifestSha256: packagedManifestSha256,
    files: [
      {
        name: 'manifest.json',
        sha256: packagedManifestSha256,
        size: (await stat(packaged.manifestPath)).size
      },
      ...packaged.manifest.files.map((file) => ({
        name: file.name,
        sha256: file.sha256,
        size: file.size
      }))
    ]
  }
}

function parseArgs(argv: string[]): {
  appPath: string
  buildDirectory?: string
  candidateId?: string
  evidenceRoot?: string
} {
  const result: {
    appPath: string
    buildDirectory?: string
    candidateId?: string
    evidenceRoot?: string
  } = { appPath: 'dist/mac-arm64/Phi.app' }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`)
    if (key === '--app') result.appPath = value
    else if (key === '--build-dir') result.buildDirectory = value
    else if (key === '--candidate') result.candidateId = value
    else if (key === '--evidence-root') result.evidenceRoot = value
    else throw new Error(`Unknown argument: ${key}`)
  }
  return result
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2))
  const repoRoot = resolve('.')
  const phiVersion = (
    JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
  ).version
  const context = candidateContext({
    repoRoot,
    candidateId: cli.candidateId,
    evidenceRoot: cli.evidenceRoot
  })
  await stat(join(context.directory, 'candidate.json')).catch(() => {
    throw new Error(`Candidate identity is missing: ${join(context.directory, 'candidate.json')}`)
  })
  const targets = await Promise.all([
    checkPackagedKernel({
      appPath: cli.appPath,
      buildDirectory:
        cli.buildDirectory ?? join(repoRoot, '.phi-build', 'kernel', phiVersion, 'darwin-arm64'),
      phiVersion,
      target: 'darwin-arm64'
    }),
    checkPackagedKernel({
      appPath: cli.appPath,
      buildDirectory: join(repoRoot, '.phi-build', 'kernel', phiVersion, 'linux-x64'),
      phiVersion,
      target: 'linux-x64'
    })
  ])
  const report = {
    schemaVersion: 1,
    ok: true,
    checkedAt: new Date().toISOString(),
    appPath: resolve(cli.appPath),
    targets
  } as const
  const evidence = await reserveEvidencePath(context.directory, 'package-check', 'json')
  await atomicJson(evidence.path, {
    ...report,
    candidateId: context.candidateId,
    attempt: evidence.attempt
  })
  process.stdout.write(`${JSON.stringify({ ...report, evidence: evidence.path })}\n`)
}

if (import.meta.main) await main()
