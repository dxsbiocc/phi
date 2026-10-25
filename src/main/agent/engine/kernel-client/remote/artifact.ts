import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  RemoteKernelError,
  type KernelBuildManifest,
  type KernelBuildManifestFile,
  type RemoteKernelVariant
} from './types'

export interface ResolvedKernelBuild {
  readonly directory: string
  readonly manifest: KernelBuildManifest
  readonly kernel: KernelBuildManifestFile
  readonly natives: Readonly<Record<RemoteKernelVariant, KernelBuildManifestFile>>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function safeSegment(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value === '.' ||
    value === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value)
  ) {
    throw new RemoteKernelError('INVALID_MANIFEST', `Invalid kernel manifest ${label}.`)
  }
  return value
}

function parseFile(value: unknown, index: number): KernelBuildManifestFile {
  const raw = record(value)
  if (!raw) throw new RemoteKernelError('INVALID_MANIFEST', `Invalid kernel file entry ${index}.`)
  const name = safeSegment(raw.name, `files[${index}].name`)
  if (basename(name) !== name) {
    throw new RemoteKernelError('INVALID_MANIFEST', `Kernel artifact ${name} is not a basename.`)
  }
  const role = raw.role
  if (role !== 'kernel' && role !== 'native') {
    throw new RemoteKernelError('INVALID_MANIFEST', `Invalid role for kernel artifact ${name}.`)
  }
  const variant = raw.variant
  if (
    (role === 'kernel' && variant !== undefined) ||
    (role === 'native' && variant !== 'modern' && variant !== 'baseline')
  ) {
    throw new RemoteKernelError('INVALID_MANIFEST', `Invalid variant for kernel artifact ${name}.`)
  }
  if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) {
    throw new RemoteKernelError('INVALID_MANIFEST', `Invalid SHA256 for kernel artifact ${name}.`)
  }
  if (!Number.isSafeInteger(raw.size) || (raw.size as number) <= 0) {
    throw new RemoteKernelError('INVALID_MANIFEST', `Invalid size for kernel artifact ${name}.`)
  }
  return {
    name,
    role,
    ...(role === 'native' ? { variant: variant as RemoteKernelVariant } : {}),
    sha256: raw.sha256,
    size: raw.size as number
  }
}

export async function readKernelBuild(directory: string): Promise<ResolvedKernelBuild> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  } catch (error) {
    throw new RemoteKernelError(
      'INVALID_MANIFEST',
      `Cannot read the linux-x64 kernel manifest from ${directory}.`,
      { cause: error }
    )
  }
  const raw = record(parsed)
  if (!raw || raw.target !== 'linux-x64' || !Array.isArray(raw.files)) {
    throw new RemoteKernelError(
      'INVALID_MANIFEST',
      'Kernel build directory must contain a linux-x64 manifest.'
    )
  }
  const files = raw.files.map(parseFile)
  if (new Set(files.map((file) => file.name)).size !== files.length) {
    throw new RemoteKernelError(
      'INVALID_MANIFEST',
      'Kernel manifest contains duplicate file names.'
    )
  }
  const kernels = files.filter((file) => file.role === 'kernel')
  const modern = files.filter((file) => file.role === 'native' && file.variant === 'modern')
  const baseline = files.filter((file) => file.role === 'native' && file.variant === 'baseline')
  if (kernels.length !== 1 || modern.length !== 1 || baseline.length !== 1 || files.length !== 3) {
    throw new RemoteKernelError(
      'INVALID_MANIFEST',
      'linux-x64 kernel manifest must contain one kernel and modern/baseline native files.'
    )
  }
  const manifest: KernelBuildManifest = {
    phiVersion: safeSegment(raw.phiVersion, 'phiVersion'),
    ompVersion: safeSegment(raw.ompVersion, 'ompVersion'),
    nativeVersion: safeSegment(raw.nativeVersion, 'nativeVersion'),
    bunVersion: safeSegment(raw.bunVersion, 'bunVersion'),
    target: 'linux-x64',
    files
  }
  return {
    directory,
    manifest,
    kernel: kernels[0],
    natives: { modern: modern[0], baseline: baseline[0] }
  }
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(path)
    input.on('data', (chunk) => digest.update(chunk))
    input.once('error', reject)
    input.once('end', resolve)
  })
  return digest.digest('hex')
}

export async function verifyKernelBuildFile(
  build: ResolvedKernelBuild,
  file: KernelBuildManifestFile
): Promise<string> {
  const path = join(build.directory, file.name)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) {
      throw new Error(`expected ${file.size} regular-file bytes, found ${info.size}`)
    }
    const actual = await sha256(path)
    if (actual !== file.sha256) {
      throw new Error(`expected ${file.sha256}, found ${actual}`)
    }
  } catch (error) {
    throw new RemoteKernelError(
      'HASH_MISMATCH',
      `Local kernel artifact failed verification: ${file.name}.`,
      { cause: error }
    )
  }
  return path
}
