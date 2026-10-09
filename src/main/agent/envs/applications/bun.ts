import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'

import {
  fetchArtifact,
  installationSpecSha256,
  readTarEntries,
  readVerifiedArtifact,
  readVerifiedInstallationAsset
} from './artifacts'
import { bunCachePackagePath } from './bun-cache'
import {
  assertPackageDependencies,
  parseJavaScriptLock,
  parseJsonObject,
  validatePackageManifest,
  type LockedPackage
} from './bun-lock'
import type { ApplicationInstallInput, ApplicationInstallationMetadata } from './types'
import type { TarEntry } from '../../packages/archive'

const execFileAsync = promisify(execFile)
const BIN_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const RESERVED_BINS = new Set(['bun', 'bunx', 'node', 'npm', 'npx', 'corepack'])
const BLOCKED_PROXY = 'http://127.0.0.1:9'

function inside(directory: string, target: string): boolean {
  const path = relative(directory, target)
  return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path))
}

function present(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function ownedDirectory(root: string, path: string): void {
  if (!inside(root, path)) throw new Error('Bun application: cache escapes its owned root')
  let current = root
  for (const part of relative(root, path).split('/').filter(Boolean)) {
    current = join(current, part)
    const stat = present(current)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error('Bun application: installation directory must be owned without symlinks')
    mkdirSync(current, { recursive: true, mode: 0o700 })
  }
}

function managedRuntime(prefix: string, name: 'bun' | 'node'): string {
  const path = join(prefix, 'bin', name)
  try {
    const actual = realpathSync(path)
    if (!inside(realpathSync(prefix), actual) || !lstatSync(actual).isFile())
      throw new Error('unmanaged runtime')
    accessSync(path, constants.X_OK)
    return actual
  } catch {
    throw new Error(`Bun application: managed ${name} runtime is missing from ${path}`)
  }
}

function inspectPackage(bytes: Buffer, pkg: LockedPackage): TarEntry[] {
  const entries = readTarEntries(bytes)
  if (entries.some((entry) => entry.path !== 'package' && !entry.path.startsWith('package/')))
    throw new Error(`Bun application: ${pkg.name} tarball has members outside package/`)
  const manifestEntry = entries.find(
    (entry) => entry.path === 'package/package.json' && entry.type === 'file'
  )
  if (!manifestEntry || manifestEntry.data.length > 16 * 1024 * 1024)
    throw new Error(`Bun application: ${pkg.name} tarball has no bounded package/package.json`)
  const manifest = parseJsonObject(manifestEntry.data, `${pkg.name} package.json`)
  if (manifest.name !== pkg.name || manifest.version !== pkg.version)
    throw new Error(`Bun application: ${pkg.name} tarball name/version does not match its lock`)
  validatePackageManifest(manifest, pkg.name)
  if (
    entries.some(
      (entry) => entry.path.endsWith('.node') || /(?:^|\/)binding\.gyp$/.test(entry.path)
    )
  )
    throw new Error(`Bun application: ${pkg.name} requires unsupported native builds`)
  assertPackageDependencies(manifest, pkg)
  return entries
}

function seedPackageCache(cache: string, subpath: string, entries: TarEntry[]): void {
  const target = join(cache, subpath)
  ownedDirectory(cache, dirname(target))
  const existing = present(target)
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new Error('Bun application: package cache must be a regular owned directory')
  const temporary = join(dirname(target), `.package-${randomUUID()}.partial`)
  mkdirSync(temporary, { mode: 0o700 })
  try {
    for (const entry of entries) {
      if (entry.path === 'package') continue
      const path = join(temporary, entry.path.slice('package/'.length))
      ownedDirectory(temporary, entry.type === 'directory' ? path : dirname(path))
      if (entry.type === 'file')
        writeFileSync(path, entry.data, { flag: 'wx', mode: entry.mode & 0o777 })
    }
    // Reconstruct from verified bytes on every retry: cached package.json alone proves no integrity.
    rmSync(target, { recursive: true, force: true })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function verifyInstalledPackages(
  app: string,
  packages: LockedPackage[]
): NonNullable<ApplicationInstallationMetadata['packages']> {
  const modules = join(app, 'node_modules')
  const resolved: NonNullable<ApplicationInstallationMetadata['packages']> = []
  for (const pkg of packages) {
    const path = join(app, pkg.location, 'package.json')
    if (
      !existsSync(path) &&
      (pkg.entry.dev === true || pkg.entry.optional === true || pkg.entry.devOptional === true)
    )
      continue
    let manifest
    try {
      if (!inside(realpathSync(modules), realpathSync(path)))
        throw new Error('package escapes application')
      manifest = parseJsonObject(readFileSync(path), `${pkg.name} installed package.json`)
    } catch {
      throw new Error(`Bun application: installed package ${pkg.name} is missing or unsafe`)
    }
    if (manifest.name !== pkg.name || manifest.version !== pkg.version)
      throw new Error(
        `Bun application: installed package ${pkg.name} does not match its locked version`
      )
    if (!resolved.some((entry) => entry.name === pkg.name && entry.version === pkg.version))
      resolved.push({ name: pkg.name, version: pkg.version })
  }
  return resolved
}

function executableTarget(app: string, name: string, runtime: 'bun' | 'node'): string {
  const modules = join(app, 'node_modules')
  try {
    if (lstatSync(modules).isSymbolicLink() || !inside(realpathSync(app), realpathSync(modules)))
      throw new Error('modules escape application')
    const target = realpathSync(join(modules, '.bin', name))
    if (!inside(realpathSync(modules), target) || !lstatSync(target).isFile())
      throw new Error('entry escapes application')
    const head = readFileSync(target).subarray(0, 256).toString('utf8')
    const extension = runtime === 'bun' ? /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/ : /\.[cm]?js$/
    if (!extension.test(target) && !/^#![^\n]*\b(?:node|bun)(?:\s|$)/.test(head))
      throw new Error('entry is not supported JavaScript/TypeScript')
    return target
  } catch {
    throw new Error(
      `Bun application: installed executable ${name} is missing, unsafe, or unsupported for ${runtime}`
    )
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Bun is the sole package manager; the declared runtime chooses Bun or managed Node at launch. */
export async function installBunApplication(
  input: ApplicationInstallInput
): Promise<ApplicationInstallationMetadata> {
  if (input.installation.backend !== 'javascript-bun')
    throw new Error('Bun application: incompatible installation backend')
  const spec = input.installation
  const runtime = spec.runtime ?? 'bun'
  if (!['bun', 'node'].includes(runtime))
    throw new Error('Bun application: unsupported launch runtime')
  if (!BIN_NAME.test(spec.executable) || RESERVED_BINS.has(spec.executable))
    throw new Error('Bun application: executable cannot shadow a runtime binary')
  input.signal?.throwIfAborted()
  const manifestBytes = readVerifiedInstallationAsset(
    input.sourceDir,
    spec.manifest,
    spec.manifestSha256
  )
  const lockBytes = readVerifiedInstallationAsset(input.sourceDir, spec.lock, spec.lockSha256)
  const manifest = parseJsonObject(manifestBytes, 'package.json')
  const packages = parseJavaScriptLock(manifest, lockBytes, spec.lock)
  const bun = managedRuntime(input.prefix, 'bun')
  if (runtime === 'node') managedRuntime(input.prefix, 'node')
  const executable = join(input.prefix, 'bin', spec.executable)
  if (present(executable))
    throw new Error(
      `Bun application: executable would replace existing managed binary ${spec.executable}`
    )
  const owned = join(input.root, 'bun')
  const home = join(owned, 'home')
  const cache = join(owned, 'cache')
  const temporary = join(owned, 'tmp')
  const configHome = join(owned, 'config')
  for (const path of [home, cache, temporary, configHome]) ownedDirectory(input.root, path)
  const env: NodeJS.ProcessEnv = {
    PATH: join(input.prefix, 'bin'),
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cache,
    TMPDIR: temporary,
    BUN_INSTALL_CACHE_DIR: cache,
    BUN_CONFIG_NO_CLEAR_TERMINAL: '1',
    HTTP_PROXY: BLOCKED_PROXY,
    HTTPS_PROXY: BLOCKED_PROXY,
    http_proxy: BLOCKED_PROXY,
    https_proxy: BLOCKED_PROXY,
    NO_PROXY: '',
    no_proxy: '',
    LANG: input.platform.startsWith('darwin-') ? 'en_US.UTF-8' : 'C.UTF-8'
  }
  const options = {
    env,
    signal: input.signal,
    timeout: 5000,
    killSignal: 'SIGKILL' as const,
    maxBuffer: 4096
  }
  const bunVersion = (await execFileAsync(bun, ['--version'], options)).stdout.trim()
  // Unknown versions fail before acquisition. Only this explicitly tested cache-v1 ABI may be seeded.
  bunCachePackagePath('phi-cache-probe', '1.0.0', bunVersion)
  const artifacts: ApplicationInstallationMetadata['artifacts'] = []
  const seeded = new Map<string, string>()
  for (const pkg of packages) {
    input.signal?.throwIfAborted()
    input.onProgress?.({
      phase: 'application-fetch',
      message: `Fetching ${pkg.name}@${pkg.version}`
    })
    const artifact = await fetchArtifact(
      input.root,
      { url: pkg.url, integrity: pkg.integrity },
      { signal: input.signal, fetch: input.fetch }
    )
    const entries = inspectPackage(readVerifiedArtifact(artifact), pkg)
    const subpath = bunCachePackagePath(pkg.name, pkg.version, bunVersion)
    const previous = seeded.get(subpath)
    if (previous && previous !== artifact.sha256)
      throw new Error('Bun application: conflicting pins for one package name/version')
    if (!previous) {
      seedPackageCache(cache, subpath, entries)
      seeded.set(subpath, artifact.sha256)
    }
    if (!artifacts.some((entry) => entry.key === artifact.key))
      artifacts.push({ key: artifact.key, sha256: artifact.sha256, size: artifact.size })
  }
  const app = join(input.prefix, 'application', 'javascript')
  ownedDirectory(input.prefix, app)
  if (present(join(app, 'package.json')) || present(join(app, 'node_modules')))
    throw new Error('Bun application: installation directory is already populated')
  writeFileSync(join(app, 'package.json'), manifestBytes, { flag: 'wx' })
  writeFileSync(join(app, spec.lock.slice(2)), lockBytes, { flag: 'wx' })
  const config = join(app, 'bunfig.toml')
  writeFileSync(
    config,
    '[install]\nregistry = "https://registry.npmjs.org"\n[install.cache]\ndisable = false\n',
    { flag: 'wx' }
  )
  input.onProgress?.({
    phase: 'application-install',
    message: 'Installing verified JavaScript application with Bun'
  })
  try {
    await execFileAsync(
      bun,
      [
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--production',
        '--backend=copyfile',
        '--linker=hoisted',
        '--cache-dir',
        cache,
        `--config=${config}`
      ],
      {
        cwd: app,
        env,
        signal: input.signal,
        timeout: 300_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024
      }
    )
  } catch (error) {
    if (input.signal?.aborted) throw new Error('Bun application installation aborted')
    throw new Error(
      `Bun application: frozen install failed: ${error instanceof Error ? error.message.slice(0, 2000) : String(error)}`
    )
  }
  input.signal?.throwIfAborted()
  input.onProgress?.({ phase: 'application-verify', message: `Verifying ${spec.executable}` })
  const target = executableTarget(app, spec.executable, runtime)
  const resolvedPackages = verifyInstalledPackages(app, packages)
  const relativeTarget = relative(join(input.prefix, 'bin'), target)
  writeFileSync(
    executable,
    `#!/bin/sh\nset -eu\nbin=$(CDPATH= cd -- "\${0%/*}" && pwd)\nexec "$bin/${runtime}" ${runtime === 'bun' ? '--no-install ' : ''}"$bin/"${shellQuote(relativeTarget)} "$@"\n`,
    { flag: 'wx', mode: 0o755 }
  )
  return {
    backend: 'javascript-bun',
    executable,
    specSha256: installationSpecSha256(spec),
    artifacts,
    packages: resolvedPackages,
    installer: { name: 'bun', version: bunVersion }
  }
}
