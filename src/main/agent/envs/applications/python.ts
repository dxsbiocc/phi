import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  cacheVerifiedArtifact,
  installationSpecSha256,
  readVerifiedInstallationAsset,
  throwIfAborted
} from './artifacts'
import type {
  ApplicationInstallInput,
  ApplicationInstallResult,
  PythonUvInstallation
} from './types'

const MAX_OUTPUT_BYTES = 1024 * 1024
const PROCESS_TIMEOUT_MS = 5 * 60 * 1000
const HASH_OPTION = /\s+--hash(?:=|\s+)sha256:([a-f0-9]{64})(?=\s|$)/gi
const PACKAGE = '[A-Za-z0-9][A-Za-z0-9._-]*(?:\\[[A-Za-z0-9._,-]+\\])?'
const EXACT_REQUIREMENT = new RegExp(`^${PACKAGE}\\s*==\\s*([0-9][A-Za-z0-9.!+_-]*)$`)
const DIRECT_REQUIREMENT = new RegExp(`^${PACKAGE}\\s+@\\s+(\\S+)$`)
const PYTHON_PATH_PROBE =
  'import json, sys, sysconfig; print(json.dumps(dict(prefix=sys.prefix, scripts=sysconfig.get_path("scripts"), purelib=sysconfig.get_path("purelib"), platlib=sysconfig.get_path("platlib"))))'

interface PythonPaths {
  prefix: string
  scripts: string
  purelib: string
  platlib: string
}

interface InstalledPackage {
  name: string
  version: string
}

interface InstallationReceipt {
  specSha256: string
  requirementsSha256: string
  executableSha256: string
  installedSha256: string
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isContained(path: string, base: string): boolean {
  const suffix = relative(base, path)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function resolvedPath(path: string): string {
  // Python's library destinations need not have been populated yet.
  if (existsSync(path)) return realpathSync(path)
  const parent = resolve(path, '..')
  if (parent === path) return path
  return join(resolvedPath(parent), relative(parent, path))
}

function managedExecutable(prefix: string, name: string): string {
  const path = join(prefix, 'bin', name)
  let actual: string
  try {
    actual = realpathSync(path)
    if (!statSync(actual).isFile()) throw new Error('not a file')
    accessSync(actual, constants.X_OK)
  } catch {
    throw new Error(`managed ${name} executable is missing or not executable: ${path}`)
  }
  if (!isContained(actual, prefix)) {
    throw new Error(`managed ${name} executable resolves outside its prefix`)
  }
  return path
}

/** Only complete, hashed wheel locks can reach uv; installer settings are never lock entries. */
function validateRequirements(bytes: Buffer): void {
  const text = bytes.toString('utf8')
  if (text.includes('\0') || text.includes('\uFFFD')) {
    throw new Error('Python requirements must contain valid UTF-8 text')
  }
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)
  let count = 0
  for (const raw of lines) {
    const line = raw.replace(/(?:^|\s)#.*$/, '').trim()
    if (!line) continue
    const hashes = [...line.matchAll(HASH_OPTION)]
    if (hashes.length === 0) throw new Error('Python requirements must include SHA256 wheel hashes')
    const requirement = line.replace(HASH_OPTION, '').trim()
    if (requirement.includes('--') || requirement.includes('\\')) {
      throw new Error('Python requirements cannot contain installer options or source inputs')
    }
    const marker = requirement.indexOf(';')
    const pin = (marker < 0 ? requirement : requirement.slice(0, marker)).trim()
    if (marker >= 0 && !requirement.slice(marker + 1).trim()) {
      throw new Error('Python requirements contain an empty environment marker')
    }
    const exact = EXACT_REQUIREMENT.exec(pin)
    const direct = DIRECT_REQUIREMENT.exec(pin)
    if (exact) {
      // Exact PEP 440 versions cannot use pip's wildcard equality syntax.
      if (exact[1].includes('*')) throw new Error('Python requirements must be fully pinned')
    } else if (direct) {
      let url: URL
      try {
        url = new URL(direct[1])
      } catch {
        throw new Error('Python requirements must use an HTTPS wheel URL')
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !url.pathname.endsWith('.whl') ||
        (url.hash && !/^#sha256=[a-f0-9]{64}$/i.test(url.hash))
      ) {
        throw new Error('Python requirements must use an HTTPS wheel URL without credentials')
      }
    } else {
      throw new Error('Python requirements must be fully pinned versions or HTTPS wheels')
    }
    count++
  }
  if (count === 0) throw new Error('Python requirements cannot be empty')
}

function ownedDirectory(path: string, base: string): void {
  if (!isContained(path, base))
    throw new Error('Python installation state is outside its owned root')
  let current = base
  for (const part of relative(base, path).split(sep)) {
    current = join(current, part)
    try {
      mkdirSync(current, { mode: 0o700 })
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
        throw error
    }
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Python installation state must be a regular directory without symlinks')
    }
  }
}

function isolatedEnvironment(prefix: string, state: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'REQUESTS_CA_BUNDLE'
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return {
    ...env,
    PATH: join(prefix, 'bin'),
    HOME: join(state, 'home'),
    XDG_CONFIG_HOME: join(state, 'config'),
    XDG_CACHE_HOME: join(state, 'cache'),
    TMPDIR: join(state, 'tmp'),
    LANG: 'en_US.UTF-8',
    LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PIP_CONFIG_FILE: '/dev/null',
    UV_NO_CONFIG: '1',
    UV_PYTHON_DOWNLOADS: 'never',
    UV_CACHE_DIR: join(state, 'uv'),
    UV_LINK_MODE: 'copy',
    ...(env.SSL_CERT_FILE ? { UV_NATIVE_TLS: 'true' } : {})
  }
}

async function runManaged(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input: ApplicationInstallInput,
  phase: string
): Promise<string> {
  throwIfAborted(input.signal)
  const child = spawn(executable, args, {
    cwd: input.prefix,
    env,
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return await new Promise((resolveResult, reject) => {
    let stdout = ''
    let stderr = ''
    let failure: Error | undefined
    let settled = false
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const abort = (): void => {
      failure = new Error('Python application installation aborted')
      failure.name = 'AbortError'
      kill()
    }
    const timer = setTimeout(() => {
      failure = new Error(`Python application ${phase} timed out`)
      kill()
    }, PROCESS_TIMEOUT_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
    }
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (failure) return
      const text = chunk.toString('utf8')
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > MAX_OUTPUT_BYTES) {
        failure = new Error(`Python application ${phase} output exceeded its limit`)
        kill()
        return
      }
      if (stream === 'stdout') stdout += text
      else stderr += text
      try {
        if (phase === 'installing' && text.trim()) {
          input.onProgress?.({ phase, message: text.trim() })
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        kill()
      }
    }
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(failure ?? new Error(`failed to start managed Python tool: ${error.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (failure) reject(failure)
      else if (code !== 0)
        reject(new Error(`Python application ${phase} failed: ${stderr.trim() || `exit ${code}`}`))
      else resolveResult(stdout)
    })
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) abort()
  })
}

function verifyPythonPaths(output: string, prefix: string): void {
  let paths: PythonPaths
  try {
    paths = JSON.parse(output) as PythonPaths
  } catch {
    throw new Error('managed Python did not report valid installation paths')
  }
  for (const key of ['prefix', 'scripts', 'purelib', 'platlib'] as const) {
    if (
      typeof paths[key] !== 'string' ||
      !isAbsolute(paths[key]) ||
      !isContained(resolvedPath(paths[key]), prefix)
    ) {
      throw new Error('managed Python installation paths resolve outside its prefix')
    }
  }
}

function installedPackages(output: string): InstalledPackage[] {
  const packages: unknown = JSON.parse(output)
  if (
    !Array.isArray(packages) ||
    packages.some(
      (entry) => !entry || typeof entry.name !== 'string' || typeof entry.version !== 'string'
    )
  ) {
    throw new Error('managed uv did not report valid installed package versions')
  }
  return packages.map(({ name, version }) => ({ name, version }))
}

function reusableInstallation(
  prefix: string,
  state: string,
  installation: PythonUvInstallation,
  specSha256: string
): { executable: string; packages: InstalledPackage[] } | undefined {
  try {
    const receiptPath = join(state, 'receipt.json')
    const installedPath = join(state, 'installed.json')
    if (
      !lstatSync(receiptPath).isFile() ||
      lstatSync(receiptPath).isSymbolicLink() ||
      !lstatSync(installedPath).isFile() ||
      lstatSync(installedPath).isSymbolicLink()
    )
      return undefined
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as InstallationReceipt
    if (
      receipt.specSha256 !== specSha256 ||
      receipt.requirementsSha256 !== installation.requirementsSha256.toLowerCase()
    )
      return undefined
    const executable = managedExecutable(prefix, installation.executable)
    if (
      receipt.executableSha256 !== sha256(readFileSync(executable)) ||
      receipt.installedSha256 !== sha256(readFileSync(installedPath))
    )
      return undefined
    return { executable, packages: installedPackages(readFileSync(installedPath, 'utf8')) }
  } catch {
    return undefined
  }
}

/** Install only with Python and uv supplied by the locked, package-private runtime prefix. */
export async function installPythonApplication(
  input: ApplicationInstallInput
): Promise<ApplicationInstallResult> {
  if (input.installation.backend !== 'python-uv')
    throw new Error('Python installer requires a python-uv installation')
  throwIfAborted(input.signal)
  const installation = input.installation
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(installation.executable)) {
    throw new Error('Python application executable must be a plain binary name')
  }
  const requirements = readVerifiedInstallationAsset(
    input.sourceDir,
    installation.requirements,
    installation.requirementsSha256
  )
  validateRequirements(requirements)
  const prefix = realpathSync(input.prefix)
  const python = managedExecutable(prefix, 'python')
  const uv = managedExecutable(prefix, 'uv')
  const artifact = await cacheVerifiedArtifact(input.root, requirements)
  throwIfAborted(input.signal)
  const artifacts = [{ key: artifact.key, sha256: artifact.sha256, size: artifact.size }]
  const state = join(prefix, '.phi', 'python-uv')
  const specSha256 = installationSpecSha256(installation)
  for (const directory of [join(prefix, '.phi'), state]) ownedDirectory(directory, prefix)
  const cached = reusableInstallation(prefix, state, installation, specSha256)
  if (cached) {
    input.onProgress?.({ phase: 'reusing', message: 'Verified installed Python application' })
    throwIfAborted(input.signal)
    return {
      backend: 'python-uv',
      executable: cached.executable,
      specSha256,
      artifacts,
      packages: cached.packages
    }
  }
  const root = realpathSync(input.root)
  const work = join(root, 'cache', basename(prefix), 'applications')
  for (const directory of ['home', 'config', 'cache', 'tmp', 'uv'])
    ownedDirectory(join(work, directory), root)
  const env = isolatedEnvironment(prefix, work)
  const actualInput = { ...input, prefix }
  const lock = join(work, 'requirements.txt')
  rmSync(lock, { force: true })
  writeFileSync(lock, requirements, { mode: 0o600, flag: 'wx' })
  rmSync(join(state, 'receipt.json'), { force: true })
  verifyPythonPaths(
    await runManaged(python, ['-I', '-c', PYTHON_PATH_PROBE], env, actualInput, 'verifying'),
    prefix
  )
  const common = ['--no-config', '--no-python-downloads', '--color', 'never']
  const install = [
    ...common,
    'pip',
    'install',
    '--requirements',
    lock,
    '--python',
    python,
    '--require-hashes',
    '--only-binary',
    ':all:',
    '--index-url',
    'https://pypi.org/simple'
  ]
  const closure = join(work, 'closure-check')
  rmSync(closure, { recursive: true, force: true })
  ownedDirectory(closure, root)
  // An empty destination forces uv to verify hashes for the complete dependency
  // closure, including requirements already satisfied by the locked runtime.
  input.onProgress?.({ phase: 'verifying', message: 'Verifying pinned Python dependency closure' })
  await runManaged(
    uv,
    [...install, '--dry-run', '--prefix', closure],
    env,
    actualInput,
    'verifying'
  )
  input.onProgress?.({ phase: 'installing', message: 'Installing pinned Python wheels' })
  // The runtime prefix is a private conda environment. --system permits this explicit
  // interpreter as the target; PATH contains only this prefix and is never a fallback.
  await runManaged(uv, [...install, '--system'], env, actualInput, 'installing')
  await runManaged(
    uv,
    [...common, 'pip', 'check', '--python', python, '--system'],
    env,
    actualInput,
    'verifying'
  )
  const packages = installedPackages(
    await runManaged(
      uv,
      [...common, 'pip', 'list', '--format', 'json', '--python', python, '--system'],
      env,
      actualInput,
      'verifying'
    )
  )
  const executable = managedExecutable(prefix, installation.executable)
  throwIfAborted(input.signal)
  const installed = JSON.stringify(packages)
  const receipt: InstallationReceipt = {
    specSha256,
    requirementsSha256: installation.requirementsSha256.toLowerCase(),
    executableSha256: sha256(readFileSync(executable)),
    installedSha256: sha256(installed)
  }
  for (const [name, bytes] of [
    ['installed.json', installed],
    ['receipt.json', JSON.stringify(receipt)]
  ] as const) {
    const path = join(state, name)
    rmSync(path, { force: true })
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' })
  }
  return { backend: 'python-uv', executable, specSha256, artifacts, packages }
}
