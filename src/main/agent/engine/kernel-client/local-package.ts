import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export type LocalKernelPackageTarget = 'darwin-arm64' | 'linux-x64' | 'win32-x64'

export function localKernelBuildTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): LocalKernelPackageTarget {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  throw new Error(`The kernel engine has no local build target for ${platform}/${arch}.`)
}

export function localKernelExecutableName(target: LocalKernelPackageTarget): string {
  return target === 'win32-x64' ? 'phi-kernel.exe' : 'phi-kernel'
}

export interface LocalKernelPackageFile {
  readonly name: string
  readonly role: 'kernel' | 'native'
  readonly variant?: 'modern' | 'baseline'
  readonly sha256: string
  readonly size: number
}

export interface LocalKernelPackageManifest {
  readonly phiVersion: string
  readonly ompVersion: string
  readonly nativeVersion: string
  readonly bunVersion: string
  readonly target: LocalKernelPackageTarget
  readonly files: readonly LocalKernelPackageFile[]
}

export interface VerifiedLocalKernelPackage {
  readonly directory: string
  readonly executable: string
  readonly manifestPath: string
  readonly manifest: LocalKernelPackageManifest
}

export class LocalKernelPackageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalKernelPackageError'
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function segment(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value === '.' ||
    value === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)
  ) {
    throw new LocalKernelPackageError(`Invalid packaged kernel ${label}.`)
  }
  return value
}

function manifestFile(value: unknown, index: number): LocalKernelPackageFile {
  const raw = record(value)
  if (!raw) throw new LocalKernelPackageError(`Invalid packaged kernel file entry ${index}.`)
  const name = segment(raw.name, `files[${index}].name`)
  if (basename(name) !== name) {
    throw new LocalKernelPackageError(`Packaged kernel artifact ${name} is not a basename.`)
  }
  if (raw.role !== 'kernel' && raw.role !== 'native') {
    throw new LocalKernelPackageError(`Invalid packaged kernel role for ${name}.`)
  }
  if (raw.variant !== undefined && raw.variant !== 'modern' && raw.variant !== 'baseline') {
    throw new LocalKernelPackageError(`Invalid packaged kernel variant for ${name}.`)
  }
  if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sha256)) {
    throw new LocalKernelPackageError(`Invalid packaged kernel SHA256 for ${name}.`)
  }
  if (!Number.isSafeInteger(raw.size) || Number(raw.size) <= 0) {
    throw new LocalKernelPackageError(`Invalid packaged kernel size for ${name}.`)
  }
  return {
    name,
    role: raw.role,
    ...(raw.variant ? { variant: raw.variant } : {}),
    sha256: raw.sha256,
    size: Number(raw.size)
  }
}

function validateFiles(
  target: LocalKernelPackageTarget,
  files: readonly LocalKernelPackageFile[]
): LocalKernelPackageFile {
  if (new Set(files.map((file) => file.name)).size !== files.length) {
    throw new LocalKernelPackageError('Packaged kernel manifest contains duplicate file names.')
  }
  const kernels = files.filter((file) => file.role === 'kernel')
  const natives = files.filter((file) => file.role === 'native')
  const executable = localKernelExecutableName(target)
  if (kernels.length !== 1 || kernels[0].name !== executable) {
    throw new LocalKernelPackageError(`Packaged kernel manifest must contain one ${executable}.`)
  }
  if (target === 'darwin-arm64' || target === 'win32-x64') {
    if (
      files.length !== 2 ||
      natives.length !== 1 ||
      (target === 'darwin-arm64' && natives[0].variant !== undefined) ||
      (target === 'win32-x64' && natives[0].variant !== 'baseline') ||
      !natives[0].name.endsWith('.node')
    ) {
      throw new LocalKernelPackageError(`${target} packaged kernel must contain one native addon.`)
    }
  } else {
    const variants = natives.map((file) => file.variant).sort()
    if (
      files.length !== 3 ||
      natives.some((file) => !file.name.endsWith('.node')) ||
      variants[0] !== 'baseline' ||
      variants[1] !== 'modern'
    ) {
      throw new LocalKernelPackageError(
        'linux-x64 packaged kernel must contain modern and baseline native addons.'
      )
    }
  }
  return kernels[0]
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

async function verifyFile(directory: string, file: LocalKernelPackageFile): Promise<string> {
  const path = join(directory, file.name)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) {
      throw new Error(`expected ${file.size} regular-file bytes, found ${info.size}`)
    }
    if (
      file.role === 'kernel' &&
      process.platform !== 'win32' &&
      !file.name.endsWith('.exe') &&
      (info.mode & 0o111) === 0
    ) {
      throw new Error('kernel executable has no execute bit')
    }
    const actual = await sha256(path)
    if (actual !== file.sha256) throw new Error(`expected ${file.sha256}, found ${actual}`)
  } catch (error) {
    throw new LocalKernelPackageError(
      `Packaged kernel artifact failed verification: ${file.name}.`,
      { cause: error instanceof Error ? error : undefined }
    )
  }
  return path
}

export async function verifyLocalKernelPackage(options: {
  readonly directory: string
  readonly target: LocalKernelPackageTarget
  readonly phiVersion: string
}): Promise<VerifiedLocalKernelPackage> {
  const manifestPath = join(options.directory, 'manifest.json')
  let parsed: unknown
  try {
    const info = await lstat(manifestPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('manifest is not a regular file')
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new LocalKernelPackageError(
      `Cannot read the packaged ${options.target} kernel manifest from ${options.directory}.`,
      { cause: error instanceof Error ? error : undefined }
    )
  }
  const raw = record(parsed)
  if (!raw || raw.target !== options.target || !Array.isArray(raw.files)) {
    throw new LocalKernelPackageError(
      `Packaged kernel target mismatch: expected ${options.target}.`
    )
  }
  if (raw.phiVersion !== options.phiVersion) {
    throw new LocalKernelPackageError(
      `Packaged kernel version mismatch: expected Phi ${options.phiVersion}, found ${String(raw.phiVersion)}.`
    )
  }
  const manifest: LocalKernelPackageManifest = {
    phiVersion: segment(raw.phiVersion, 'phiVersion'),
    ompVersion: segment(raw.ompVersion, 'ompVersion'),
    nativeVersion: segment(raw.nativeVersion, 'nativeVersion'),
    bunVersion: segment(raw.bunVersion, 'bunVersion'),
    target: options.target,
    files: raw.files.map(manifestFile)
  }
  const kernel = validateFiles(options.target, manifest.files)
  const paths = await Promise.all(manifest.files.map((file) => verifyFile(options.directory, file)))
  return {
    directory: options.directory,
    manifestPath,
    manifest,
    executable: paths[manifest.files.indexOf(kernel)]
  }
}
