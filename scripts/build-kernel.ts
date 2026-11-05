#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  containsLegacyVersionSentinel,
  containsVersionStamp,
  VERSION_STAMP_MAGIC
} from '../node_modules/@oh-my-pi/pi-natives/native/version-sentinel.js'
import { createPhiLegacyPiVirtualModulePlugin } from './build/kernel-legacy-pi-virtual-module'

export type KernelBuildTarget = 'darwin-arm64' | 'linux-x64' | 'win32-x64'
export type KernelBuildSelection = KernelBuildTarget | 'all'

type TargetDefinition = {
  id: KernelBuildTarget
  platform: 'darwin' | 'linux' | 'win32'
  arch: 'arm64' | 'x64'
  bunTarget: Bun.Build.CompileTarget
  packageName: string
  nativeFiles: ReadonlyArray<{ name: string; variant?: 'modern' | 'baseline' }>
  download?: { tarball: string; integrity: string; folder: string }
  executableName: string
}

type FileManifest = {
  name: string
  role: 'kernel' | 'native'
  variant?: 'modern' | 'baseline'
  sha256: string
  size: number
}

export type KernelTargetManifest = {
  phiVersion: string
  ompVersion: string
  nativeVersion: string
  bunVersion: string
  target: KernelBuildTarget
  files: FileManifest[]
}

type TopLevelManifest = {
  phiVersion: string
  ompVersion: string
  nativeVersion: string
  bunVersion: string
  builtAt: string
  buildDurationMs: number
  targets: Array<{ target: KernelBuildTarget; manifest: string }>
}

type PackageManifest = {
  name?: unknown
  version?: unknown
  os?: unknown
  cpu?: unknown
}

const repoRoot = resolve(import.meta.dir, '..')
const DEFAULT_BUILD_ROOT = join(repoRoot, '.phi-build', 'kernel')
const PHI_PACKAGE = join(repoRoot, 'package.json')
const OMP_PACKAGE = join(repoRoot, 'node_modules', '@oh-my-pi', 'pi-coding-agent', 'package.json')
const NATIVE_PACKAGE = join(repoRoot, 'node_modules', '@oh-my-pi', 'pi-natives', 'package.json')

const NATIVE_VERSION = '18.10.3'
const CROSS_BUILD_CHILD_ENV = 'PHI_KERNEL_CROSS_BUILD_CHILD'

const TARGETS: Readonly<Record<KernelBuildTarget, TargetDefinition>> = {
  'darwin-arm64': {
    id: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    bunTarget: 'bun-darwin-arm64',
    packageName: '@oh-my-pi/pi-natives-darwin-arm64',
    nativeFiles: [{ name: 'pi_natives.darwin-arm64.node' }],
    executableName: 'phi-kernel'
  },
  'linux-x64': {
    id: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    bunTarget: 'bun-linux-x64-baseline',
    packageName: '@oh-my-pi/pi-natives-linux-x64',
    nativeFiles: [
      { name: 'pi_natives.linux-x64-modern.node', variant: 'modern' },
      { name: 'pi_natives.linux-x64-baseline.node', variant: 'baseline' }
    ],
    executableName: 'phi-kernel',
    download: {
      tarball:
        'https://registry.npmjs.org/@oh-my-pi/pi-natives-linux-x64/-/pi-natives-linux-x64-18.10.3.tgz',
      integrity:
        'sha512-cRoSyXfUwvMe8yBu3w2nW03GriZD+Oc31TvJmeHmCYTAAqaiP3OtGBxCKwUTWQjg7G8vw8h56ftyH62fdcPguA==',
      folder: 'pi-natives-linux-x64-18.10.3'
    }
  },
  'win32-x64': {
    id: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    bunTarget: 'bun-windows-x64-baseline',
    packageName: '@oh-my-pi/pi-natives-win32-x64',
    nativeFiles: [{ name: 'pi_natives.win32-x64-baseline.node', variant: 'baseline' }],
    executableName: 'phi-kernel.exe',
    download: {
      tarball:
        'https://registry.npmjs.org/@oh-my-pi/pi-natives-win32-x64/-/pi-natives-win32-x64-18.10.3.tgz',
      integrity:
        'sha512-CNY8oVniS0Nbr86rZMBY5RUBqo40rVBdyfnazGsuYNFqNE2XzXzwJD05g0sw+hACqm8fNc9MFWoBgNf2fLCdKg==',
      folder: 'pi-natives-win32-x64-18.10.3'
    }
  }
}

function parseSelection(argv: string[]): KernelBuildSelection {
  if (argv.length === 0) {
    return process.platform === 'win32' && process.arch === 'x64' ? 'win32-x64' : 'all'
  }
  if (argv.length === 2 && argv[0] === '--target') {
    const value = argv[1]
    if (value === 'all' || value in TARGETS) return value as KernelBuildSelection
  }
  throw new Error(
    'Usage: bun scripts/build-kernel.ts [--target darwin-arm64|linux-x64|win32-x64|all]'
  )
}

async function packageVersion(file: string, label: string): Promise<string> {
  const metadata = (await Bun.file(file).json()) as PackageManifest
  if (typeof metadata.version !== 'string' || !metadata.version) {
    throw new Error(`${label} package does not declare a version: ${file}`)
  }
  return metadata.version
}

async function fileDigest(file: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const digest = createHash(algorithm)
  await new Promise<void>((resolveDigest, reject) => {
    const input = createReadStream(file)
    input.on('data', (chunk) => digest.update(chunk))
    input.once('error', reject)
    input.once('end', resolveDigest)
  })
  return digest.digest(algorithm === 'sha512' ? 'base64' : 'hex')
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, file)
}

async function assertNativePackage(packageDir: string, target: TargetDefinition): Promise<void> {
  const manifestPath = join(packageDir, 'package.json')
  const manifest = (await Bun.file(manifestPath).json()) as PackageManifest
  if (manifest.name !== target.packageName || manifest.version !== NATIVE_VERSION) {
    throw new Error(
      `Unexpected native package ${String(manifest.name)}@${String(manifest.version)}; expected ${target.packageName}@${NATIVE_VERSION}`
    )
  }
  if (!Array.isArray(manifest.os) || !manifest.os.includes(target.platform)) {
    throw new Error(`${target.packageName} does not declare os=${target.platform}`)
  }
  if (!Array.isArray(manifest.cpu) || !manifest.cpu.includes(target.arch)) {
    throw new Error(`${target.packageName} does not declare cpu=${target.arch}`)
  }
}

async function assertNativeVersionStamp(file: string): Promise<void> {
  const bytes = await readFile(file)
  if (
    !containsVersionStamp(bytes, NATIVE_VERSION) &&
    !containsLegacyVersionSentinel(bytes, NATIVE_VERSION)
  ) {
    throw new Error(
      `${file} does not carry ${VERSION_STAMP_MAGIC}${NATIVE_VERSION} or its legacy sentinel`
    )
  }
}

async function downloadNativePackage(target: TargetDefinition, cacheRoot: string): Promise<string> {
  const download = target.download
  if (!download) {
    throw new Error(`${target.packageName} has no download metadata for a cross build`)
  }
  const vendorRoot = join(cacheRoot, 'vendor')
  const packageRoot = join(vendorRoot, download.folder)
  const packageDir = join(packageRoot, 'package')
  const manifestPath = join(packageDir, 'package.json')
  const tarballPath = join(vendorRoot, `${download.folder}.tgz`)
  await mkdir(vendorRoot, { recursive: true })

  if (!(await Bun.file(tarballPath).exists())) {
    const response = await fetch(download.tarball)
    if (!response.ok) {
      throw new Error(
        `Failed to download ${target.packageName}@${NATIVE_VERSION}: HTTP ${response.status}`
      )
    }
    await Bun.write(tarballPath, await response.arrayBuffer())
  }

  const actualIntegrity = `sha512-${await fileDigest(tarballPath, 'sha512')}`
  if (actualIntegrity !== download.integrity) {
    throw new Error(
      `Integrity mismatch for ${basename(tarballPath)}: expected ${download.integrity}, got ${actualIntegrity}`
    )
  }

  if (!(await Bun.file(manifestPath).exists())) {
    await rm(packageRoot, { recursive: true, force: true })
    await mkdir(packageRoot, { recursive: true })
    const extract = Bun.spawn(['tar', '-xzf', tarballPath, '-C', packageRoot], {
      cwd: repoRoot,
      stdout: 'inherit',
      stderr: 'inherit'
    })
    const exitCode = await extract.exited
    if (exitCode !== 0) throw new Error(`tar failed with exit code ${exitCode}`)
  }

  await assertNativePackage(packageDir, target)
  return packageDir
}

async function nativePackageDirectory(
  target: TargetDefinition,
  cacheRoot: string
): Promise<string> {
  const scopedName = target.packageName.replace('@oh-my-pi/', '')
  const installed = join(repoRoot, 'node_modules', '@oh-my-pi', scopedName)
  if (await Bun.file(join(installed, 'package.json')).exists()) {
    await assertNativePackage(installed, target)
    return installed
  }
  return downloadNativePackage(target, cacheRoot)
}

async function compileKernel(outfile: string, target: TargetDefinition): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(repoRoot, 'src', 'kernel', 'omp', 'compiled-entry.ts')],
    root: repoRoot,
    target: 'bun',
    external: [
      // fastembed is an optional, native-heavy tiny-model dependency installed into
      // OMP's managed runtime cache only when that feature is first requested.
      'fastembed',
      // onnxruntime-node is fastembed's platform-specific native runtime and must stay
      // paired with that on-demand install rather than the kernel executable.
      'onnxruntime-node'
    ],
    define: {
      'process.env.PI_COMPILED': JSON.stringify('true'),
      // Phi does not use the OMP CLI's embedded documentation or tiny-transformer worker.
      'process.env.PI_DOCS_EMBED': JSON.stringify(''),
      'process.env.PI_TINY_TRANSFORMERS_VERSION': JSON.stringify('')
    },
    plugins: [await createPhiLegacyPiVirtualModulePlugin()],
    // Intentionally omit Bun.build `files`: pi-natives' shipped embedded-addon.js
    // stays `null`, so the loader uses the version-checked sibling `.node` file.
    compile: {
      target: target.bunTarget,
      outfile,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false
    },
    throw: false
  })
  if (!result.success) {
    throw new Error(`Kernel bundle failed:\n${result.logs.map((log) => log.message).join('\n')}`)
  }
  await chmod(outfile, 0o755)
}

async function fileManifest(
  file: string,
  role: FileManifest['role'],
  variant?: FileManifest['variant']
): Promise<FileManifest> {
  return {
    name: basename(file),
    role,
    ...(variant ? { variant } : {}),
    sha256: await fileDigest(file, 'sha256'),
    size: (await stat(file)).size
  }
}

async function buildTarget(
  target: TargetDefinition,
  versionRoot: string,
  cacheRoot: string,
  versions: Pick<KernelTargetManifest, 'phiVersion' | 'ompVersion' | 'nativeVersion'>
): Promise<KernelTargetManifest> {
  const outputDirectory = join(versionRoot, target.id)
  const stagingDirectory = join(versionRoot, `.${target.id}.${process.pid}.tmp`)
  await rm(stagingDirectory, { recursive: true, force: true })
  await mkdir(stagingDirectory, { recursive: true })

  try {
    const kernelPath = join(stagingDirectory, target.executableName)
    process.stderr.write(`Building phi-kernel for ${target.id} (${target.bunTarget})\n`)
    await compileKernel(kernelPath, target)

    const nativeDir = await nativePackageDirectory(target, cacheRoot)
    const files: FileManifest[] = [await fileManifest(kernelPath, 'kernel')]
    for (const native of target.nativeFiles) {
      const source = join(nativeDir, native.name)
      if (!(await Bun.file(source).exists())) {
        throw new Error(`Native package is missing ${native.name}: ${nativeDir}`)
      }
      await assertNativeVersionStamp(source)
      const destination = join(stagingDirectory, native.name)
      await copyFile(source, destination)
      files.push(await fileManifest(destination, 'native', native.variant))
    }

    const manifest: KernelTargetManifest = {
      ...versions,
      bunVersion: Bun.version,
      target: target.id,
      files
    }
    await writeJson(join(stagingDirectory, 'manifest.json'), manifest)
    await rm(outputDirectory, { recursive: true, force: true })
    await rename(stagingDirectory, outputDirectory)
    return manifest
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true })
    throw error
  }
}

async function compatibleTargets(
  versionRoot: string,
  expected: Omit<TopLevelManifest, 'builtAt' | 'buildDurationMs' | 'targets'>
): Promise<TopLevelManifest['targets']> {
  const targets: TopLevelManifest['targets'] = []
  for (const id of Object.keys(TARGETS) as KernelBuildTarget[]) {
    const file = join(versionRoot, id, 'manifest.json')
    if (!(await Bun.file(file).exists())) continue
    const manifest = (await Bun.file(file).json()) as Partial<KernelTargetManifest>
    if (
      manifest.target !== id ||
      manifest.phiVersion !== expected.phiVersion ||
      manifest.ompVersion !== expected.ompVersion ||
      manifest.nativeVersion !== expected.nativeVersion ||
      manifest.bunVersion !== expected.bunVersion
    ) {
      continue
    }
    targets.push({ target: id, manifest: `${id}/manifest.json` })
  }
  return targets
}

export async function buildKernelPackage(options: {
  selection: KernelBuildSelection
  buildRoot?: string
}): Promise<TopLevelManifest> {
  const started = performance.now()
  const buildRoot = options.buildRoot ?? DEFAULT_BUILD_ROOT
  const phiVersion = await packageVersion(PHI_PACKAGE, 'Phi')
  const ompVersion = await packageVersion(OMP_PACKAGE, 'OMP')
  const installedNativeVersion = await packageVersion(NATIVE_PACKAGE, 'pi-natives')
  if (installedNativeVersion !== NATIVE_VERSION || ompVersion !== NATIVE_VERSION) {
    throw new Error(
      `Pinned build versions disagree: OMP=${ompVersion}, pi-natives=${installedNativeVersion}, expected=${NATIVE_VERSION}`
    )
  }

  const versionRoot = join(buildRoot, phiVersion)
  const cacheRoot = join(buildRoot, '.cache')
  await mkdir(versionRoot, { recursive: true })
  await mkdir(cacheRoot, { recursive: true })
  const selection =
    options.selection === 'all' ? Object.values(TARGETS) : [TARGETS[options.selection]]
  const versions = { phiVersion, ompVersion, nativeVersion: installedNativeVersion }
  for (const target of selection) await buildTarget(target, versionRoot, cacheRoot, versions)

  const identity = { ...versions, bunVersion: Bun.version }
  const manifest: TopLevelManifest = {
    ...identity,
    builtAt: new Date().toISOString(),
    buildDurationMs: Math.round(performance.now() - started),
    targets: await compatibleTargets(versionRoot, identity)
  }
  await writeJson(join(versionRoot, 'manifest.json'), manifest)
  return manifest
}

async function reexecWithWritableCrossBuildHome(selection: KernelBuildSelection): Promise<void> {
  if (
    selection === 'darwin-arm64' ||
    selection === 'win32-x64' ||
    process.env[CROSS_BUILD_CHILD_ENV] === '1'
  )
    return
  const buildRoot = process.env.PHI_KERNEL_BUILD_ROOT
    ? resolve(process.env.PHI_KERNEL_BUILD_ROOT)
    : DEFAULT_BUILD_ROOT
  const buildHome = join(buildRoot, '.cache', 'build-home')
  await mkdir(join(buildHome, '.bun'), { recursive: true })
  const child = Bun.spawn([process.execPath, import.meta.path, ...Bun.argv.slice(2)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: buildHome,
      BUN_INSTALL: join(buildHome, '.bun'),
      [CROSS_BUILD_CHILD_ENV]: '1'
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit'
  })
  process.exit(await child.exited)
}

async function main(): Promise<void> {
  const selection = parseSelection(Bun.argv.slice(2))
  await reexecWithWritableCrossBuildHome(selection)
  const manifest = await buildKernelPackage({
    selection,
    ...(process.env.PHI_KERNEL_BUILD_ROOT
      ? { buildRoot: resolve(process.env.PHI_KERNEL_BUILD_ROOT) }
      : {})
  })
  process.stdout.write(`${JSON.stringify(manifest)}\n`)
}

if (import.meta.main) await main()
