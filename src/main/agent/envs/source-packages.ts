import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { type SourcePackage } from './contract'
import { type SourcePackageInstaller } from './ensure'
import { runMicromamba } from './runtime'

const execFileAsync = promisify(execFile)

export interface SourcePackageProgress {
  phase: 'source-packages'
  message: string
}

export interface SourcePackageInstallOptions {
  root: string
  signal?: AbortSignal
  onProgress?: (event: SourcePackageProgress) => void
}

/** Writes the archive bytes to `destination`. Rejects when the download fails. */
export type SourceArchiveDownloader = (
  url: string,
  destination: string,
  signal?: AbortSignal
) => Promise<void>

export interface FetchSourceArchiveOptions {
  signal?: AbortSignal
  download?: SourceArchiveDownloader
}

class ArchiveDigestMismatch extends Error {
  constructor(name: string, expected: string, actual: string) {
    super(`source package ${name}: sha256 mismatch (expected ${expected}, actual ${actual})`)
    this.name = 'ArchiveDigestMismatch'
  }
}

export function sourceArchiveUrls(pkg: SourcePackage): string[] {
  if (pkg.source === 'github') {
    if (!pkg.repo) throw new Error(`source package ${pkg.name}: github source requires repo`)
    return [`https://codeload.github.com/${pkg.repo}/tar.gz/${pkg.ref}`]
  }
  return [
    `https://cran.r-project.org/src/contrib/${pkg.name}_${pkg.ref}.tar.gz`,
    `https://cran.r-project.org/src/contrib/Archive/${pkg.name}/${pkg.name}_${pkg.ref}.tar.gz`
  ]
}

/**
 * Return `<root>/sources/<sha256>`, downloading only when the cached file is
 * missing or its contents do not match. A digest mismatch is an error: the
 * unverified file is removed and later candidate URLs are not tried.
 */
export async function fetchSourceArchive(
  root: string,
  pkg: SourcePackage,
  options: FetchSourceArchiveOptions = {}
): Promise<string> {
  const download = options.download ?? downloadWithCurl
  const sourcesDir = join(root, 'sources')
  mkdirSync(sourcesDir, { recursive: true })
  const target = join(sourcesDir, pkg.sha256)
  if (existsSync(target) && fileSha256(target) === pkg.sha256) return target
  rmSync(target, { force: true })

  const failures: string[] = []
  for (const url of sourceArchiveUrls(pkg)) {
    throwIfAborted(options.signal)
    const temporary = join(
      sourcesDir,
      `.${pkg.sha256}.${process.pid}.${randomBytes(4).toString('hex')}.partial`
    )
    try {
      await download(url, temporary, options.signal)
      throwIfAborted(options.signal)
      if (!existsSync(temporary)) throw new Error('downloader did not write a file')
      const actual = fileSha256(temporary)
      if (actual !== pkg.sha256) throw new ArchiveDigestMismatch(pkg.name, pkg.sha256, actual)
      renameSync(temporary, target)
      return target
    } catch (error) {
      if (error instanceof ArchiveDigestMismatch) throw error
      if (options.signal?.aborted) throw new Error('environment build aborted')
      failures.push(`${url}: ${errorText(error)}`)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  throw new Error(
    `source package ${pkg.name}: failed to download source archive: ${failures.join('; ')}`
  )
}

/**
 * Install pinned R source archives in declared order.
 * `R CMD INSTALL` does not download dependencies; a missing one is an error.
 */
export async function installRSourcePackages(
  prefix: string,
  packages: SourcePackage[],
  options: SourcePackageInstallOptions
): Promise<void> {
  for (const pkg of packages) {
    const language: string = pkg.language
    if (language !== 'r') {
      throw new Error(`source package ${pkg.name}: unsupported language '${language}'`)
    }
  }
  if (packages.length === 0) return

  const library = join(prefix, 'lib', 'R', 'library')
  if (!directoryExists(library)) {
    throw new Error(`source package ${packages[0].name}: R library not found at ${library}`)
  }

  const tmpRoot = join(options.root, 'state', 'tmp')
  mkdirSync(tmpRoot, { recursive: true })

  for (const pkg of packages) {
    throwIfAborted(options.signal)
    options.onProgress?.({ phase: 'source-packages', message: `fetching ${pkg.name}` })
    const archive = await fetchSourceArchive(options.root, pkg, { signal: options.signal })
    const temp = mkdtempSync(join(tmpRoot, `${pkg.name}-`))
    try {
      await extractArchive(archive, temp, options.signal)
      const packageDir = findPackageDirectory(temp, pkg)
      const described = descriptionPackageName(join(packageDir, 'DESCRIPTION'))
      if (described !== pkg.name) {
        throw new Error(
          `source package ${pkg.name}: DESCRIPTION Package field is '${described ?? 'missing'}'`
        )
      }
      requireEnvironmentCompiler(prefix, packageDir, pkg)
      options.onProgress?.({ phase: 'source-packages', message: `installing ${pkg.name}` })
      await installPackage(prefix, library, packageDir, pkg, options)
      options.onProgress?.({ phase: 'source-packages', message: `verifying ${pkg.name}` })
      await verifyInstalledVersion(prefix, pkg, options)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }
}

export function createSourcePackageInstaller(
  options: SourcePackageInstallOptions
): SourcePackageInstaller {
  return (prefix, packages) => installRSourcePackages(prefix, packages, options)
}

// curl inherits the process environment, including proxy variables.
// `--retry` does not cover transport resets, so those are tried again.
// An HTTP 4xx fails immediately and the caller moves to the next URL.
async function downloadWithCurl(
  url: string,
  destination: string,
  signal?: AbortSignal
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    throwIfAborted(signal)
    try {
      await execFileAsync('curl', ['-fsSL', '--retry', '3', '-o', destination, url], { signal })
      return
    } catch (error) {
      if (signal?.aborted) throw new Error('environment build aborted')
      lastError = error
      rmSync(destination, { force: true })
      if (isHttpClientError(error) || attempt === 4) break
      await delay(500 * attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function isHttpClientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /requested URL returned error: 4\d\d/.test(message) || /curl: \(22\)/.test(message)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function extractArchive(
  archive: string,
  destination: string,
  signal: AbortSignal | undefined
): Promise<void> {
  throwIfAborted(signal)
  try {
    await execFileAsync('tar', ['-xzf', archive, '-C', destination], { signal })
  } catch (error) {
    if (signal?.aborted) throw new Error('environment build aborted')
    throw error
  }
}

function findPackageDirectory(extractRoot: string, pkg: SourcePackage): string {
  const candidates = readdirSync(extractRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(extractRoot, entry.name))
    .filter((dir) => existsSync(join(dir, 'DESCRIPTION')))
  if (candidates.length !== 1) {
    throw new Error(
      `source package ${pkg.name}: expected one top-level directory with DESCRIPTION, found ${candidates.length}`
    )
  }
  return candidates[0]
}

function descriptionPackageName(descriptionPath: string): string | undefined {
  const match = /^Package:\s*(\S+)/m.exec(readFileSync(descriptionPath, 'utf8'))
  return match?.[1]
}

async function installPackage(
  prefix: string,
  library: string,
  packageDir: string,
  pkg: SourcePackage,
  options: SourcePackageInstallOptions
): Promise<void> {
  const result = await runMicromamba(
    [
      'run',
      '-p',
      prefix,
      'R',
      'CMD',
      'INSTALL',
      '--no-docs',
      '--no-html',
      '--no-multiarch',
      `--library=${library}`,
      packageDir
    ],
    { root: options.root, signal: options.signal }
  )
  if (options.signal?.aborted || result.code === null) throw new Error('environment build aborted')
  const output = `${result.stdout}\n${result.stderr}`
  const missing = missingDependencies(output)
  if (missing.length > 0) {
    throw new Error(
      `source package ${pkg.name}: missing dependency ${missing.join(', ')} (declare it in the conda dependencies or earlier in sourcePackages)`
    )
  }
  if (result.code !== 0) {
    const detail = firstLine(output)
    throw new Error(
      detail
        ? `source package ${pkg.name}: R CMD INSTALL failed (${result.code}): ${detail}`
        : `source package ${pkg.name}: R CMD INSTALL failed (${result.code})`
    )
  }
}

async function verifyInstalledVersion(
  prefix: string,
  pkg: SourcePackage,
  options: SourcePackageInstallOptions
): Promise<void> {
  const result = await runMicromamba(
    ['run', '-p', prefix, 'Rscript', '-e', `cat(as.character(packageVersion("${pkg.name}")))`],
    { root: options.root, signal: options.signal }
  )
  if (options.signal?.aborted || result.code === null) throw new Error('environment build aborted')
  if (result.code !== 0) {
    const detail = firstLine(`${result.stdout}\n${result.stderr}`)
    throw new Error(
      detail
        ? `source package ${pkg.name}: failed to read installed version: ${detail}`
        : `source package ${pkg.name}: failed to read installed version`
    )
  }
  const actual = result.stdout.trim()
  if (pkg.source === 'cran' && actual !== pkg.ref) {
    throw new Error(
      `source package ${pkg.name}: installed version ${actual} does not equal ${pkg.ref}`
    )
  }
  if (!actual) throw new Error(`source package ${pkg.name}: installed version is empty`)
}

// conda-forge r-base already depends on a C toolchain (clang, cctools, ld64 on macOS), so R
// environments normally pass; the check guards environments that lack one.
// Compiler drivers conda-forge's `compilers` / `c-compiler` packages put in <prefix>/bin,
// e.g. `clang`, `arm64-apple-darwin20.0.0-clang`, `x86_64-conda-linux-gnu-cc`, `gcc`.
const ENV_COMPILER = /(^|-)(clang|gcc|cc)$/

/**
 * Native code must be built with the environment's own compilers (foundation §3.5).
 * `micromamba run` keeps /usr/bin on PATH, so without this check R would silently fall
 * back to the host toolchain (e.g. Xcode clang) and the environment would not be
 * reproducible.
 */
export function requireEnvironmentCompiler(
  prefix: string,
  packageDir: string,
  pkg: SourcePackage
): void {
  if (!directoryExists(join(packageDir, 'src'))) return
  let binaries: string[] = []
  try {
    binaries = readdirSync(join(prefix, 'bin'))
  } catch {
    // A missing bin directory means no compiler either.
  }
  if (binaries.some((name) => ENV_COMPILER.test(name))) return
  throw new Error(
    `source package ${pkg.name}: contains native code (src/) but the environment has no compiler; add conda-forge \`compilers\` to the dependencies`
  )
}

function missingDependencies(output: string): string[] {
  const names: string[] = []
  const lines = /ERROR: dependenc(?:y|ies) (.+?) (?:is|are) not available/g
  for (const match of output.matchAll(lines)) {
    const quoted = /['\u2018\u2019]([^'\u2018\u2019]+)['\u2018\u2019]/g
    for (const name of match[1].matchAll(quoted)) names.push(name[1])
  }
  return names
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function fileSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('environment build aborted')
}
