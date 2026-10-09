import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { valid } from 'semver'

import { PHI_PLATFORMS } from '../platform'
import {
  assertArtifactUrl,
  fetchArtifact,
  MAX_ARTIFACT_BYTES,
  readVerifiedArtifact,
  readVerifiedInstallationAsset,
  safeApplicationRelativePath,
  throwIfAborted
} from './artifacts'
import { nativeArtifactBinary } from './native'
import type {
  ApplicationInstallInput,
  ApplicationInstallationMetadata,
  NativeApplicationArtifact,
  PinnedRuntimeTool
} from './types'

const execFileAsync = promisify(execFile)
type RuntimeToolName = 'bun' | 'node'
type ArtifactReferences = ApplicationInstallationMetadata['artifacts']

interface DeclaredTool {
  name: RuntimeToolName
  spec: PinnedRuntimeTool
  artifact: NativeApplicationArtifact
}

/** Only declared, pinned tools may populate the managed Bun/Node entries. */
export function installDeclaredApplicationTools(
  input: ApplicationInstallInput
): Promise<ArtifactReferences> {
  return declaredApplicationTools(input)
}

/** Ready-prefix reuse checks signed inputs, pinned runtime bytes, and versions without prefix writes. */
export function validateDeclaredApplicationTools(
  input: ApplicationInstallInput
): ArtifactReferences {
  const refs: ArtifactReferences = []
  for (const tool of declarations(input)) {
    privateDirectory(input.root, false)
    privateDirectory(join(input.root, 'artifacts'), false)
    const target = join(input.prefix, 'bin', tool.name)
    assertToolLocation(input.prefix, target, false)
    const key = `sha256-${tool.artifact.sha256.toLowerCase()}`
    const artifact = {
      path: join(input.root, 'artifacts', key),
      key,
      sha256: tool.artifact.sha256.toLowerCase(),
      size: tool.artifact.size
    }
    const binary = nativeArtifactBinary(tool.artifact, readVerifiedArtifact(artifact), {
      allowUnselectedLinks: true
    })
    if (!matchesBinary(target, binary))
      throw new Error(`managed ${tool.name} runtime does not match its declared artifact`)
    refs.push({ key, sha256: artifact.sha256, size: artifact.size })
  }
  return [...new Map(refs.map((artifact) => [artifact.key, artifact])).values()]
}

function declarations(input: ApplicationInstallInput): DeclaredTool[] {
  const installation = input.installation
  if (installation.backend !== 'javascript-bun') return []
  throwIfAborted(input.signal)
  readVerifiedInstallationAsset(input.sourceDir, installation.manifest, installation.manifestSha256)
  readVerifiedInstallationAsset(input.sourceDir, installation.lock, installation.lockSha256)
  if (!PHI_PLATFORMS.includes(input.platform))
    throw new Error(`unsupported application runtime platform ${input.platform}`)
  if (installation.node && installation.runtime !== 'node')
    throw new Error('declared Node runtime requires runtime: node')
  const tools: DeclaredTool[] = []
  for (const name of ['bun', 'node'] as const) {
    const spec = installation[name]
    if (!spec) continue
    if (valid(spec.version) !== spec.version)
      throw new Error(`application ${name} runtime requires an exact version`)
    const artifact = spec.artifacts[input.platform]
    if (!artifact)
      throw new Error(`application ${name} runtime has no artifact for platform ${input.platform}`)
    assertArtifactUrl(artifact.url)
    if (
      !/^[a-f0-9]{64}$/i.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 1 ||
      artifact.size > MAX_ARTIFACT_BYTES
    )
      throw new Error(`application ${name} runtime has an invalid artifact pin`)
    if (artifact.format !== 'file') {
      if (!['tar.gz', 'zip'].includes(artifact.format))
        throw new Error(`application ${name} runtime has an unsupported archive format`)
      safeApplicationRelativePath(artifact.member)
    }
    tools.push({ name, spec, artifact })
  }
  return tools
}

async function declaredApplicationTools(
  input: ApplicationInstallInput
): Promise<ArtifactReferences> {
  const tools = declarations(input)
  const refs: ArtifactReferences = []
  for (const tool of tools) {
    throwIfAborted(input.signal)
    const target = join(input.prefix, 'bin', tool.name)
    assertToolLocation(input.prefix, target, true)
    input.onProgress?.({
      phase: 'application-runtime',
      message: `Verifying managed ${tool.name} ${tool.spec.version}`
    })
    const artifact = await fetchArtifact(input.root, tool.artifact, {
      signal: input.signal,
      fetch: input.fetch
    })
    const binary = nativeArtifactBinary(tool.artifact, readVerifiedArtifact(artifact), {
      allowUnselectedLinks: true
    })
    throwIfAborted(input.signal)
    if (matchesBinary(target, binary)) {
      await verifyToolVersion(target, tool, input)
    } else {
      const temporary = join(input.prefix, 'bin', `.${tool.name}.${randomUUID()}.partial`)
      try {
        writeFileSync(temporary, binary, { flag: 'wx', mode: 0o700 })
        chmodSync(temporary, 0o700)
        await verifyToolVersion(temporary, tool, input)
        throwIfAborted(input.signal)
        assertToolLocation(input.prefix, target, false)
        renameSync(temporary, target)
      } finally {
        rmSync(temporary, { force: true })
      }
    }
    refs.push({ key: artifact.key, sha256: artifact.sha256, size: artifact.size })
  }
  return [...new Map(refs.map((artifact) => [artifact.key, artifact])).values()]
}

function present(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}

function privateDirectory(path: string, create: boolean): void {
  const existing = present(path)
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new Error('application runtime directory must not contain symlinks')
  if (!existing) {
    if (!create) throw new Error('managed application runtime directory is missing')
    mkdirSync(path, { mode: 0o700 })
  }
}

function assertToolLocation(prefix: string, target: string, create: boolean): void {
  privateDirectory(prefix, create)
  privateDirectory(join(prefix, 'bin'), create)
  const existing = present(target)
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error('declared application runtime must be a regular prefix file without symlinks')
}

function matchesBinary(path: string, binary: Buffer): boolean {
  const stat = present(path)
  if (!stat || stat.size !== binary.length || !(stat.mode & 0o111)) return false
  try {
    readVerifiedArtifact({
      path,
      key: '',
      size: binary.length,
      sha256: createHash('sha256').update(binary).digest('hex')
    })
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'application artifact changed after verification'
    )
      return false
    throw error
  }
}

async function verifyToolVersion(
  path: string,
  tool: DeclaredTool,
  input: ApplicationInstallInput
): Promise<void> {
  const owned = join(input.root, 'tools')
  privateDirectory(input.root, false)
  privateDirectory(owned, true)
  const home = join(owned, 'home')
  const temporary = join(owned, 'tmp')
  for (const directory of [home, temporary]) privateDirectory(directory, true)
  const env: NodeJS.ProcessEnv = {
    PATH: join(input.prefix, 'bin'),
    HOME: home,
    TMPDIR: temporary,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    BUN_INSTALL_CACHE_DIR: home,
    BUN_CONFIG_NO_CLEAR_TERMINAL: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '',
    no_proxy: '',
    LANG: input.platform.startsWith('darwin-') ? 'en_US.UTF-8' : 'C.UTF-8'
  }
  throwIfAborted(input.signal)
  const { stdout } = await execFileAsync(path, ['--version'], {
    cwd: owned,
    env,
    signal: input.signal,
    timeout: 5000,
    killSignal: 'SIGKILL',
    maxBuffer: 4096
  })
  throwIfAborted(input.signal)
  const actual = tool.name === 'node' ? stdout.trim().replace(/^v/, '') : stdout.trim()
  if (actual !== tool.spec.version)
    throw new Error(
      `managed ${tool.name} runtime version mismatch: expected ${tool.spec.version}, received ${actual || 'empty output'}`
    )
}
